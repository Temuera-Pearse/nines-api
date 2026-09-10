import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { EvaluateEligibilityService } from '../../eligibility/application/EvaluateEligibilityService.js'
import type { EligibilityDecision } from '../../eligibility/domain/EligibilityDecision.js'
import type { PlayerRepository } from '../../players/infrastructure/PlayerRepository.js'
import { withTransaction } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import { compareCryptoAmounts, normalizeCryptoAsset, parseCryptoAmount } from '../domain/CryptoAmount.js'
import { toCryptoFundingPublicResult, type CryptoFundingActorContext, type CryptoFundingIntent, type CryptoFundingPublicResult } from '../domain/CryptoFunding.js'
import type { CryptoFundingRepository } from '../infrastructure/CryptoFundingRepository.js'
import { CryptoProviderCreationError, type CryptoFundingProvider } from '../providers/CryptoFundingProvider.js'
import type { TransitionCryptoFundingService } from './TransitionCryptoFundingService.js'

export interface CryptoAssetPolicy {
  asset: string
  decimals: number
  minimumAmount: string
  maximumAmount: string
}

export interface CreateCryptoFundingIntentInput {
  playerId: string
  asset: string
  amount: string
  idempotencyKey: string
}

function requestHash(asset: string, amount: string): string {
  return createHash('sha256').update(JSON.stringify({ asset, amount })).digest('hex')
}

function isSafeProviderResult(input: {
  provider: string
  providerReference: string
  paymentUrl: string | null
}, expectedProvider: string): boolean {
  if (input.provider !== expectedProvider || typeof input.providerReference !== 'string' ||
      !input.providerReference.trim() || input.providerReference.length > 256) return false
  if (input.paymentUrl === null) return true
  if (typeof input.paymentUrl !== 'string' || input.paymentUrl.length > 2048) return false
  try {
    const url = new URL(input.paymentUrl)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

export class CreateCryptoFundingIntentService {
  constructor(
    private readonly pool: Pool,
    private readonly players: PlayerRepository,
    private readonly repository: CryptoFundingRepository,
    private readonly transitions: TransitionCryptoFundingService,
    private readonly audit: AuditRepository,
    private readonly eligibility: EvaluateEligibilityService,
    private readonly provider: CryptoFundingProvider | null,
    private readonly enabled: boolean,
    private readonly assetPolicies: readonly CryptoAssetPolicy[],
    private readonly intentTtlMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: CreateCryptoFundingIntentInput, actor: CryptoFundingActorContext): Promise<CryptoFundingPublicResult> {
    if (!this.enabled || !this.provider) throw new AppError({ status: 503, code: 'CRYPTO_FUNDING_DISABLED', message: 'Crypto funding is disabled', publicMessage: 'Crypto funding is currently unavailable' })
    const player = await this.players.findById(input.playerId, this.pool)
    if (!player) throw new AppError({ status: 404, code: 'PLAYER_NOT_FOUND', message: 'Player was not found' })
    const decision = await this.eligibility.execute(
      { player, operation: 'deposit' },
      { ...actor, purpose: 'authorization' },
    )
    if (!decision.allowed) throw new AppError({
      status: 403, code: 'CRYPTO_FUNDING_NOT_PERMITTED', message: 'Crypto funding is not permitted',
      publicMessage: 'Crypto funding is not permitted',
      publicDetails: { decisionId: decision.decisionId, reasonCodes: decision.reasonCodes },
    })
    let asset: string
    try { asset = normalizeCryptoAsset(input.asset) }
    catch { throw new AppError({ status: 400, code: 'CRYPTO_ASSET_UNSUPPORTED', message: 'Crypto asset is unsupported' }) }
    const policy = this.assetPolicies.find((candidate) => candidate.asset === asset)
    if (!policy) throw new AppError({ status: 400, code: 'CRYPTO_ASSET_UNSUPPORTED', message: 'Crypto asset is unsupported' })
    let parsed
    try { parsed = parseCryptoAmount(input.amount, policy.decimals) }
    catch { throw new AppError({ status: 400, code: 'CRYPTO_AMOUNT_INVALID', message: 'Crypto amount is invalid' }) }
    const minimum = parseCryptoAmount(policy.minimumAmount, policy.decimals)
    const maximum = parseCryptoAmount(policy.maximumAmount, policy.decimals)
    if (compareCryptoAmounts(parsed, minimum) < 0) throw new AppError({ status: 400, code: 'CRYPTO_AMOUNT_BELOW_MINIMUM', message: 'Crypto amount is below the minimum' })
    if (compareCryptoAmounts(parsed, maximum) > 0) throw new AppError({ status: 400, code: 'CRYPTO_AMOUNT_ABOVE_MAXIMUM', message: 'Crypto amount is above the maximum' })
    const hash = requestHash(asset, parsed.canonical)
    const intent = await this.prepare(input.playerId, input.idempotencyKey, asset, parsed.canonical, hash, decision, actor)
    if (intent.requestHash !== hash) throw new AppError({ status: 409, code: 'CRYPTO_IDEMPOTENCY_CONFLICT', message: 'Idempotency key was used for different crypto funding parameters' })
    if (intent.status === 'creation_failed') throw this.creationFailure()
    if (intent.status !== 'provider_pending') return toCryptoFundingPublicResult(intent)

    let providerResult
    try {
      providerResult = await this.provider.createFundingSession({
        fundingIntentId: intent.id, playerId: intent.playerId, asset: intent.asset,
        amount: intent.requestedAmount, idempotencyKey: intent.id, correlationId: actor.correlationId,
      })
      if (!isSafeProviderResult(providerResult, this.provider.providerName)) {
        throw new CryptoProviderCreationError('Provider returned an invalid funding session', false)
      }
    } catch (cause) {
      if (!(cause instanceof CryptoProviderCreationError) || cause.retryable) {
        throw new AppError({ status: 503, code: 'CRYPTO_PROVIDER_UNAVAILABLE',
          message: 'Crypto provider is unavailable', publicMessage: 'Crypto funding is temporarily unavailable', cause })
      }
      const failed = await this.markCreationFailed(intent.id, actor)
      if (failed.status !== 'creation_failed') return toCryptoFundingPublicResult(failed)
      throw this.creationFailure(cause)
    }

    return withTransaction(this.pool, async (client) => {
      const locked = await this.repository.findByIdForUpdate(intent.id, client)
      if (!locked) throw new Error('Crypto funding intent was not found')
      if (locked.providerReference && locked.providerReference !== providerResult.providerReference) {
        throw new AppError({ status: 409, code: 'CRYPTO_PROVIDER_IDENTITY_CONFLICT',
          message: 'Crypto provider returned a conflicting session reference',
          publicMessage: 'Crypto funding state cannot be changed in its current state' })
      }
      await this.repository.activateProviderSession(locked.id, providerResult.providerReference, providerResult.paymentUrl, client)
      if (locked.status !== 'provider_pending') return toCryptoFundingPublicResult({
        ...locked,
        providerReference: providerResult.providerReference,
        paymentUrl: providerResult.paymentUrl,
      })
      const activated = await this.transitions.execute(
        { intentId: locked.id, toStatus: 'awaiting_payment', trigger: 'PROVIDER_SESSION_CREATED',
          reasonCode: 'CRYPTO_PROVIDER_SESSION_CREATED', providerReference: providerResult.providerReference,
          paymentUrl: providerResult.paymentUrl },
        actor, client, { ...locked, providerReference: providerResult.providerReference, paymentUrl: providerResult.paymentUrl },
      )
      await this.audit.append({
        id: randomUUID(), actorType: actor.actorType, actorId: actor.actorId, playerId: locked.playerId,
        action: 'crypto.provider_session_created', outcome: 'success', reasonCode: 'CRYPTO_PROVIDER_SESSION_CREATED',
        correlationId: actor.correlationId, metadata: { fundingIntentId: locked.id, provider: locked.provider },
      }, client)
      return toCryptoFundingPublicResult(activated)
    })
  }

  private async prepare(playerId: string, key: string, asset: string, amount: string, hash: string,
    decision: EligibilityDecision, actor: CryptoFundingActorContext): Promise<CryptoFundingIntent> {
    const now = this.clock()
    return withTransaction(this.pool, async (client) => {
      const existing = await this.repository.findByPlayerIdempotencyKey(playerId, key, client)
      if (existing) return existing
      const intent = await this.repository.createIntent({
        id: randomUUID(), providerSessionId: randomUUID(), playerId, asset,
        requestedAmount: amount, provider: this.provider!.providerName, idempotencyKey: key,
        requestHash: hash, eligibilityDecisionId: decision.decisionId,
        eligibilityPolicyVersion: decision.policyVersion,
        eligibilityEvaluatedAt: decision.evaluatedAt,
        expiresAt: new Date(now.getTime() + this.intentTtlMs), createdAt: now,
      }, client)
      if (!intent) {
        const raced = await this.repository.findByPlayerIdempotencyKey(playerId, key, client)
        if (!raced) throw new Error('Crypto funding idempotency conflict did not resolve')
        return raced
      }
      await this.audit.append({
        id: randomUUID(), actorType: actor.actorType, actorId: actor.actorId, playerId,
        action: 'crypto.funding_requested', outcome: 'success', reasonCode: 'CRYPTO_FUNDING_REQUESTED',
        correlationId: actor.correlationId,
        metadata: { fundingIntentId: intent.id, asset: intent.asset, amount: intent.requestedAmount, provider: intent.provider },
      }, client)
      return intent
    })
  }

  private async markCreationFailed(intentId: string, actor: CryptoFundingActorContext): Promise<CryptoFundingIntent> {
    return withTransaction(this.pool, async (client) => {
      const locked = await this.repository.findByIdForUpdate(intentId, client)
      if (!locked) throw new Error('Crypto funding intent was not found')
      if (locked.status !== 'provider_pending') return locked
      await this.repository.failProviderSession(intentId, client)
      return this.transitions.execute({ intentId, toStatus: 'creation_failed', trigger: 'PROVIDER_CREATION_FAILED',
        reasonCode: 'CRYPTO_FUNDING_CREATION_FAILED', failedAt: this.clock() }, actor, client, locked)
    })
  }

  private creationFailure(cause?: unknown): AppError {
    return new AppError({ status: 503, code: 'CRYPTO_FUNDING_CREATION_FAILED', message: 'Crypto provider session creation failed', publicMessage: 'Crypto funding is temporarily unavailable', cause })
  }
}

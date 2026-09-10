import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import { withTransaction, type QueryExecutor } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import { compareCryptoAmounts, parseCryptoAmount } from '../domain/CryptoAmount.js'
import type { CryptoFundingActorContext, CryptoFundingIntent, CryptoFundingStatus } from '../domain/CryptoFunding.js'
import {
  isCryptoEventStale,
  providerStatusToFundingStatus,
  type CryptoEventProcessingStatus,
  type NormalizedCryptoProviderEvent,
  type StoredCryptoProviderEvent,
} from '../domain/CryptoProviderEvent.js'
import type { CryptoReconciliationType } from '../domain/CryptoReconciliation.js'
import {
  hashConfirmedFundingAttestation,
  type ConfirmedFundingAttestationV1,
} from '../domain/ConfirmedFundingAttestation.js'
import type { CryptoFundingRepository } from '../infrastructure/CryptoFundingRepository.js'
import { CryptoProviderInputError, type CryptoFundingProvider, type RawCryptoProviderEvent } from '../providers/CryptoFundingProvider.js'
import type { CryptoAssetPolicy } from './CreateCryptoFundingIntentService.js'
import type { TransitionCryptoFundingService } from './TransitionCryptoFundingService.js'

export interface ProcessCryptoProviderEventResult {
  eventId: string
  processingStatus: CryptoEventProcessingStatus
  fundingStatus: CryptoFundingStatus | null
  reasonCode: string | null
}

interface PostCommitError { result: ProcessCryptoProviderEventResult; error: AppError }

const RESULT_REASON = {
  detected: 'CRYPTO_PAYMENT_DETECTED',
  confirming: 'CRYPTO_PAYMENT_CONFIRMING',
  confirmed: 'CRYPTO_PAYMENT_CONFIRMED',
  failed: 'CRYPTO_PAYMENT_FAILED',
  expired: 'CRYPTO_FUNDING_INTENT_EXPIRED',
} as const

export class ProcessCryptoProviderEventService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: CryptoFundingRepository,
    private readonly transitions: TransitionCryptoFundingService,
    private readonly audit: AuditRepository,
    private readonly provider: CryptoFundingProvider,
    private readonly assetPolicies: readonly CryptoAssetPolicy[],
    private readonly maxFutureSkewMs: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly environment: 'development' | 'test' | 'production' = 'test',
    private readonly automaticProcessingWindowMs = 24 * 60 * 60_000,
  ) {}

  async execute(input: RawCryptoProviderEvent, actor: CryptoFundingActorContext): Promise<ProcessCryptoProviderEventResult> {
    let normalized: NormalizedCryptoProviderEvent
    try {
      normalized = await this.provider.parseAndVerifyEvent(input)
    } catch (cause) {
      const code = cause instanceof CryptoProviderInputError ? cause.reasonCode : 'CRYPTO_PROVIDER_EVENT_INVALID'
      await this.audit.append({
        id: randomUUID(), actorType: actor.actorType, actorId: actor.actorId, playerId: null,
        action: 'crypto.provider_event_rejected', outcome: 'rejected', reasonCode: code,
        correlationId: actor.correlationId, metadata: { provider: this.provider.providerName },
      }, this.pool)
      throw new AppError({ status: code === 'CRYPTO_PROVIDER_EVENT_UNAUTHENTICATED' ? 401 : 400,
        code, message: 'Crypto provider event was rejected', publicMessage: 'Provider event was rejected', cause })
    }

    const outcome = await withTransaction<ProcessCryptoProviderEventResult | PostCommitError>(this.pool, async (client) => {
      const receivedAt = this.clock()
      const inserted = await this.repository.insertEvent(randomUUID(), normalized, actor.correlationId, receivedAt, client)
      if (!inserted.created) {
        const conflict = inserted.event.payloadHash !== normalized.payloadHash ||
          inserted.event.providerReference !== normalized.providerReference ||
          inserted.event.eventType !== normalized.eventType
        if (conflict) {
          await this.auditEvent('crypto.provider_event_identity_conflict', 'rejected',
            'CRYPTO_PROVIDER_IDENTITY_CONFLICT', inserted.event, null, actor, client)
          return { result: { eventId: inserted.event.id, processingStatus: 'rejected', fundingStatus: null,
            reasonCode: 'CRYPTO_PROVIDER_IDENTITY_CONFLICT' },
            error: new AppError({ status: 409, code: 'CRYPTO_PROVIDER_IDENTITY_CONFLICT',
              message: 'Crypto provider event identity was reused with different content', publicMessage: 'Provider event was rejected' }) }
        }
        return { eventId: inserted.event.id, processingStatus: 'ignored_duplicate', fundingStatus: null, reasonCode: 'CRYPTO_PROVIDER_EVENT_DUPLICATE' }
      }
      await this.auditEvent('crypto.provider_event_received', 'success', null, inserted.event, null, actor, client)
      if (normalized.providerOccurredAt.getTime() > receivedAt.getTime() + this.maxFutureSkewMs) {
        return this.reject(inserted.event, null, 'CRYPTO_PROVIDER_EVENT_FUTURE_TIMESTAMP', actor, receivedAt, client)
      }
      let intent = await this.repository.findByProviderReferenceForUpdate(normalized.provider, normalized.providerReference, client)
      if (!intent && normalized.claimedFundingIntentId) {
        const pending = await this.repository.findByIdForUpdate(normalized.claimedFundingIntentId, client)
        if (pending?.provider === normalized.provider && pending.status === 'provider_pending') {
          await this.repository.activateProviderSession(
            pending.id,
            normalized.providerReference,
            null,
            client,
          )
          intent = await this.transitions.execute({
            intentId: pending.id,
            toStatus: 'awaiting_payment',
            trigger: 'PROVIDER_EVENT_BEFORE_SESSION_RESPONSE',
            reasonCode: 'CRYPTO_PROVIDER_SESSION_RECOVERED',
            providerReference: normalized.providerReference,
            paymentUrl: null,
            providerEventRecordId: inserted.event.id,
          }, actor, client, {
            ...pending,
            providerReference: normalized.providerReference,
            paymentUrl: null,
          })
        }
      }
      if (!intent) {
        await this.repository.createReconciliation({
          id: randomUUID(), fundingIntentId: null, providerEventRecordId: inserted.event.id,
          type: 'UNKNOWN_PROVIDER_REFERENCE', expectedAsset: null, actualAsset: normalized.asset,
          expectedAmount: null, actualAmount: normalized.amount, correlationId: actor.correlationId, createdAt: receivedAt,
        }, client)
        return this.reject(inserted.event, null, 'CRYPTO_PROVIDER_REFERENCE_UNKNOWN', actor, receivedAt, client)
      }
      if ((normalized.claimedFundingIntentId && normalized.claimedFundingIntentId !== intent.id) ||
          (normalized.claimedPlayerId && normalized.claimedPlayerId !== intent.playerId)) {
        return this.reject(inserted.event, intent, 'CRYPTO_PROVIDER_OWNERSHIP_MISMATCH', actor, receivedAt, client)
      }
      const externallyMoved = ['payment_detected', 'confirming', 'confirmed'].includes(normalized.status)
      if (intent.status === 'expired' || (intent.expiresAt <= receivedAt && intent.status !== 'confirmed')) {
        let expired = intent
        if (!['expired', 'failed', 'creation_failed', 'reconciliation_required'].includes(intent.status)) {
          expired = await this.transitions.execute({ intentId: intent.id, toStatus: 'expired', trigger: 'PROVIDER_EVENT_EXPIRY_GUARD',
            reasonCode: 'CRYPTO_FUNDING_INTENT_EXPIRED' }, actor, client, intent)
        }
        if (externallyMoved) await this.reconcile(expired, inserted.event.id, 'PAYMENT_AFTER_EXPIRY', normalized, actor, receivedAt, client)
        const marked = await this.repository.markEvent({ eventId: inserted.event.id, fundingIntentId: intent.id,
          status: 'ignored_expired', reasonCode: 'CRYPTO_PROVIDER_EVENT_INTENT_EXPIRED', processedAt: receivedAt, acceptedAt: null }, client)
        await this.auditEvent('crypto.provider_event_ignored_expired', 'ignored', 'CRYPTO_PROVIDER_EVENT_INTENT_EXPIRED', marked, expired, actor, client)
        return { eventId: marked.id, processingStatus: 'ignored_expired', fundingStatus: expired.status, reasonCode: 'CRYPTO_PROVIDER_EVENT_INTENT_EXPIRED' }
      }
      if (externallyMoved && (intent.status === 'failed' || intent.status === 'creation_failed')) {
        await this.reconcile(intent, inserted.event.id, 'PAYMENT_ON_TERMINAL_INTENT', normalized, actor, receivedAt, client)
        return this.reject(inserted.event, intent, 'CRYPTO_PROVIDER_EVENT_TERMINAL_INTENT', actor, receivedAt, client)
      }
      const discrepancy = externallyMoved ? this.discrepancy(intent, normalized) : null
      if (discrepancy) {
        await this.reconcile(intent, inserted.event.id, discrepancy, normalized, actor, receivedAt, client)
        let reconciled = intent
        if (!['confirmed', 'failed', 'creation_failed', 'reconciliation_required'].includes(intent.status)) {
          reconciled = await this.transitions.execute({ intentId: intent.id, toStatus: 'reconciliation_required',
            trigger: 'PROVIDER_DISCREPANCY', reasonCode: `CRYPTO_${discrepancy}`,
            providerEventRecordId: inserted.event.id, providerEventAt: normalized.providerOccurredAt }, actor, client, intent)
        }
        return this.reject(inserted.event, reconciled, discrepancy === 'ASSET_MISMATCH' ? 'CRYPTO_ASSET_MISMATCH' : 'CRYPTO_AMOUNT_MISMATCH', actor, receivedAt, client)
      }
      const targetStatus = providerStatusToFundingStatus(normalized.status)
      if (isCryptoEventStale({ providerOccurredAt: normalized.providerOccurredAt,
        fundingCreatedAt: intent.createdAt, lastProviderEventAt: intent.lastProviderEventAt,
        currentStatus: intent.status, targetStatus })) {
        const marked = await this.repository.markEvent({ eventId: inserted.event.id, fundingIntentId: intent.id,
          status: 'ignored_stale', reasonCode: 'CRYPTO_PROVIDER_EVENT_STALE', processedAt: receivedAt, acceptedAt: null }, client)
        await this.auditEvent('crypto.provider_event_stale', 'ignored', 'CRYPTO_PROVIDER_EVENT_STALE', marked, intent, actor, client)
        return { eventId: marked.id, processingStatus: 'ignored_stale', fundingStatus: intent.status, reasonCode: 'CRYPTO_PROVIDER_EVENT_STALE' }
      }
      const reasonCode = RESULT_REASON[targetStatus as keyof typeof RESULT_REASON]
      const updated = await this.transitions.execute({ intentId: intent.id, toStatus: targetStatus,
        trigger: 'PROVIDER_EVENT', reasonCode, providerEventRecordId: inserted.event.id,
        confirmedAt: targetStatus === 'confirmed' ? receivedAt : undefined,
        failedAt: targetStatus === 'failed' ? receivedAt : undefined,
        providerEventAt: normalized.providerOccurredAt }, actor, client, intent)
      if (targetStatus === 'confirmed') {
        const policy = this.assetPolicies.find((candidate) => candidate.asset === updated.asset)
        if (!policy || !updated.providerReference || !updated.eligibilityDecisionId ||
            !updated.eligibilityPolicyVersion || !updated.eligibilityEvaluatedAt) {
          throw new Error('Confirmed funding is missing attestation evidence')
        }
        const fundingAttestationId = randomUUID()
        const attestation: ConfirmedFundingAttestationV1 = {
          schemaVersion: 1,
          eventType: 'external_funding_confirmed',
          fundingAttestationId,
          issuer: 'nines-api',
          audience: 'nines-financial',
          environment: this.environment,
          playerId: updated.playerId,
          fundingIntentId: updated.id,
          provider: {
            name: updated.provider,
            paymentReference: updated.providerReference,
            confirmationEventId: normalized.providerEventId,
          },
          externalPayment: {
            asset: updated.asset,
            atomicUnits: parseCryptoAmount(updated.requestedAmount, policy.decimals).units.toString(),
            scale: policy.decimals,
          },
          confirmedAt: receivedAt.toISOString(),
          issuedAt: receivedAt.toISOString(),
          automaticProcessingUntil: new Date(
            receivedAt.getTime() + this.automaticProcessingWindowMs,
          ).toISOString(),
          purchaseEligibility: {
            decisionId: updated.eligibilityDecisionId,
            policyVersion: updated.eligibilityPolicyVersion,
            evaluatedAt: updated.eligibilityEvaluatedAt.toISOString(),
          },
          correlationId: actor.correlationId,
          causationId: inserted.event.id,
        }
        await this.repository.createFundingAttestation({ attestation,
          payloadHash: hashConfirmedFundingAttestation(attestation), intent: updated,
          confirmationEventRecordId: inserted.event.id, createdAt: receivedAt }, client)
        await this.audit.append({
          id: randomUUID(), actorType: 'SYSTEM', actorId: 'crypto_funding_outbox', playerId: intent.playerId,
          action: 'crypto.confirmed_funding_attestation_created', outcome: 'success',
          reasonCode: 'CRYPTO_PAYMENT_CONFIRMED', correlationId: actor.correlationId,
          metadata: { fundingAttestationId, fundingIntentId: intent.id, source: 'CRYPTO',
            asset: intent.asset, externalAmount: intent.requestedAmount,
            attestationPayloadHash: hashConfirmedFundingAttestation(attestation) },
        }, client)
      }
      const marked = await this.repository.markEvent({ eventId: inserted.event.id, fundingIntentId: intent.id,
        status: 'processed', reasonCode, processedAt: receivedAt, acceptedAt: receivedAt }, client)
      await this.auditEvent('crypto.provider_event_processed', 'success', reasonCode, marked, updated, actor, client)
      return { eventId: marked.id, processingStatus: 'processed', fundingStatus: updated.status, reasonCode }
    })
    if ('error' in outcome) throw outcome.error
    return outcome
  }

  private discrepancy(intent: CryptoFundingIntent, event: NormalizedCryptoProviderEvent): CryptoReconciliationType | null {
    if (!event.asset || event.asset !== intent.asset) return 'ASSET_MISMATCH'
    if (!event.amount) return 'AMOUNT_UNDETERMINED'
    const policy = this.assetPolicies.find((candidate) => candidate.asset === intent.asset)
    if (!policy) return 'ASSET_MISMATCH'
    try {
      const actual = parseCryptoAmount(event.amount, policy.decimals)
      const expected = parseCryptoAmount(intent.requestedAmount, policy.decimals)
      const comparison = compareCryptoAmounts(actual, expected)
      return comparison < 0 ? 'UNDERPAID' : comparison > 0 ? 'OVERPAID' : null
    } catch { return 'AMOUNT_UNDETERMINED' }
  }

  private async reconcile(intent: CryptoFundingIntent, eventId: string, type: CryptoReconciliationType,
    event: NormalizedCryptoProviderEvent, actor: CryptoFundingActorContext, at: Date, executor: QueryExecutor): Promise<void> {
    await this.repository.createReconciliation({ id: randomUUID(), fundingIntentId: intent.id,
      providerEventRecordId: eventId, type, expectedAsset: intent.asset, actualAsset: event.asset,
      expectedAmount: intent.requestedAmount, actualAmount: event.amount,
      correlationId: actor.correlationId, createdAt: at }, executor)
    await this.audit.append({ id: randomUUID(), actorType: actor.actorType, actorId: actor.actorId,
      playerId: intent.playerId, action: 'crypto.funding_discrepancy_detected', outcome: 'reconciliation_required',
      reasonCode: `CRYPTO_${type}`, correlationId: actor.correlationId,
      metadata: { fundingIntentId: intent.id, providerEventRecordId: eventId, discrepancyType: type,
        expectedAsset: intent.asset, actualAsset: event.asset, expectedAmount: intent.requestedAmount, actualAmount: event.amount } }, executor)
  }

  private async reject(event: StoredCryptoProviderEvent, intent: CryptoFundingIntent | null, reasonCode: string,
    actor: CryptoFundingActorContext, at: Date, executor: QueryExecutor): Promise<ProcessCryptoProviderEventResult> {
    const marked = await this.repository.markEvent({ eventId: event.id, fundingIntentId: intent?.id ?? null,
      status: 'rejected', reasonCode, processedAt: at, acceptedAt: null }, executor)
    await this.auditEvent('crypto.provider_event_rejected', 'rejected', reasonCode, marked, intent, actor, executor)
    return { eventId: marked.id, processingStatus: 'rejected', fundingStatus: intent?.status ?? null, reasonCode }
  }

  private async auditEvent(action: string, outcome: string, reasonCode: string | null,
    event: StoredCryptoProviderEvent, intent: CryptoFundingIntent | null, actor: CryptoFundingActorContext,
    executor: QueryExecutor): Promise<void> {
    await this.audit.append({ id: randomUUID(), actorType: actor.actorType, actorId: actor.actorId,
      playerId: intent?.playerId ?? null, action, outcome, reasonCode, correlationId: actor.correlationId,
      metadata: { fundingIntentId: intent?.id ?? event.fundingIntentId, providerEventRecordId: event.id,
        provider: event.provider, eventType: event.eventType } }, executor)
  }
}

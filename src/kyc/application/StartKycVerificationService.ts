import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { EvaluateEligibilityService } from '../../eligibility/application/EvaluateEligibilityService.js'
import type { PlayerRepository } from '../../players/infrastructure/PlayerRepository.js'
import { withTransaction } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import { canTransitionKycStatus } from '../domain/KycTransition.js'
import type { KycProfile } from '../domain/KycProfile.js'
import type { KycSession } from '../domain/KycSession.js'
import type { KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycSessionRepository } from '../infrastructure/KycSessionRepository.js'
import type { KycStatusTransitionRepository } from '../infrastructure/KycStatusTransitionRepository.js'
import type { KycProvider } from '../providers/KycProvider.js'
import type { KycActorContext } from './KycContext.js'
import { getOrCreateKycProfile } from './profileCreation.js'

export interface StartKycVerificationInput {
  playerId: string
  idempotencyKey: string | null
}

export interface StartKycVerificationResult {
  sessionId: string
  status: string
  provider: string
  verificationUrl: string | null
  expiresAt: Date | null
}

interface SessionIntentResult {
  session: KycSession
  needsProviderCall: boolean
}

export class StartKycVerificationService {
  constructor(
    private readonly pool: Pool,
    private readonly players: PlayerRepository,
    private readonly profiles: KycProfileRepository,
    private readonly sessions: KycSessionRepository,
    private readonly transitions: KycStatusTransitionRepository,
    private readonly audit: AuditRepository,
    private readonly eligibility: EvaluateEligibilityService,
    private readonly provider: KycProvider,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    input: StartKycVerificationInput,
    actor: KycActorContext,
  ): Promise<StartKycVerificationResult> {
    const player = await this.players.findById(input.playerId, this.pool)
    if (!player) {
      throw new AppError({ status: 404, code: 'PLAYER_NOT_FOUND', message: 'Player was not found' })
    }
    const eligibility = await this.eligibility.execute(
      { player, operation: 'start_kyc' },
      { ...actor, purpose: 'authorization' },
    )
    if (!eligibility.allowed) {
      throw new AppError({
        status: 403,
        code: 'KYC_OPERATION_NOT_ALLOWED',
        message: 'KYC start is not allowed',
        publicMessage: 'KYC verification cannot be started',
        publicDetails: {
          decisionId: eligibility.decisionId,
          reasonCodes: eligibility.reasonCodes,
        },
      })
    }

    const intent = await this.prepareIntent(input, actor)
    if (!intent.needsProviderCall) {
      await this.auditReused(intent.session, actor)
      return this.safeResult(intent.session)
    }

    let providerResult
    try {
      providerResult = await this.provider.createVerificationSession({
        playerId: input.playerId,
        internalSessionId: intent.session.id,
        correlationId: actor.correlationId,
      })
      if (
        providerResult.provider !== this.provider.providerName ||
        !providerResult.providerSessionReference.trim() ||
        providerResult.expiresAt.getTime() <= intent.session.startedAt.getTime()
      ) {
        throw new Error('Provider returned an invalid KYC session')
      }
    } catch (cause) {
      const racedSession = await this.markProviderFailure(intent.session.id, actor)
      if (racedSession?.status === 'pending') return this.safeResult(racedSession)
      throw new AppError({
        status: 503,
        code: 'KYC_SESSION_CREATION_FAILED',
        message: 'KYC provider session creation failed',
        publicMessage: 'KYC verification is temporarily unavailable',
        cause,
      })
    }

    return withTransaction(this.pool, async (client) => {
      const lockedSession = await this.sessions.findByIdForUpdate(intent.session.id, client)
      if (!lockedSession) throw new Error('KYC session intent was not found')
      if (lockedSession.status === 'pending') return this.safeResult(lockedSession)
      if (lockedSession.status !== 'creating') {
        throw new AppError({
          status: 409,
          code: 'KYC_STATE_CONFLICT',
          message: 'KYC session can no longer be activated',
        })
      }
      const profile = await this.profiles.getForUpdate(input.playerId, client)
      if (!profile) throw new Error('KYC profile was not found')
      if (!canTransitionKycStatus(profile.status, 'pending')) {
        throw new AppError({
          status: 409,
          code: 'KYC_TRANSITION_INVALID',
          message: `Cannot transition KYC from ${profile.status} to pending`,
          publicMessage: 'KYC state changed while starting verification',
        })
      }
      const session = await this.sessions.activate(
        {
          sessionId: lockedSession.id,
          providerSessionReference: providerResult.providerSessionReference,
          verificationUrl: providerResult.verificationUrl,
          expiresAt: providerResult.expiresAt,
        },
        client,
      )
      if (!session) throw new Error('KYC session activation failed')
      const updatedProfile = await this.profiles.updateStatus(
        {
          profileId: profile.id,
          expectedVersion: profile.version,
          status: 'pending',
          provider: session.provider,
          currentSessionId: session.id,
          verifiedAt: profile.verifiedAt,
          expiresAt: null,
          failureReasonCode: null,
        },
        client,
      )
      if (!updatedProfile) {
        throw new AppError({
          status: 409,
          code: 'KYC_STATE_CONFLICT',
          message: 'KYC profile version conflict',
        })
      }
      await this.appendTransition(profile, updatedProfile, session, actor, client)
      await this.audit.append(
        {
          id: randomUUID(),
          actorType: actor.actorType,
          actorId: actor.actorId,
          playerId: input.playerId,
          action: 'kyc.session_created',
          outcome: 'success',
          reasonCode: 'KYC_SESSION_STARTED',
          correlationId: actor.correlationId,
          metadata: {
            sessionId: session.id,
            provider: session.provider,
            attemptNumber: session.attemptNumber,
            expiresAt: session.expiresAt?.toISOString() ?? null,
          },
        },
        client,
      )
      return this.safeResult(session)
    })
  }

  private async prepareIntent(
    input: StartKycVerificationInput,
    actor: KycActorContext,
  ): Promise<SessionIntentResult> {
    const at = this.clock()
    return withTransaction(this.pool, async (client) => {
      await getOrCreateKycProfile(
        input.playerId,
        actor,
        this.profiles,
        this.audit,
        client,
      )
      const profile = await this.profiles.getForUpdate(input.playerId, client)
      if (!profile) throw new Error('KYC profile was not found')
      if (
        profile.status === 'verified' &&
        (profile.expiresAt === null || profile.expiresAt.getTime() > at.getTime())
      ) {
        throw new AppError({
          status: 409,
          code: 'KYC_ALREADY_VERIFIED',
          message: 'Player KYC is already verified',
        })
      }
      if (input.idempotencyKey) {
        const idempotent = await this.sessions.findByIdempotencyKey(
          input.playerId,
          input.idempotencyKey,
          client,
        )
        if (idempotent) {
          return { session: idempotent, needsProviderCall: idempotent.status === 'creating' }
        }
      }
      const effective = await this.sessions.getCurrentEffective(input.playerId, at, client)
      if (effective) {
        return { session: effective, needsProviderCall: effective.status === 'creating' }
      }
      const session = await this.sessions.createIntent(
        {
          id: randomUUID(),
          playerId: input.playerId,
          provider: this.provider.providerName,
          idempotencyKey: input.idempotencyKey,
          attemptNumber: await this.sessions.nextAttemptNumber(input.playerId, client),
          startedAt: at,
        },
        client,
      )
      if (!session) {
        const raced =
          (input.idempotencyKey
            ? await this.sessions.findByIdempotencyKey(
                input.playerId,
                input.idempotencyKey,
                client,
              )
            : null) ??
          (await this.sessions.getCurrentEffective(input.playerId, at, client))
        if (!raced) throw new Error('KYC session conflict did not resolve to a row')
        return { session: raced, needsProviderCall: raced.status === 'creating' }
      }
      await this.audit.append(
        {
          id: randomUUID(),
          actorType: actor.actorType,
          actorId: actor.actorId,
          playerId: input.playerId,
          action: 'kyc.session_requested',
          outcome: 'success',
          reasonCode: 'KYC_SESSION_STARTED',
          correlationId: actor.correlationId,
          metadata: {
            sessionId: session.id,
            provider: session.provider,
            attemptNumber: session.attemptNumber,
          },
        },
        client,
      )
      return { session, needsProviderCall: true }
    })
  }

  private async markProviderFailure(
    sessionId: string,
    actor: KycActorContext,
  ): Promise<KycSession | null> {
    return withTransaction(this.pool, async (client) => {
      const failed = await this.sessions.markCreationFailed(
        sessionId,
        this.clock(),
        client,
      )
      if (!failed) return this.sessions.findById(sessionId, client)
      await this.audit.append(
        {
          id: randomUUID(),
          actorType: actor.actorType,
          actorId: actor.actorId,
          playerId: failed.playerId,
          action: 'kyc.session_failed',
          outcome: 'failure',
          reasonCode: 'KYC_EVENT_INVALID',
          correlationId: actor.correlationId,
          metadata: { sessionId: failed.id, provider: failed.provider },
        },
        client,
      )
      return failed
    })
  }

  private async appendTransition(
    before: KycProfile,
    after: KycProfile,
    session: KycSession,
    actor: KycActorContext,
    executor: Parameters<AuditRepository['append']>[1],
  ): Promise<void> {
    await this.transitions.append(
      {
        id: randomUUID(),
        playerId: before.playerId,
        sessionId: session.id,
        fromStatus: before.status,
        toStatus: after.status,
        reasonCode: 'KYC_SESSION_STARTED',
        actorType: actor.actorType,
        actorId: actor.actorId,
        providerEventId: null,
        correlationId: actor.correlationId,
        metadata: { attemptNumber: session.attemptNumber, provider: session.provider },
      },
      executor,
    )
    await this.audit.append(
      {
        id: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        playerId: before.playerId,
        action: 'kyc.status_changed',
        outcome: 'success',
        reasonCode: 'KYC_SESSION_STARTED',
        correlationId: actor.correlationId,
        metadata: {
          sessionId: session.id,
          fromStatus: before.status,
          toStatus: after.status,
        },
      },
      executor,
    )
  }

  private async auditReused(
    session: KycSession,
    actor: KycActorContext,
  ): Promise<void> {
    await this.audit.append(
      {
        id: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        playerId: session.playerId,
        action: 'kyc.session_reused',
        outcome: 'success',
        reasonCode: 'KYC_SESSION_STARTED',
        correlationId: actor.correlationId,
        metadata: {
          sessionId: session.id,
          provider: session.provider,
          attemptNumber: session.attemptNumber,
        },
      },
      this.pool,
    )
  }

  private safeResult(session: KycSession): StartKycVerificationResult {
    return {
      sessionId: session.id,
      status: session.status === 'creating' ? 'pending' : session.status,
      provider: session.provider,
      verificationUrl: session.verificationUrl,
      expiresAt: session.expiresAt,
    }
  }
}

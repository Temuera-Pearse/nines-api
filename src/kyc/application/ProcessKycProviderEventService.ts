import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import { withTransaction, type QueryExecutor } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import {
  isStaleKycEvent,
  type KycEventProcessingStatus,
  type NormalizedKycProviderEvent,
  type StoredKycProviderEvent,
} from '../domain/KycProviderEvent.js'
import type { KycProfile } from '../domain/KycProfile.js'
import type { KycSession, KycSessionStatus } from '../domain/KycSession.js'
import type { KycStatus } from '../domain/KycStatus.js'
import { canTransitionKycStatus } from '../domain/KycTransition.js'
import type { KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycProviderEventRepository } from '../infrastructure/KycProviderEventRepository.js'
import type { KycSessionRepository } from '../infrastructure/KycSessionRepository.js'
import {
  type KycProvider,
  type KycProviderEventInput,
  KycProviderInputError,
} from '../providers/KycProvider.js'
import type { KycActorContext } from './KycContext.js'
import type { TransitionKycStatusService } from './TransitionKycStatusService.js'

export interface ProcessKycProviderEventResult {
  eventId: string
  processingStatus: KycEventProcessingStatus
  resultingKycStatus: KycStatus | null
  reasonCode: string | null
}

interface PostCommitRejectedOutcome {
  result: ProcessKycProviderEventResult
  postCommitError: AppError
}

const RESULT_REASON = {
  pending: 'KYC_SESSION_STARTED',
  verified: 'KYC_PROVIDER_VERIFIED',
  failed: 'KYC_PROVIDER_FAILED',
  manual_review: 'KYC_PROVIDER_MANUAL_REVIEW',
  expired: 'KYC_SESSION_EXPIRED',
} as const

export class ProcessKycProviderEventService {
  constructor(
    private readonly pool: Pool,
    private readonly profiles: KycProfileRepository,
    private readonly sessions: KycSessionRepository,
    private readonly events: KycProviderEventRepository,
    private readonly transitionKycStatus: TransitionKycStatusService,
    private readonly audit: AuditRepository,
    private readonly provider: KycProvider,
    private readonly verificationTtlMs: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly maxFutureSkewMs = 5 * 60_000,
  ) {}

  async execute(
    input: KycProviderEventInput,
    actor: KycActorContext,
  ): Promise<ProcessKycProviderEventResult> {
    let normalized: NormalizedKycProviderEvent
    try {
      normalized = await this.provider.verifyAndNormalizeEvent(input)
    } catch (cause) {
      const reasonCode =
        cause instanceof KycProviderInputError ? cause.reasonCode : 'KYC_EVENT_INVALID'
      await this.audit.append(
        {
          id: randomUUID(),
          actorType: actor.actorType,
          actorId: actor.actorId,
          playerId: null,
          action: 'kyc.event_rejected',
          outcome: 'rejected',
          reasonCode,
          correlationId: actor.correlationId,
          metadata: { provider: this.provider.providerName },
        },
        this.pool,
      )
      throw new AppError({
        status: 400,
        code: reasonCode,
        message: 'KYC provider event is invalid',
        publicMessage: 'KYC event was rejected',
        cause: cause instanceof KycProviderInputError ? cause : undefined,
      })
    }

    const outcome = await withTransaction<
      ProcessKycProviderEventResult | PostCommitRejectedOutcome
    >(this.pool, async (client) => {
      const receivedAt = this.clock()
      const inserted = await this.events.insert(
        randomUUID(),
        normalized,
        actor.correlationId,
        receivedAt,
        client,
      )
      if (!inserted.created) {
        if (
          inserted.event.payloadHash !== normalized.payloadHash ||
          inserted.event.providerSessionReference !== normalized.providerSessionReference ||
          inserted.event.eventType !== normalized.eventType
        ) {
          await this.appendEventAudit(
            'kyc.event_identity_conflict',
            'rejected',
            'KYC_PROVIDER_EVENT_IDENTITY_CONFLICT',
            inserted.event,
            null,
            actor,
            client,
          )
          return {
            result: {
              eventId: inserted.event.id,
              processingStatus: 'rejected' as const,
              resultingKycStatus: null,
              reasonCode: 'KYC_PROVIDER_EVENT_IDENTITY_CONFLICT',
            },
            postCommitError: new AppError({
              status: 409,
              code: 'KYC_PROVIDER_EVENT_IDENTITY_CONFLICT',
              message: 'KYC provider event identity was reused with different content',
              publicMessage: 'KYC event was rejected',
            }),
          }
        }
        const session = await this.sessions.findByProviderReferenceForUpdate(
          normalized.provider,
          normalized.providerSessionReference,
          client,
        )
        await this.appendEventAudit(
          'kyc.event_ignored_duplicate',
          'ignored',
          'KYC_EVENT_DUPLICATE',
          inserted.event,
          session?.playerId ?? null,
          actor,
          client,
        )
        return {
          eventId: inserted.event.id,
          processingStatus: 'ignored_duplicate',
          resultingKycStatus: null,
          reasonCode: 'KYC_EVENT_DUPLICATE',
        }
      }

      await this.appendEventAudit(
        'kyc.event_received',
        'success',
        null,
        inserted.event,
        null,
        actor,
        client,
      )
      if (normalized.occurredAt.getTime() > receivedAt.getTime() + this.maxFutureSkewMs) {
        return this.rejectEvent(
          inserted.event,
          'KYC_PROVIDER_EVENT_FUTURE_TIMESTAMP',
          null,
          actor,
          receivedAt,
          client,
        )
      }
      if (normalized.provider !== this.provider.providerName) {
        return this.rejectEvent(
          inserted.event,
          'KYC_PROVIDER_MISMATCH',
          null,
          actor,
          receivedAt,
          client,
        )
      }
      const session = await this.sessions.findByProviderReferenceForUpdate(
        normalized.provider,
        normalized.providerSessionReference,
        client,
      )
      if (!session) {
        return this.rejectEvent(
          inserted.event,
          'KYC_PROVIDER_SESSION_NOT_FOUND',
          null,
          actor,
          receivedAt,
          client,
        )
      }
      const profile = await this.profiles.getForUpdate(session.playerId, client)
      if (!profile) throw new Error('KYC profile was not found for provider session')
      const sessionExpired =
        session.status === 'expired' ||
        ((session.status === 'pending' || session.status === 'manual_review') &&
          session.expiresAt !== null &&
          session.expiresAt.getTime() <= receivedAt.getTime())
      if (sessionExpired) {
        const expiredSession =
          session.status === 'expired'
            ? session
            : (await this.sessions.expireIfDue(session.id, receivedAt, client)) ?? session
        let expiredProfile = profile
        if (
          profile.currentSessionId === session.id &&
          (profile.status === 'pending' || profile.status === 'manual_review')
        ) {
          expiredProfile = await this.transitionKycStatus.execute(
            {
              playerId: profile.playerId,
              toStatus: 'expired',
              trigger: 'SESSION_EXPIRY',
              reasonCode: 'KYC_SESSION_EXPIRED',
              provider: session.provider,
              sessionId: session.id,
              verifiedAt: profile.verifiedAt,
              expiresAt: session.expiresAt ?? receivedAt,
              failureReasonCode: null,
              metadata: {
                expiredAt: (session.expiresAt ?? receivedAt).toISOString(),
                source: 'provider_event_guard',
              },
            },
            actor,
            client,
          )
        }
        return this.ignoreExpired(
          inserted.event,
          expiredProfile,
          expiredSession,
          actor,
          receivedAt,
          client,
        )
      }
      if (
        normalized.claimedPlayerReference !== null &&
        normalized.claimedPlayerReference !== session.playerId
      ) {
        return this.rejectEvent(
          inserted.event,
          'KYC_PLAYER_MISMATCH',
          session.playerId,
          actor,
          receivedAt,
          client,
        )
      }
      if (
        isStaleKycEvent({
          event: normalized,
          sessionStartedAt: session.startedAt,
          sessionLastEventAt: session.lastEventAt,
          sessionIsCurrent: profile.currentSessionId === session.id,
          sessionStatus: session.status,
        })
      ) {
        return this.ignoreStale(inserted.event, profile, session, actor, receivedAt, client)
      }

      if (normalized.resultingStatus === 'pending') {
        await this.sessions.updateFromEvent(
          {
            sessionId: session.id,
            status: 'pending',
            eventAt: normalized.occurredAt,
            completedAt: null,
          },
          client,
        )
        const processed = await this.events.markProcessed(
          inserted.event.id,
          'processed',
          null,
          receivedAt,
          receivedAt,
          client,
        )
        await this.appendEventAudit(
          'kyc.event_processed',
          'success',
          null,
          processed,
          profile.playerId,
          actor,
          client,
        )
        return {
          eventId: processed.id,
          processingStatus: 'processed',
          resultingKycStatus: profile.status,
          reasonCode: null,
        }
      }

      if (!canTransitionKycStatus(profile.status, normalized.resultingStatus)) {
        return this.ignoreStale(inserted.event, profile, session, actor, receivedAt, client)
      }

      const sessionStatus = normalized.resultingStatus as KycSessionStatus
      const terminal = sessionStatus !== 'manual_review'
      const updatedSession = await this.sessions.updateFromEvent(
        {
          sessionId: session.id,
          status: sessionStatus,
          eventAt: normalized.occurredAt,
          completedAt: terminal ? receivedAt : null,
        },
        client,
      )
      if (!updatedSession) throw new Error('KYC session event update failed')

      const resultingStatus = normalized.resultingStatus
      const reasonCode = RESULT_REASON[resultingStatus]
      const updatedProfile: KycProfile = await this.transitionKycStatus.execute(
        {
          playerId: profile.playerId,
          toStatus: resultingStatus,
          trigger: 'PROVIDER_EVENT',
          reasonCode,
          reasonCodes: normalized.reasonCode ? [normalized.reasonCode] : [],
          provider: session.provider,
          sessionId: session.id,
          providerEventRecordId: inserted.event.id,
          providerEventId: normalized.providerEventId,
          verifiedAt:
            resultingStatus === 'verified' ? receivedAt : profile.verifiedAt,
          expiresAt:
            resultingStatus === 'verified'
              ? new Date(receivedAt.getTime() + this.verificationTtlMs)
              : resultingStatus === 'expired'
                ? receivedAt
                : null,
          failureReasonCode:
            resultingStatus === 'failed'
              ? 'KYC_PROVIDER_FAILED'
              : null,
          metadata: { attemptNumber: session.attemptNumber },
        },
        actor,
        client,
      )
      const processed = await this.events.markProcessed(
        inserted.event.id,
        'processed',
        reasonCode,
        receivedAt,
        receivedAt,
        client,
      )
      await this.appendEventAudit(
        'kyc.event_processed',
        'success',
        reasonCode,
        processed,
        profile.playerId,
        actor,
        client,
      )
      return {
        eventId: processed.id,
        processingStatus: 'processed',
        resultingKycStatus: updatedProfile.status,
        reasonCode,
      }
    })
    if ('postCommitError' in outcome) throw outcome.postCommitError
    return outcome
  }

  private async rejectEvent(
    event: StoredKycProviderEvent,
    reasonCode: string,
    playerId: string | null,
    actor: KycActorContext,
    processedAt: Date,
    executor: QueryExecutor,
  ): Promise<ProcessKycProviderEventResult> {
    const rejected = await this.events.markProcessed(
      event.id,
      'rejected',
      reasonCode,
      processedAt,
      null,
      executor,
    )
    await this.appendEventAudit(
      'kyc.event_rejected',
      'rejected',
      reasonCode,
      rejected,
      playerId,
      actor,
      executor,
    )
    return {
      eventId: rejected.id,
      processingStatus: rejected.processingStatus,
      resultingKycStatus: null,
      reasonCode: rejected.processingReasonCode,
    }
  }

  private async ignoreStale(
    event: StoredKycProviderEvent,
    profile: KycProfile,
    session: KycSession,
    actor: KycActorContext,
    processedAt: Date,
    executor: QueryExecutor,
  ): Promise<ProcessKycProviderEventResult> {
    const ignored = await this.events.markProcessed(
      event.id,
      'ignored_stale',
      'KYC_EVENT_STALE',
      processedAt,
      null,
      executor,
    )
    await this.appendEventAudit(
      'kyc.event_ignored_stale',
      'ignored',
      'KYC_EVENT_STALE',
      ignored,
      profile.playerId,
      actor,
      executor,
      { sessionId: session.id, currentSessionId: profile.currentSessionId },
    )
    return {
      eventId: ignored.id,
      processingStatus: 'ignored_stale',
      resultingKycStatus: profile.status,
      reasonCode: 'KYC_EVENT_STALE',
    }
  }

  private async ignoreExpired(
    event: StoredKycProviderEvent,
    profile: KycProfile,
    session: KycSession,
    actor: KycActorContext,
    processedAt: Date,
    executor: QueryExecutor,
  ): Promise<ProcessKycProviderEventResult> {
    const reasonCode = 'KYC_PROVIDER_EVENT_SESSION_EXPIRED'
    const ignored = await this.events.markProcessed(
      event.id,
      'ignored_expired',
      reasonCode,
      processedAt,
      null,
      executor,
    )
    await this.appendEventAudit(
      'kyc.event_ignored_expired_session',
      'ignored',
      reasonCode,
      ignored,
      profile.playerId,
      actor,
      executor,
      {
        sessionId: session.id,
        sessionExpiresAt: session.expiresAt?.toISOString() ?? null,
      },
    )
    return {
      eventId: ignored.id,
      processingStatus: 'ignored_expired',
      resultingKycStatus: profile.status,
      reasonCode,
    }
  }

  private async appendEventAudit(
    action: string,
    outcome: string,
    reasonCode: string | null,
    event: StoredKycProviderEvent,
    playerId: string | null,
    actor: KycActorContext,
    executor: QueryExecutor,
    extraMetadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.append(
      {
        id: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        playerId,
        action,
        outcome,
        reasonCode,
        correlationId: actor.correlationId,
        metadata: {
          providerEventRecordId: event.id,
          provider: event.provider,
          eventType: event.eventType,
          ...extraMetadata,
        },
      },
      executor,
    )
  }
}

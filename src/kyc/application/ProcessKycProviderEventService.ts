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
import type { KycReasonCode } from '../domain/KycReasonCode.js'
import type { KycProfile } from '../domain/KycProfile.js'
import type { KycSession, KycSessionStatus } from '../domain/KycSession.js'
import type { KycStatus } from '../domain/KycStatus.js'
import { canTransitionKycStatus } from '../domain/KycTransition.js'
import type { KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycProviderEventRepository } from '../infrastructure/KycProviderEventRepository.js'
import type { KycSessionRepository } from '../infrastructure/KycSessionRepository.js'
import type { KycStatusTransitionRepository } from '../infrastructure/KycStatusTransitionRepository.js'
import {
  type KycProvider,
  type KycProviderEventInput,
  KycProviderInputError,
} from '../providers/KycProvider.js'
import type { KycActorContext } from './KycContext.js'

export interface ProcessKycProviderEventResult {
  eventId: string
  processingStatus: KycEventProcessingStatus
  resultingKycStatus: KycStatus | null
  reasonCode: string | null
}

const RESULT_REASON: Record<
  Exclude<KycStatus, 'not_started'>,
  KycReasonCode
> = {
  pending: 'KYC_SESSION_STARTED',
  verified: 'KYC_PROVIDER_VERIFIED',
  failed: 'KYC_PROVIDER_FAILED',
  manual_review: 'KYC_PROVIDER_MANUAL_REVIEW',
  expired: 'KYC_SESSION_EXPIRED',
}

export class ProcessKycProviderEventService {
  constructor(
    private readonly pool: Pool,
    private readonly profiles: KycProfileRepository,
    private readonly sessions: KycSessionRepository,
    private readonly events: KycProviderEventRepository,
    private readonly transitions: KycStatusTransitionRepository,
    private readonly audit: AuditRepository,
    private readonly provider: KycProvider,
    private readonly verificationTtlMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    input: KycProviderEventInput,
    actor: KycActorContext,
  ): Promise<ProcessKycProviderEventResult> {
    let normalized: NormalizedKycProviderEvent
    try {
      normalized = await this.provider.verifyAndNormalizeEvent(input)
    } catch (cause) {
      await this.audit.append(
        {
          id: randomUUID(),
          actorType: actor.actorType,
          actorId: actor.actorId,
          playerId: null,
          action: 'kyc.event_rejected',
          outcome: 'rejected',
          reasonCode: 'KYC_EVENT_INVALID',
          correlationId: actor.correlationId,
          metadata: { provider: this.provider.providerName },
        },
        this.pool,
      )
      throw new AppError({
        status: 400,
        code: 'KYC_EVENT_INVALID',
        message: 'KYC provider event is invalid',
        publicMessage: 'KYC event was rejected',
        cause: cause instanceof KycProviderInputError ? cause : undefined,
      })
    }

    return withTransaction(this.pool, async (client) => {
      const receivedAt = this.clock()
      const inserted = await this.events.insert(
        randomUUID(),
        normalized,
        actor.correlationId,
        receivedAt,
        client,
      )
      if (!inserted.created) {
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
      const session = await this.sessions.findByProviderReferenceForUpdate(
        normalized.provider,
        normalized.providerSessionReference,
        client,
      )
      if (!session) {
        const rejected = await this.events.markProcessed(
          inserted.event.id,
          'rejected',
          'KYC_PROVIDER_REFERENCE_MISMATCH',
          this.clock(),
          client,
        )
        await this.appendEventAudit(
          'kyc.event_rejected',
          'rejected',
          'KYC_PROVIDER_REFERENCE_MISMATCH',
          rejected,
          null,
          actor,
          client,
        )
        return {
          eventId: rejected.id,
          processingStatus: rejected.processingStatus,
          resultingKycStatus: null,
          reasonCode: rejected.processingReasonCode,
        }
      }

      const profile = await this.profiles.getForUpdate(session.playerId, client)
      if (!profile) throw new Error('KYC profile was not found for provider session')
      if (
        isStaleKycEvent({
          event: normalized,
          sessionStartedAt: session.startedAt,
          sessionLastEventAt: session.lastEventAt,
          sessionIsCurrent: profile.currentSessionId === session.id,
          sessionStatus: session.status,
        })
      ) {
        return this.ignoreStale(inserted.event, profile, session, actor, client)
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
          this.clock(),
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
        return this.ignoreStale(inserted.event, profile, session, actor, client)
      }

      const sessionStatus = normalized.resultingStatus as KycSessionStatus
      const terminal = sessionStatus !== 'manual_review'
      const updatedSession = await this.sessions.updateFromEvent(
        {
          sessionId: session.id,
          status: sessionStatus,
          eventAt: normalized.occurredAt,
          completedAt: terminal ? normalized.occurredAt : null,
        },
        client,
      )
      if (!updatedSession) throw new Error('KYC session event update failed')

      const resultingStatus = normalized.resultingStatus
      const reasonCode = RESULT_REASON[resultingStatus]
      const updatedProfile = await this.profiles.updateStatus(
        {
          profileId: profile.id,
          expectedVersion: profile.version,
          status: resultingStatus,
          provider: session.provider,
          currentSessionId: session.id,
          verifiedAt:
            resultingStatus === 'verified' ? normalized.occurredAt : profile.verifiedAt,
          expiresAt:
            resultingStatus === 'verified'
              ? new Date(normalized.occurredAt.getTime() + this.verificationTtlMs)
              : resultingStatus === 'expired'
                ? normalized.occurredAt
                : null,
          failureReasonCode:
            resultingStatus === 'failed'
              ? 'KYC_PROVIDER_FAILED'
              : null,
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
      await this.transitions.append(
        {
          id: randomUUID(),
          playerId: profile.playerId,
          sessionId: session.id,
          fromStatus: profile.status,
          toStatus: updatedProfile.status,
          reasonCode,
          actorType: actor.actorType,
          actorId: actor.actorId,
          providerEventId: inserted.event.id,
          correlationId: actor.correlationId,
          metadata: {
            provider: session.provider,
            attemptNumber: session.attemptNumber,
          },
        },
        client,
      )
      await this.audit.append(
        {
          id: randomUUID(),
          actorType: actor.actorType,
          actorId: actor.actorId,
          playerId: profile.playerId,
          action: 'kyc.status_changed',
          outcome: 'success',
          reasonCode,
          correlationId: actor.correlationId,
          metadata: {
            sessionId: session.id,
            providerEventRecordId: inserted.event.id,
            fromStatus: profile.status,
            toStatus: updatedProfile.status,
          },
        },
        client,
      )
      const processed = await this.events.markProcessed(
        inserted.event.id,
        'processed',
        reasonCode,
        this.clock(),
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
  }

  private async ignoreStale(
    event: StoredKycProviderEvent,
    profile: KycProfile,
    session: KycSession,
    actor: KycActorContext,
    executor: QueryExecutor,
  ): Promise<ProcessKycProviderEventResult> {
    const ignored = await this.events.markProcessed(
      event.id,
      'ignored_stale',
      'KYC_EVENT_STALE',
      this.clock(),
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

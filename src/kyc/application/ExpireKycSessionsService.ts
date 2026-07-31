import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import { withTransaction, type QueryExecutor } from '../../shared/db/transaction.js'
import type { KycProfile } from '../domain/KycProfile.js'
import type { KycSession } from '../domain/KycSession.js'
import type { KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycSessionRepository } from '../infrastructure/KycSessionRepository.js'
import type { KycStatusTransitionRepository } from '../infrastructure/KycStatusTransitionRepository.js'
import type { KycActorContext } from './KycContext.js'

export interface ExpireKycResult {
  expiredSessionIds: string[]
  expiredProfileIds: string[]
}

export class ExpireKycSessionsService {
  constructor(
    private readonly pool: Pool,
    private readonly profiles: KycProfileRepository,
    private readonly sessions: KycSessionRepository,
    private readonly transitions: KycStatusTransitionRepository,
    private readonly audit: AuditRepository,
  ) {}

  async execute(now: Date, actor: KycActorContext): Promise<ExpireKycResult> {
    return withTransaction(this.pool, async (client) => {
      const result: ExpireKycResult = {
        expiredSessionIds: [],
        expiredProfileIds: [],
      }
      const sessions = await this.sessions.findExpiredPending(now, client)
      for (const session of sessions) {
        const expired = await this.sessions.updateFromEvent(
          {
            sessionId: session.id,
            status: 'expired',
            eventAt: now,
            completedAt: now,
          },
          client,
        )
        if (!expired) continue
        result.expiredSessionIds.push(session.id)
        const profile = await this.profiles.getForUpdate(session.playerId, client)
        if (
          profile &&
          profile.currentSessionId === session.id &&
          (profile.status === 'pending' || profile.status === 'manual_review')
        ) {
          const updated = await this.profiles.updateStatus(
            {
              profileId: profile.id,
              expectedVersion: profile.version,
              status: 'expired',
              provider: profile.provider,
              currentSessionId: session.id,
              verifiedAt: profile.verifiedAt,
              expiresAt: now,
              failureReasonCode: null,
            },
            client,
          )
          if (!updated) throw new Error('KYC profile expiry version conflict')
          result.expiredProfileIds.push(profile.id)
          await this.appendTransition(profile, session, now, actor, client, false)
        }
        await this.audit.append(
          {
            id: randomUUID(),
            actorType: actor.actorType,
            actorId: actor.actorId,
            playerId: session.playerId,
            action: 'kyc.session_expired',
            outcome: 'success',
            reasonCode: 'KYC_SESSION_EXPIRED',
            correlationId: actor.correlationId,
            metadata: { sessionId: session.id, attemptNumber: session.attemptNumber },
          },
          client,
        )
      }

      const profiles = await this.profiles.findExpiredVerified(now, client)
      for (const profile of profiles) {
        const updated = await this.profiles.updateStatus(
          {
            profileId: profile.id,
            expectedVersion: profile.version,
            status: 'expired',
            provider: profile.provider,
            currentSessionId: profile.currentSessionId,
            verifiedAt: profile.verifiedAt,
            expiresAt: profile.expiresAt,
            failureReasonCode: null,
          },
          client,
        )
        if (!updated) throw new Error('Verified KYC profile expiry version conflict')
        result.expiredProfileIds.push(profile.id)
        const session = profile.currentSessionId
          ? await this.sessions.findById(profile.currentSessionId, client)
          : null
        await this.appendTransition(profile, session, now, actor, client, true)
        await this.audit.append(
          {
            id: randomUUID(),
            actorType: actor.actorType,
            actorId: actor.actorId,
            playerId: profile.playerId,
            action: 'kyc.verification_expired',
            outcome: 'success',
            reasonCode: 'KYC_VERIFICATION_EXPIRED',
            correlationId: actor.correlationId,
            metadata: { profileId: profile.id, sessionId: profile.currentSessionId },
          },
          client,
        )
      }
      return result
    })
  }

  private async appendTransition(
    profile: KycProfile,
    session: KycSession | null,
    now: Date,
    actor: KycActorContext,
    executor: QueryExecutor,
    verificationExpiry: boolean,
  ): Promise<void> {
    const reasonCode = verificationExpiry
      ? 'KYC_VERIFICATION_EXPIRED'
      : 'KYC_SESSION_EXPIRED'
    await this.transitions.append(
      {
        id: randomUUID(),
        playerId: profile.playerId,
        sessionId: session?.id ?? null,
        fromStatus: profile.status,
        toStatus: 'expired',
        reasonCode,
        actorType: actor.actorType,
        actorId: actor.actorId,
        providerEventId: null,
        correlationId: actor.correlationId,
        metadata: { expiredAt: now.toISOString() },
      },
      executor,
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
          sessionId: session?.id ?? null,
          fromStatus: profile.status,
          toStatus: 'expired',
        },
      },
      executor,
    )
  }
}

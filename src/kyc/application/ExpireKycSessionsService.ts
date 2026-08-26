import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import { withTransaction } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import type { KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycSessionRepository } from '../infrastructure/KycSessionRepository.js'
import type { KycActorContext } from './KycContext.js'
import type { TransitionKycStatusService } from './TransitionKycStatusService.js'

export interface KycExpiryFailure {
  category: 'sessions' | 'profiles'
  reasonCode: string
}

export interface ExpireKycResult {
  expiredSessionIds: string[]
  expiredProfileIds: string[]
  sessionsExamined: number
  sessionsExpired: number
  profilesExamined: number
  profilesExpired: number
  failures: KycExpiryFailure[]
}

export class ExpireKycSessionsService {
  constructor(
    private readonly pool: Pool,
    private readonly profiles: KycProfileRepository,
    private readonly sessions: KycSessionRepository,
    private readonly transitionKycStatus: TransitionKycStatusService,
    private readonly audit: AuditRepository,
    private readonly sessionBatchSize = 100,
    private readonly profileBatchSize = 100,
  ) {}

  async execute(now: Date, actor: KycActorContext): Promise<ExpireKycResult> {
    const result: ExpireKycResult = {
      expiredSessionIds: [],
      expiredProfileIds: [],
      sessionsExamined: 0,
      sessionsExpired: 0,
      profilesExamined: 0,
      profilesExpired: 0,
      failures: [],
    }

    try {
      const sessionResult = await withTransaction(this.pool, async (client) => {
        const expiredSessionIds: string[] = []
        const expiredProfileIds: string[] = []
        const dueSessions = await this.sessions.findExpiredPending(
          now,
          this.sessionBatchSize,
          client,
        )
        result.sessionsExamined = dueSessions.length
        for (const session of dueSessions) {
          const expired = await this.sessions.expireIfDue(session.id, now, client)
          if (!expired) continue
          expiredSessionIds.push(session.id)
          const profile = await this.profiles.getForUpdate(session.playerId, client)
          if (
            profile &&
            profile.currentSessionId === session.id &&
            (profile.status === 'pending' || profile.status === 'manual_review')
          ) {
            await this.transitionKycStatus.execute(
              {
                playerId: profile.playerId,
                toStatus: 'expired',
                trigger: 'SESSION_EXPIRY',
                reasonCode: 'KYC_SESSION_EXPIRED',
                provider: profile.provider,
                sessionId: session.id,
                verifiedAt: profile.verifiedAt,
                expiresAt: session.expiresAt ?? now,
                failureReasonCode: null,
                metadata: {
                  expiredAt: (session.expiresAt ?? now).toISOString(),
                },
              },
              actor,
              client,
            )
            expiredProfileIds.push(profile.id)
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
        return { expiredSessionIds, expiredProfileIds }
      })
      result.expiredSessionIds.push(...sessionResult.expiredSessionIds)
      result.expiredProfileIds.push(...sessionResult.expiredProfileIds)
      result.sessionsExpired = sessionResult.expiredSessionIds.length
    } catch (error) {
      result.failures.push({
        category: 'sessions',
        reasonCode: this.failureReason(error, 'KYC_SESSION_EXPIRY_BATCH_FAILED'),
      })
    }

    try {
      const profileResult = await withTransaction(this.pool, async (client) => {
        const expiredProfileIds: string[] = []
        const dueProfiles = await this.profiles.findExpiredVerified(
          now,
          this.profileBatchSize,
          client,
        )
        result.profilesExamined = dueProfiles.length
        for (const profile of dueProfiles) {
          await this.transitionKycStatus.execute(
            {
              playerId: profile.playerId,
              toStatus: 'expired',
              trigger: 'VERIFICATION_EXPIRY',
              reasonCode: 'KYC_VERIFICATION_EXPIRED',
              provider: profile.provider,
              sessionId: profile.currentSessionId,
              verifiedAt: profile.verifiedAt,
              expiresAt: profile.expiresAt,
              failureReasonCode: null,
              metadata: {
                expiredAt: profile.expiresAt?.toISOString() ?? now.toISOString(),
              },
            },
            actor,
            client,
          )
          expiredProfileIds.push(profile.id)
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
        return expiredProfileIds
      })
      result.expiredProfileIds.push(...profileResult)
      result.profilesExpired = profileResult.length
    } catch (error) {
      result.failures.push({
        category: 'profiles',
        reasonCode: this.failureReason(error, 'KYC_PROFILE_EXPIRY_BATCH_FAILED'),
      })
    }

    return result
  }

  private failureReason(error: unknown, fallback: string): string {
    return error instanceof AppError ? error.code : fallback
  }
}

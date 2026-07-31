import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { PlayerRepository } from '../../players/infrastructure/PlayerRepository.js'
import { withTransaction } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import type { KycStatus } from '../domain/KycStatus.js'
import type { KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycSessionRepository } from '../infrastructure/KycSessionRepository.js'
import type { KycActorContext } from './KycContext.js'
import { getOrCreateKycProfile } from './profileCreation.js'

export interface SafeKycSession {
  sessionId: string
  status: 'pending' | 'manual_review'
  provider: string
  expiresAt: Date
  verificationUrl: string | null
}

export interface SafeKycProfile {
  status: KycStatus
  verifiedAt: Date | null
  expiresAt: Date | null
  currentSession: SafeKycSession | null
}

export class GetKycProfileService {
  constructor(
    private readonly pool: Pool,
    private readonly players: PlayerRepository,
    private readonly profiles: KycProfileRepository,
    private readonly sessions: KycSessionRepository,
    private readonly audit: AuditRepository,
  ) {}

  async execute(playerId: string, actor: KycActorContext): Promise<SafeKycProfile> {
    return withTransaction(this.pool, async (client) => {
      if (!(await this.players.findById(playerId, client))) {
        throw new AppError({
          status: 404,
          code: 'PLAYER_NOT_FOUND',
          message: 'Player was not found',
        })
      }
      const { profile } = await getOrCreateKycProfile(
        playerId,
        actor,
        this.profiles,
        this.audit,
        client,
      )
      const session =
        profile.currentSessionId &&
        (profile.status === 'pending' || profile.status === 'manual_review')
          ? await this.sessions.findById(profile.currentSessionId, client)
          : null
      const currentSession =
        session &&
        (session.status === 'pending' || session.status === 'manual_review') &&
        session.expiresAt
          ? {
              sessionId: session.id,
              status: session.status,
              provider: session.provider,
              expiresAt: session.expiresAt,
              verificationUrl: session.verificationUrl,
            }
          : null
      return {
        status: profile.status,
        verifiedAt: profile.verifiedAt,
        expiresAt: profile.expiresAt,
        currentSession,
      }
    })
  }
}

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { AuthenticatedIdentity } from '../../auth/AuthenticatedIdentity.js'
import { AppError } from '../../shared/http/AppError.js'
import type { AppLogger } from '../../shared/observability/logger.js'
import { withTransaction } from '../../shared/db/transaction.js'
import type { Player } from '../domain/Player.js'
import type { AuthenticationIdentityRepository } from '../infrastructure/AuthenticationIdentityRepository.js'
import type { PlayerRepository } from '../infrastructure/PlayerRepository.js'

export interface ResolvePlayerContext {
  correlationId: string
}

export interface ResolveOrCreatePlayerResult {
  player: Player
  created: boolean
}

export class ResolveOrCreatePlayerService {
  constructor(
    private readonly pool: Pool,
    private readonly players: PlayerRepository,
    private readonly identities: AuthenticationIdentityRepository,
    private readonly audit: AuditRepository,
    private readonly logger: AppLogger,
  ) {}

  async execute(
    identity: AuthenticatedIdentity,
    context: ResolvePlayerContext,
  ): Promise<ResolveOrCreatePlayerResult> {
    try {
      const result = await withTransaction(this.pool, async (client) => {
        const lockKey = JSON.stringify([
          identity.provider,
          identity.issuer,
          identity.subject,
        ])
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])

        const existingIdentity = await this.identities.findByExternalIdentity(identity, client)
        if (existingIdentity) {
          const player = await this.players.updateMutableProfile(
            {
              playerId: existingIdentity.playerId,
              email: identity.email,
              displayName: identity.displayName,
            },
            client,
          )
          await this.identities.updateLastSeen(existingIdentity.id, client)
          return { player, created: false }
        }

        const player = await this.players.createRestricted(
          {
            id: randomUUID(),
            email: identity.email,
            displayName: identity.displayName,
          },
          client,
        )
        await this.identities.create(
          {
            id: randomUUID(),
            playerId: player.id,
            provider: identity.provider,
            issuer: identity.issuer,
            subject: identity.subject,
          },
          client,
        )
        await this.audit.append(
          {
            id: randomUUID(),
            actorType: 'external_identity',
            actorId: identity.subject,
            playerId: player.id,
            action: 'player.provisioned',
            outcome: 'success',
            reasonCode: null,
            correlationId: context.correlationId,
            metadata: { provider: identity.provider },
          },
          client,
        )
        return { player, created: true }
      })

      this.logger.info({
        event: result.created ? 'player_provisioned' : 'player_resolved',
        correlationId: context.correlationId,
        playerId: result.player.id,
      })
      return result
    } catch (cause) {
      this.logger.error({ event: 'player_provisioning_failed', correlationId: context.correlationId, err: cause })
      throw new AppError({
        status: 503,
        code: 'PLAYER_STORE_UNAVAILABLE',
        message: 'Player provisioning failed',
        publicMessage: 'Player identity is temporarily unavailable',
        cause,
      })
    }
  }
}

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { PlayerRepository } from '../../players/infrastructure/PlayerRepository.js'
import { withTransaction } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import type {
  PlayerRestriction,
  RestrictionType,
} from '../domain/Restriction.js'
import type { RestrictionRepository } from '../infrastructure/RestrictionRepository.js'
import type { EligibilityActorContext } from './EligibilityContext.js'

export interface AddRestrictionInput {
  playerId: string
  type: RestrictionType
  reasonCode: string
  source: string
  startsAt?: Date
  endsAt?: Date | null
  metadata?: Record<string, unknown>
}

export class PlayerRestrictionService {
  constructor(
    private readonly pool: Pool,
    private readonly players: PlayerRepository,
    private readonly restrictions: RestrictionRepository,
    private readonly audit: AuditRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async addRestriction(
    input: AddRestrictionInput,
    actor: EligibilityActorContext,
  ): Promise<PlayerRestriction> {
    const startsAt = input.startsAt ?? this.clock()
    const endsAt = input.endsAt ?? null
    if (!input.reasonCode.trim() || !input.source.trim()) {
      throw new AppError({
        status: 400,
        code: 'RESTRICTION_DETAILS_REQUIRED',
        message: 'Restriction reason and source are required',
      })
    }
    if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new AppError({
        status: 400,
        code: 'RESTRICTION_TIME_RANGE_INVALID',
        message: 'Restriction end must be after its start',
      })
    }

    return withTransaction(this.pool, async (client) => {
      if (!(await this.players.findById(input.playerId, client))) {
        throw new AppError({
          status: 404,
          code: 'PLAYER_NOT_FOUND',
          message: 'Player was not found',
        })
      }
      const restriction = await this.restrictions.create(
        {
          id: randomUUID(),
          playerId: input.playerId,
          type: input.type,
          reasonCode: input.reasonCode,
          source: input.source,
          startsAt,
          endsAt,
          metadata: input.metadata ?? {},
        },
        client,
      )
      await this.audit.append(
        {
          id: randomUUID(),
          actorType: actor.actorType,
          actorId: actor.actorId,
          playerId: input.playerId,
          action: 'player.restriction_created',
          outcome: 'success',
          reasonCode: input.reasonCode,
          correlationId: actor.correlationId,
          metadata: {
            restrictionId: restriction.id,
            restrictionType: restriction.type,
            source: restriction.source,
            startsAt: restriction.startsAt.toISOString(),
            endsAt: restriction.endsAt?.toISOString() ?? null,
          },
        },
        client,
      )
      return restriction
    })
  }

  async removeRestriction(
    restrictionId: string,
    reasonCode: string,
    actor: EligibilityActorContext,
  ): Promise<PlayerRestriction> {
    return this.finishRestriction(restrictionId, 'removed', reasonCode, actor, false)
  }

  async expireRestriction(
    restrictionId: string,
    actor: EligibilityActorContext,
  ): Promise<PlayerRestriction> {
    return this.finishRestriction(restrictionId, 'expired', 'RESTRICTION_EXPIRED', actor, true)
  }

  async expireDueRestrictions(
    playerId: string,
    actor: EligibilityActorContext,
  ): Promise<PlayerRestriction[]> {
    const at = this.clock()
    return withTransaction(this.pool, async (client) => {
      const due = await this.restrictions.findExpiredActive(playerId, at, client)
      const expired: PlayerRestriction[] = []
      for (const restriction of due) {
        const changed = await this.restrictions.changeStatus(
          restriction.id,
          'active',
          'expired',
          client,
        )
        if (!changed) continue
        expired.push(changed)
        await this.appendRestrictionAudit(
          changed,
          'player.restriction_expired',
          'RESTRICTION_EXPIRED',
          actor,
          client,
        )
      }
      return expired
    })
  }

  async getRestrictions(playerId: string): Promise<PlayerRestriction[]> {
    return this.restrictions.listForPlayer(playerId, this.pool)
  }

  private async finishRestriction(
    restrictionId: string,
    status: 'removed' | 'expired',
    reasonCode: string,
    actor: EligibilityActorContext,
    requireDue: boolean,
  ): Promise<PlayerRestriction> {
    if (!reasonCode.trim()) {
      throw new AppError({
        status: 400,
        code: 'RESTRICTION_REASON_REQUIRED',
        message: 'Restriction change reason is required',
      })
    }
    return withTransaction(this.pool, async (client) => {
      const current = await this.restrictions.findByIdForUpdate(restrictionId, client)
      if (!current) {
        throw new AppError({
          status: 404,
          code: 'RESTRICTION_NOT_FOUND',
          message: 'Restriction was not found',
        })
      }
      if (current.status !== 'active') {
        throw new AppError({
          status: 409,
          code: 'RESTRICTION_NOT_ACTIVE',
          message: 'Restriction is no longer active',
        })
      }
      if (
        requireDue &&
        (current.endsAt === null || current.endsAt.getTime() > this.clock().getTime())
      ) {
        throw new AppError({
          status: 409,
          code: 'RESTRICTION_NOT_EXPIRED',
          message: 'Restriction has not reached its expiry',
        })
      }

      const changed = await this.restrictions.changeStatus(
        current.id,
        'active',
        status,
        client,
      )
      if (!changed) throw new Error('Restriction state changed while locked')
      await this.appendRestrictionAudit(
        changed,
        status === 'removed'
          ? 'player.restriction_removed'
          : 'player.restriction_expired',
        reasonCode,
        actor,
        client,
      )
      return changed
    })
  }

  private async appendRestrictionAudit(
    restriction: PlayerRestriction,
    action: string,
    reasonCode: string,
    actor: EligibilityActorContext,
    executor: Parameters<AuditRepository['append']>[1],
  ): Promise<void> {
    await this.audit.append(
      {
        id: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        playerId: restriction.playerId,
        action,
        outcome: 'success',
        reasonCode,
        correlationId: actor.correlationId,
        metadata: {
          restrictionId: restriction.id,
          restrictionType: restriction.type,
          restrictionStatus: restriction.status,
        },
      },
      executor,
    )
  }
}

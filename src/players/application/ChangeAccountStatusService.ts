import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import { withTransaction } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import type { AccountStatus } from '../domain/AccountStatus.js'
import { canChangeAccountStatus } from '../domain/AccountStatusTransition.js'
import type { Player } from '../domain/Player.js'
import type { AccountStatusTransitionRepository } from '../infrastructure/AccountStatusTransitionRepository.js'
import type { PlayerRepository } from '../infrastructure/PlayerRepository.js'

export interface AccountChangeActor {
  actorType: string
  actorId: string | null
  correlationId: string
}

export interface ChangeAccountStatusInput {
  playerId: string
  toStatus: AccountStatus
  reasonCode: string
}

export class ChangeAccountStatusService {
  constructor(
    private readonly pool: Pool,
    private readonly players: PlayerRepository,
    private readonly transitions: AccountStatusTransitionRepository,
    private readonly audit: AuditRepository,
  ) {}

  async execute(
    input: ChangeAccountStatusInput,
    actor: AccountChangeActor,
  ): Promise<Player> {
    if (!input.reasonCode.trim()) {
      throw new AppError({
        status: 400,
        code: 'ACCOUNT_STATUS_REASON_REQUIRED',
        message: 'Account status change reason is required',
      })
    }

    return withTransaction(this.pool, async (client) => {
      const current = await this.players.findByIdForUpdate(input.playerId, client)
      if (!current) {
        throw new AppError({
          status: 404,
          code: 'PLAYER_NOT_FOUND',
          message: 'Player was not found',
        })
      }
      if (!canChangeAccountStatus(current.accountStatus, input.toStatus)) {
        throw new AppError({
          status: 409,
          code: 'ACCOUNT_STATUS_TRANSITION_INVALID',
          message: `Cannot change account status from ${current.accountStatus} to ${input.toStatus}`,
          publicMessage: 'Account status transition is not allowed',
        })
      }

      const changed = await this.players.updateAccountStatus(
        current.id,
        input.toStatus,
        client,
      )
      const transitionId = randomUUID()
      await this.transitions.append(
        {
          id: transitionId,
          playerId: current.id,
          fromStatus: current.accountStatus,
          toStatus: input.toStatus,
          reasonCode: input.reasonCode,
          actorType: actor.actorType,
          actorId: actor.actorId,
          correlationId: actor.correlationId,
        },
        client,
      )
      await this.audit.append(
        {
          id: randomUUID(),
          actorType: actor.actorType,
          actorId: actor.actorId,
          playerId: current.id,
          action: 'player.account_status_changed',
          outcome: 'success',
          reasonCode: input.reasonCode,
          correlationId: actor.correlationId,
          metadata: {
            transitionId,
            fromStatus: current.accountStatus,
            toStatus: input.toStatus,
          },
        },
        client,
      )
      return changed
    })
  }
}

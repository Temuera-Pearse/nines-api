import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { AccountStatus } from '../domain/AccountStatus.js'
import type { Player } from '../domain/Player.js'

export interface CreateRestrictedPlayerInput {
  id: string
  email: string | null
  displayName: string | null
}

export interface UpdatePlayerProfileInput {
  playerId: string
  email: string | null
  displayName: string | null
}

export interface PlayerRepository {
  findById(playerId: string, executor: QueryExecutor): Promise<Player | null>
  findByIdForUpdate(playerId: string, executor: QueryExecutor): Promise<Player | null>
  createRestricted(input: CreateRestrictedPlayerInput, executor: QueryExecutor): Promise<Player>
  updateMutableProfile(input: UpdatePlayerProfileInput, executor: QueryExecutor): Promise<Player>
  updateAccountStatus(
    playerId: string,
    status: AccountStatus,
    executor: QueryExecutor,
  ): Promise<Player>
}

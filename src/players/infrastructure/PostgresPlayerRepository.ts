import type { QueryResultRow } from 'pg'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { AccountStatus } from '../domain/AccountStatus.js'
import type { Player } from '../domain/Player.js'
import type {
  CreateRestrictedPlayerInput,
  PlayerRepository,
  UpdatePlayerProfileInput,
} from './PlayerRepository.js'

interface PlayerRow extends QueryResultRow {
  id: string
  email: string | null
  display_name: string | null
  account_status: AccountStatus
  created_at: Date
  updated_at: Date
  version: number
}

function mapPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    accountStatus: row.account_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

const PLAYER_COLUMNS = `
  id, email, display_name, account_status, created_at, updated_at, version
`

export class PostgresPlayerRepository implements PlayerRepository {
  async findById(playerId: string, executor: QueryExecutor): Promise<Player | null> {
    const result = await executor.query<PlayerRow>(
      `SELECT ${PLAYER_COLUMNS} FROM players WHERE id = $1`,
      [playerId],
    )
    return result.rows[0] ? mapPlayer(result.rows[0]) : null
  }

  async findByIdForUpdate(playerId: string, executor: QueryExecutor): Promise<Player | null> {
    const result = await executor.query<PlayerRow>(
      `SELECT ${PLAYER_COLUMNS} FROM players WHERE id = $1 FOR UPDATE`,
      [playerId],
    )
    return result.rows[0] ? mapPlayer(result.rows[0]) : null
  }

  async createRestricted(
    input: CreateRestrictedPlayerInput,
    executor: QueryExecutor,
  ): Promise<Player> {
    const result = await executor.query<PlayerRow>(
      `INSERT INTO players (id, email, display_name, account_status)
       VALUES ($1, $2, $3, 'restricted')
       RETURNING ${PLAYER_COLUMNS}`,
      [input.id, input.email, input.displayName],
    )
    return mapPlayer(result.rows[0])
  }

  async updateMutableProfile(
    input: UpdatePlayerProfileInput,
    executor: QueryExecutor,
  ): Promise<Player> {
    const result = await executor.query<PlayerRow>(
      `UPDATE players
       SET email = COALESCE($2, email),
           display_name = COALESCE($3, display_name),
           updated_at = CASE
             WHEN ($2 IS NOT NULL AND email IS DISTINCT FROM $2)
               OR ($3 IS NOT NULL AND display_name IS DISTINCT FROM $3)
             THEN NOW() ELSE updated_at END,
           version = CASE
             WHEN ($2 IS NOT NULL AND email IS DISTINCT FROM $2)
               OR ($3 IS NOT NULL AND display_name IS DISTINCT FROM $3)
             THEN version + 1 ELSE version END
       WHERE id = $1
       RETURNING ${PLAYER_COLUMNS}`,
      [input.playerId, input.email, input.displayName],
    )
    if (!result.rows[0]) throw new Error('Linked player record was not found')
    return mapPlayer(result.rows[0])
  }

  async updateAccountStatus(
    playerId: string,
    status: AccountStatus,
    executor: QueryExecutor,
  ): Promise<Player> {
    const result = await executor.query<PlayerRow>(
      `UPDATE players
       SET account_status = $2,
           updated_at = NOW(),
           version = version + 1
       WHERE id = $1
       RETURNING ${PLAYER_COLUMNS}`,
      [playerId, status],
    )
    if (!result.rows[0]) throw new Error('Player record was not found')
    return mapPlayer(result.rows[0])
  }
}

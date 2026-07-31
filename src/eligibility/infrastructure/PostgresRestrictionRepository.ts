import type { QueryExecutor } from '../../shared/db/transaction.js'
import { sanitizeAuditMetadata } from '../../audit/metadata.js'
import type {
  PlayerRestriction,
  RestrictionStatus,
  RestrictionType,
} from '../domain/Restriction.js'
import type {
  CreateRestrictionInput,
  RestrictionRepository,
} from './RestrictionRepository.js'

interface RestrictionRow {
  id: string
  player_id: string
  restriction_type: RestrictionType
  status: RestrictionStatus
  reason_code: string
  source: string
  starts_at: Date
  ends_at: Date | null
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

const RESTRICTION_COLUMNS = `
  id, player_id, restriction_type, status, reason_code, source,
  starts_at, ends_at, metadata, created_at, updated_at
`

function mapRestriction(row: RestrictionRow): PlayerRestriction {
  return {
    id: row.id,
    playerId: row.player_id,
    type: row.restriction_type,
    status: row.status,
    reasonCode: row.reason_code,
    source: row.source,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PostgresRestrictionRepository implements RestrictionRepository {
  async create(
    input: CreateRestrictionInput,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction> {
    const result = await executor.query<RestrictionRow>(
      `INSERT INTO player_restrictions
        (id, player_id, restriction_type, reason_code, source, starts_at, ends_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING ${RESTRICTION_COLUMNS}`,
      [
        input.id,
        input.playerId,
        input.type,
        input.reasonCode,
        input.source,
        input.startsAt,
        input.endsAt,
        JSON.stringify(sanitizeAuditMetadata(input.metadata)),
      ],
    )
    return mapRestriction(result.rows[0])
  }

  async findByIdForUpdate(
    restrictionId: string,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction | null> {
    const result = await executor.query<RestrictionRow>(
      `SELECT ${RESTRICTION_COLUMNS}
       FROM player_restrictions
       WHERE id = $1
       FOR UPDATE`,
      [restrictionId],
    )
    return result.rows[0] ? mapRestriction(result.rows[0]) : null
  }

  async listForPlayer(
    playerId: string,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction[]> {
    const result = await executor.query<RestrictionRow>(
      `SELECT ${RESTRICTION_COLUMNS}
       FROM player_restrictions
       WHERE player_id = $1
       ORDER BY created_at DESC, id`,
      [playerId],
    )
    return result.rows.map(mapRestriction)
  }

  async listActiveAt(
    playerId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction[]> {
    const result = await executor.query<RestrictionRow>(
      `SELECT ${RESTRICTION_COLUMNS}
       FROM player_restrictions
       WHERE player_id = $1
         AND status = 'active'
         AND starts_at <= $2
         AND (ends_at IS NULL OR ends_at > $2)
       ORDER BY restriction_type, created_at, id`,
      [playerId, at],
    )
    return result.rows.map(mapRestriction)
  }

  async changeStatus(
    restrictionId: string,
    fromStatus: RestrictionStatus,
    toStatus: RestrictionStatus,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction | null> {
    const result = await executor.query<RestrictionRow>(
      `UPDATE player_restrictions
       SET status = $3, updated_at = NOW()
       WHERE id = $1 AND status = $2
       RETURNING ${RESTRICTION_COLUMNS}`,
      [restrictionId, fromStatus, toStatus],
    )
    return result.rows[0] ? mapRestriction(result.rows[0]) : null
  }

  async findExpiredActive(
    playerId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction[]> {
    const result = await executor.query<RestrictionRow>(
      `SELECT ${RESTRICTION_COLUMNS}
       FROM player_restrictions
       WHERE player_id = $1
         AND status = 'active'
         AND ends_at IS NOT NULL
         AND ends_at <= $2
       ORDER BY ends_at, id
       FOR UPDATE`,
      [playerId, at],
    )
    return result.rows.map(mapRestriction)
  }
}

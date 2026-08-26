import type { QueryResultRow } from 'pg'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycProfile } from '../domain/KycProfile.js'
import type { KycStatus } from '../domain/KycStatus.js'
import type {
  GetOrCreateKycProfileResult,
  KycProfileRepository,
  UpdateKycProfileStatusInput,
} from './KycProfileRepository.js'

interface KycProfileRow extends QueryResultRow {
  id: string
  player_id: string
  status: KycStatus
  provider: string | null
  current_session_id: string | null
  verified_at: Date | null
  expires_at: Date | null
  failure_reason_code: string | null
  version: number
  created_at: Date
  updated_at: Date
}

const PROFILE_COLUMNS = `
  id, player_id, status, provider, current_session_id, verified_at, expires_at,
  failure_reason_code, version, created_at, updated_at
`

function mapProfile(row: KycProfileRow): KycProfile {
  return {
    id: row.id,
    playerId: row.player_id,
    status: row.status,
    provider: row.provider,
    currentSessionId: row.current_session_id,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    failureReasonCode: row.failure_reason_code,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PostgresKycProfileRepository implements KycProfileRepository {
  async findForPlayer(
    playerId: string,
    executor: QueryExecutor,
  ): Promise<KycProfile | null> {
    const result = await executor.query<KycProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM player_kyc_profiles WHERE player_id = $1`,
      [playerId],
    )
    return result.rows[0] ? mapProfile(result.rows[0]) : null
  }

  async getOrCreateForPlayer(
    profileId: string,
    playerId: string,
    executor: QueryExecutor,
  ): Promise<GetOrCreateKycProfileResult> {
    const inserted = await executor.query<KycProfileRow>(
      `INSERT INTO player_kyc_profiles (id, player_id)
       VALUES ($1, $2)
       ON CONFLICT (player_id) DO NOTHING
       RETURNING ${PROFILE_COLUMNS}`,
      [profileId, playerId],
    )
    if (inserted.rows[0]) {
      return { profile: mapProfile(inserted.rows[0]), created: true }
    }
    const profile = await this.findForPlayer(playerId, executor)
    if (!profile) throw new Error('KYC profile conflict did not resolve to a row')
    return { profile, created: false }
  }

  async getForUpdate(
    playerId: string,
    executor: QueryExecutor,
  ): Promise<KycProfile | null> {
    const result = await executor.query<KycProfileRow>(
      `SELECT ${PROFILE_COLUMNS}
       FROM player_kyc_profiles
       WHERE player_id = $1
       FOR UPDATE`,
      [playerId],
    )
    return result.rows[0] ? mapProfile(result.rows[0]) : null
  }

  async updateStatus(
    input: UpdateKycProfileStatusInput,
    executor: QueryExecutor,
  ): Promise<KycProfile | null> {
    const result = await executor.query<KycProfileRow>(
      `UPDATE player_kyc_profiles
       SET status = $3,
           provider = $4,
           current_session_id = $5,
           verified_at = $6,
           expires_at = $7,
           failure_reason_code = $8,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1 AND version = $2
       RETURNING ${PROFILE_COLUMNS}`,
      [
        input.profileId,
        input.expectedVersion,
        input.status,
        input.provider,
        input.currentSessionId,
        input.verifiedAt,
        input.expiresAt,
        input.failureReasonCode,
      ],
    )
    return result.rows[0] ? mapProfile(result.rows[0]) : null
  }

  async findExpiredVerified(
    at: Date,
    limit: number,
    executor: QueryExecutor,
  ): Promise<KycProfile[]> {
    const result = await executor.query<KycProfileRow>(
      `SELECT ${PROFILE_COLUMNS}
       FROM player_kyc_profiles
       WHERE status = 'verified'
         AND expires_at IS NOT NULL
         AND expires_at <= $1
       ORDER BY expires_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [at, limit],
    )
    return result.rows.map(mapProfile)
  }
}

import type { QueryResultRow } from 'pg'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycSession, KycSessionStatus } from '../domain/KycSession.js'
import type {
  ActivateKycSessionInput,
  CreateKycSessionIntentInput,
  KycSessionRepository,
  UpdateKycSessionFromEventInput,
} from './KycSessionRepository.js'

interface KycSessionRow extends QueryResultRow {
  id: string
  player_id: string
  provider: string
  provider_session_reference: string | null
  verification_url: string | null
  idempotency_key: string | null
  status: KycSessionStatus
  attempt_number: number
  started_at: Date
  expires_at: Date | null
  completed_at: Date | null
  last_event_at: Date | null
  created_at: Date
  updated_at: Date
}

const SESSION_COLUMNS = `
  id, player_id, provider, provider_session_reference, verification_url,
  idempotency_key, status, attempt_number, started_at, expires_at,
  completed_at, last_event_at, created_at, updated_at
`

function mapSession(row: KycSessionRow): KycSession {
  return {
    id: row.id,
    playerId: row.player_id,
    provider: row.provider,
    providerSessionReference: row.provider_session_reference,
    verificationUrl: row.verification_url,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptNumber: row.attempt_number,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PostgresKycSessionRepository implements KycSessionRepository {
  async getCurrentEffective(
    playerId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM kyc_verification_sessions
       WHERE player_id = $1
         AND status IN ('creating', 'pending', 'manual_review')
         AND (expires_at IS NULL OR expires_at > $2)
       ORDER BY attempt_number DESC
       LIMIT 1`,
      [playerId, at],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async findById(
    sessionId: string,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM kyc_verification_sessions WHERE id = $1`,
      [sessionId],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async findByIdForUpdate(
    sessionId: string,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM kyc_verification_sessions
       WHERE id = $1
       FOR UPDATE`,
      [sessionId],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async findByIdempotencyKey(
    playerId: string,
    idempotencyKey: string,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM kyc_verification_sessions
       WHERE player_id = $1 AND idempotency_key = $2`,
      [playerId, idempotencyKey],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async nextAttemptNumber(
    playerId: string,
    executor: QueryExecutor,
  ): Promise<number> {
    const result = await executor.query<{ next_attempt: number }>(
      `SELECT COALESCE(MAX(attempt_number), 0)::int + 1 AS next_attempt
       FROM kyc_verification_sessions
       WHERE player_id = $1`,
      [playerId],
    )
    return result.rows[0].next_attempt
  }

  async createIntent(
    input: CreateKycSessionIntentInput,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `INSERT INTO kyc_verification_sessions
        (id, player_id, provider, idempotency_key, status, attempt_number, started_at)
       VALUES ($1, $2, $3, $4, 'creating', $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING ${SESSION_COLUMNS}`,
      [
        input.id,
        input.playerId,
        input.provider,
        input.idempotencyKey,
        input.attemptNumber,
        input.startedAt,
      ],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async activate(
    input: ActivateKycSessionInput,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `UPDATE kyc_verification_sessions
       SET provider_session_reference = $2,
           verification_url = $3,
           expires_at = $4,
           status = 'pending',
           updated_at = NOW()
       WHERE id = $1 AND status = 'creating'
       RETURNING ${SESSION_COLUMNS}`,
      [
        input.sessionId,
        input.providerSessionReference,
        input.verificationUrl,
        input.expiresAt,
      ],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async markCreationFailed(
    sessionId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `UPDATE kyc_verification_sessions
       SET status = 'creation_failed', completed_at = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'creating'
       RETURNING ${SESSION_COLUMNS}`,
      [sessionId, at],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async findByProviderReferenceForUpdate(
    provider: string,
    providerSessionReference: string,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM kyc_verification_sessions
       WHERE provider = $1 AND provider_session_reference = $2
       FOR UPDATE`,
      [provider, providerSessionReference],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async updateFromEvent(
    input: UpdateKycSessionFromEventInput,
    executor: QueryExecutor,
  ): Promise<KycSession | null> {
    const result = await executor.query<KycSessionRow>(
      `UPDATE kyc_verification_sessions
       SET status = $2,
           last_event_at = $3,
           completed_at = $4,
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [input.sessionId, input.status, input.eventAt, input.completedAt],
    )
    return result.rows[0] ? mapSession(result.rows[0]) : null
  }

  async findExpiredPending(
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycSession[]> {
    const result = await executor.query<KycSessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM kyc_verification_sessions
       WHERE status IN ('pending', 'manual_review')
         AND expires_at IS NOT NULL
         AND expires_at <= $1
       ORDER BY expires_at, id
       FOR UPDATE SKIP LOCKED`,
      [at],
    )
    return result.rows.map(mapSession)
  }
}

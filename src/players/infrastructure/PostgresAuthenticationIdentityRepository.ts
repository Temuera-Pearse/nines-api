import type { QueryResultRow } from 'pg'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type {
  AuthenticationIdentityRecord,
  AuthenticationIdentityRepository,
  CreateAuthenticationIdentityInput,
  ExternalIdentityKey,
} from './AuthenticationIdentityRepository.js'

interface IdentityRow extends QueryResultRow {
  id: string
  player_id: string
  provider: 'auth0'
  issuer: string
  subject: string
  created_at: Date
  last_seen_at: Date
}

function mapIdentity(row: IdentityRow): AuthenticationIdentityRecord {
  return {
    id: row.id,
    playerId: row.player_id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

export class PostgresAuthenticationIdentityRepository
  implements AuthenticationIdentityRepository
{
  async findByExternalIdentity(
    key: ExternalIdentityKey,
    executor: QueryExecutor,
  ): Promise<AuthenticationIdentityRecord | null> {
    const result = await executor.query<IdentityRow>(
      `SELECT id, player_id, provider, issuer, subject, created_at, last_seen_at
       FROM authentication_identities
       WHERE provider = $1 AND issuer = $2 AND subject = $3`,
      [key.provider, key.issuer, key.subject],
    )
    return result.rows[0] ? mapIdentity(result.rows[0]) : null
  }

  async create(
    input: CreateAuthenticationIdentityInput,
    executor: QueryExecutor,
  ): Promise<AuthenticationIdentityRecord> {
    const result = await executor.query<IdentityRow>(
      `INSERT INTO authentication_identities
         (id, player_id, provider, issuer, subject)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, player_id, provider, issuer, subject, created_at, last_seen_at`,
      [input.id, input.playerId, input.provider, input.issuer, input.subject],
    )
    return mapIdentity(result.rows[0])
  }

  async updateLastSeen(identityId: string, executor: QueryExecutor): Promise<void> {
    await executor.query(
      'UPDATE authentication_identities SET last_seen_at = NOW() WHERE id = $1',
      [identityId],
    )
  }
}

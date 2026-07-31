import type { QueryExecutor } from '../../shared/db/transaction.js'

export interface ExternalIdentityKey {
  provider: 'auth0'
  issuer: string
  subject: string
}

export interface AuthenticationIdentityRecord extends ExternalIdentityKey {
  id: string
  playerId: string
  createdAt: Date
  lastSeenAt: Date
}

export interface CreateAuthenticationIdentityInput extends ExternalIdentityKey {
  id: string
  playerId: string
}

export interface AuthenticationIdentityRepository {
  findByExternalIdentity(
    key: ExternalIdentityKey,
    executor: QueryExecutor,
  ): Promise<AuthenticationIdentityRecord | null>
  create(
    input: CreateAuthenticationIdentityInput,
    executor: QueryExecutor,
  ): Promise<AuthenticationIdentityRecord>
  updateLastSeen(identityId: string, executor: QueryExecutor): Promise<void>
}

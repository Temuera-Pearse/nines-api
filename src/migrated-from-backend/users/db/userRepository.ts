import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { getOptionalPool } from './pool.js'
import type {
  AgeVerificationStatus,
  CreateUserInput,
  UpdateAgeVerificationStatusInput,
  UpdateUserAccountStatusInput,
  UserAccountStatus,
  UserRecord,
} from '../user/types.js'

type Queryable = Pool | PoolClient

type UserRow = QueryResultRow & {
  id: string
  username: string
  email: string | null
  account_status: UserAccountStatus
  date_of_birth: string | Date
  age_verification_status: AgeVerificationStatus
  created_at: Date
  updated_at: Date
}

function normalizeDateOfBirth(value: string | Date): string {
  if (typeof value === 'string') {
    return value.slice(0, 10)
  }
  return value.toISOString().slice(0, 10)
}

export interface CreateUserRecordInput extends CreateUserInput {
  id: string
  accountStatus: UserAccountStatus
  ageVerificationStatus: AgeVerificationStatus
}

function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    accountStatus: row.account_status,
    dateOfBirth: normalizeDateOfBirth(row.date_of_birth),
    ageVerificationStatus: row.age_verification_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface UserRepository {
  createUser(
    input: CreateUserRecordInput,
    queryable?: Queryable,
  ): Promise<UserRecord>
  findUserById(userId: string): Promise<UserRecord | null>
  findUserByUsername(username: string): Promise<UserRecord | null>
  findUserByEmail(email: string): Promise<UserRecord | null>
  updateAccountStatus(
    input: UpdateUserAccountStatusInput,
  ): Promise<UserRecord | null>
  updateAgeVerificationStatus(
    input: UpdateAgeVerificationStatusInput,
  ): Promise<UserRecord | null>
}

export class PgUserRepository implements UserRepository {
  async createUser(
    input: CreateUserRecordInput,
    queryable?: Queryable,
  ): Promise<UserRecord> {
    const db = queryable ?? getOptionalPool()
    if (!db) {
      throw new Error('DATABASE_URL is not configured')
    }

    const result = await db.query<UserRow>(
      `
        insert into users (
          id,
          username,
          email,
          account_status,
          date_of_birth,
          age_verification_status,
          created_at,
          updated_at
        ) values ($1, $2, $3, $4, $5, $6, now(), now())
        returning *
      `,
      [
        input.id,
        input.username,
        input.email ?? null,
        input.accountStatus,
        input.dateOfBirth,
        input.ageVerificationStatus,
      ],
    )
    return mapUserRow(result.rows[0])
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<UserRow>(
      `
        select *
        from users
        where id = $1
        limit 1
      `,
      [userId],
    )
    return result.rows[0] ? mapUserRow(result.rows[0]) : null
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<UserRow>(
      `
        select *
        from users
        where lower(username) = lower($1)
        limit 1
      `,
      [username],
    )
    return result.rows[0] ? mapUserRow(result.rows[0]) : null
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<UserRow>(
      `
        select *
        from users
        where lower(email) = lower($1)
        limit 1
      `,
      [email],
    )
    return result.rows[0] ? mapUserRow(result.rows[0]) : null
  }

  async updateAccountStatus(
    input: UpdateUserAccountStatusInput,
  ): Promise<UserRecord | null> {
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<UserRow>(
      `
        update users
        set account_status = $2,
            updated_at = now()
        where id = $1
        returning *
      `,
      [input.userId, input.accountStatus],
    )
    return result.rows[0] ? mapUserRow(result.rows[0]) : null
  }

  async updateAgeVerificationStatus(
    input: UpdateAgeVerificationStatusInput,
  ): Promise<UserRecord | null> {
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<UserRow>(
      `
        update users
        set age_verification_status = $2,
            updated_at = now()
        where id = $1
        returning *
      `,
      [input.userId, input.ageVerificationStatus],
    )
    return result.rows[0] ? mapUserRow(result.rows[0]) : null
  }
}

let sharedUserRepository: UserRepository | null = null

export function getUserRepository(): UserRepository {
  if (!sharedUserRepository) {
    sharedUserRepository = new PgUserRepository()
  }
  return sharedUserRepository
}

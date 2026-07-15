import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { getOptionalPool } from './pool.js'
import { CANONICAL_FRONT_OF_HOUSE_CURRENCY } from '../financial/legacyAlphaFinancialAuthority.js'
import type { WalletRecord } from '../user/types.js'

type Queryable = Pool | PoolClient

type WalletRow = QueryResultRow & {
  id: string
  user_id: string
  currency: string
  balance_minor: string | number
  created_at: Date
  updated_at: Date
}

export interface CreateWalletInput {
  id: string
  userId: string
  currency: string
  balanceMinor?: bigint
}

function mapWalletRow(row: WalletRow): WalletRecord {
  return {
    id: row.id,
    userId: row.user_id,
    currency: row.currency,
    balanceMinor: BigInt(String(row.balance_minor)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface WalletRepository {
  createWallet(
    input: CreateWalletInput,
    queryable?: Queryable,
  ): Promise<WalletRecord>
  findWalletByUserId(
    userId: string,
    currency?: string,
  ): Promise<WalletRecord | null>
  findWalletById(walletId: string): Promise<WalletRecord | null>
  findWalletByUserIdForUpdate(
    userId: string,
    currency: string,
    queryable: Queryable,
  ): Promise<WalletRecord | null>
  updateBalanceMinor(
    walletId: string,
    balanceMinor: bigint,
    queryable: Queryable,
  ): Promise<WalletRecord>
}

export class PgWalletRepository implements WalletRepository {
  async createWallet(
    input: CreateWalletInput,
    queryable?: Queryable,
  ): Promise<WalletRecord> {
    const db = queryable ?? getOptionalPool()
    if (!db) {
      throw new Error('DATABASE_URL is not configured')
    }

    const result = await db.query<WalletRow>(
      `
        insert into wallets (
          id,
          user_id,
          currency,
          balance_minor,
          created_at,
          updated_at
        ) values ($1, $2, $3, $4, now(), now())
        returning *
      `,
      [
        input.id,
        input.userId,
        input.currency,
        String(input.balanceMinor ?? 0n),
      ],
    )
    return mapWalletRow(result.rows[0])
  }

  async findWalletByUserId(
    userId: string,
    currency = CANONICAL_FRONT_OF_HOUSE_CURRENCY,
  ): Promise<WalletRecord | null> {
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<WalletRow>(
      `
        select *
        from wallets
        where user_id = $1 and currency = $2
        limit 1
      `,
      [userId, currency],
    )
    return result.rows[0] ? mapWalletRow(result.rows[0]) : null
  }

  async findWalletById(walletId: string): Promise<WalletRecord | null> {
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<WalletRow>(
      `
        select *
        from wallets
        where id = $1
        limit 1
      `,
      [walletId],
    )
    return result.rows[0] ? mapWalletRow(result.rows[0]) : null
  }

  async findWalletByUserIdForUpdate(
    userId: string,
    currency: string,
    queryable: Queryable,
  ): Promise<WalletRecord | null> {
    const result = await queryable.query<WalletRow>(
      `
        select *
        from wallets
        where user_id = $1 and currency = $2
        limit 1
        for update
      `,
      [userId, currency],
    )
    return result.rows[0] ? mapWalletRow(result.rows[0]) : null
  }

  async updateBalanceMinor(
    walletId: string,
    balanceMinor: bigint,
    queryable: Queryable,
  ): Promise<WalletRecord> {
    const result = await queryable.query<WalletRow>(
      `
        update wallets
        set balance_minor = $2,
            updated_at = now()
        where id = $1
        returning *
      `,
      [walletId, String(balanceMinor)],
    )
    return mapWalletRow(result.rows[0])
  }
}

let sharedWalletRepository: WalletRepository | null = null

export function getWalletRepository(): WalletRepository {
  if (!sharedWalletRepository) {
    sharedWalletRepository = new PgWalletRepository()
  }
  return sharedWalletRepository
}

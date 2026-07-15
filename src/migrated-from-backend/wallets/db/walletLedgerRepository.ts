import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { getOptionalPool } from './pool.js'
import type {
  WalletLedgerEntryRecord,
  WalletLedgerEntryType,
} from '../user/types.js'

type Queryable = Pool | PoolClient

type WalletLedgerRow = QueryResultRow & {
  id: string | number
  wallet_id: string
  entry_type: WalletLedgerEntryType
  delta_minor: string | number
  balance_after_minor: string | number
  reference_type: string | null
  reference_id: string | null
  metadata: Record<string, unknown>
  created_at: Date
}

export interface CreateWalletLedgerEntryInput {
  walletId: string
  entryType: WalletLedgerEntryType
  deltaMinor: bigint
  balanceAfterMinor: bigint
  referenceType?: string | null
  referenceId?: string | null
  metadata?: Record<string, unknown>
}

function mapWalletLedgerRow(row: WalletLedgerRow): WalletLedgerEntryRecord {
  return {
    id: Number(row.id),
    walletId: row.wallet_id,
    entryType: row.entry_type,
    deltaMinor: BigInt(String(row.delta_minor)),
    balanceAfterMinor: BigInt(String(row.balance_after_minor)),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    metadata:
      row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.created_at,
  }
}

export interface WalletLedgerRepository {
  createEntry(
    input: CreateWalletLedgerEntryInput,
    queryable: Queryable,
  ): Promise<WalletLedgerEntryRecord>
  listEntriesByWalletId(walletId: string): Promise<WalletLedgerEntryRecord[]>
}

export class PgWalletLedgerRepository implements WalletLedgerRepository {
  async createEntry(
    input: CreateWalletLedgerEntryInput,
    queryable: Queryable,
  ): Promise<WalletLedgerEntryRecord> {
    const result = await queryable.query<WalletLedgerRow>(
      `
        insert into wallet_ledger_entries (
          wallet_id,
          entry_type,
          delta_minor,
          balance_after_minor,
          reference_type,
          reference_id,
          metadata,
          created_at
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
        returning *
      `,
      [
        input.walletId,
        input.entryType,
        String(input.deltaMinor),
        String(input.balanceAfterMinor),
        input.referenceType ?? null,
        input.referenceId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    )
    return mapWalletLedgerRow(result.rows[0])
  }

  async listEntriesByWalletId(
    walletId: string,
  ): Promise<WalletLedgerEntryRecord[]> {
    const pool = getOptionalPool()
    if (!pool) return []

    const result = await pool.query<WalletLedgerRow>(
      `
        select *
        from wallet_ledger_entries
        where wallet_id = $1
        order by created_at asc, id asc
      `,
      [walletId],
    )
    return result.rows.map(mapWalletLedgerRow)
  }
}

let sharedWalletLedgerRepository: WalletLedgerRepository | null = null

export function getWalletLedgerRepository(): WalletLedgerRepository {
  if (!sharedWalletLedgerRepository) {
    sharedWalletLedgerRepository = new PgWalletLedgerRepository()
  }
  return sharedWalletLedgerRepository
}

import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { getOptionalPool } from './pool.js'
import type {
  BetRecord,
  BetResultStatus,
  BetStatus,
  BetType,
  CreateBetInput,
} from '../bet/types.js'

type Queryable = Pool | PoolClient

type BetRow = QueryResultRow & {
  id: string
  user_id: string
  wallet_id: string
  race_id: string
  currency: string
  bet_type: BetType
  selection_id: string
  stake_minor: string | number
  payout_minor: string | number | null
  status: BetStatus
  result_status: BetResultStatus
  placed_at: Date
  settled_at: Date | null
  refunded_at: Date | null
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

function mapBetRow(row: BetRow): BetRecord {
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    raceId: row.race_id,
    currency: row.currency,
    betType: row.bet_type,
    selectionId: row.selection_id,
    stakeMinor: BigInt(String(row.stake_minor)),
    payoutMinor:
      row.payout_minor === null ? null : BigInt(String(row.payout_minor)),
    status: row.status,
    resultStatus: row.result_status,
    placedAt: row.placed_at,
    settledAt: row.settled_at,
    refundedAt: row.refunded_at,
    metadata:
      row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface MarkBetSettledInput {
  betId: string
  payoutMinor: bigint
  status: BetStatus
  resultStatus: BetResultStatus
  settledAt: Date
}

export interface MarkBetRefundedInput {
  betId: string
  status: BetStatus
  resultStatus: BetResultStatus
  refundedAt: Date
}

export interface BetRepository {
  createBet(input: CreateBetInput, queryable: Queryable): Promise<BetRecord>
  findBetById(betId: string): Promise<BetRecord | null>
  listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]>
  listBetsByRaceId(raceId: string, queryable?: Queryable): Promise<BetRecord[]>
  listUnsettledBetsByRaceId(
    raceId: string,
    queryable: Queryable,
  ): Promise<BetRecord[]>
  markBetSettled(
    input: MarkBetSettledInput,
    queryable: Queryable,
  ): Promise<BetRecord | null>
  markBetRefunded(
    input: MarkBetRefundedInput,
    queryable: Queryable,
  ): Promise<BetRecord | null>
}

export class PgBetRepository implements BetRepository {
  async createBet(input: CreateBetInput, queryable: Queryable): Promise<BetRecord> {
    const result = await queryable.query<BetRow>(
      `
        insert into bets (
          id,
          user_id,
          wallet_id,
          race_id,
          currency,
          bet_type,
          selection_id,
          stake_minor,
          payout_minor,
          status,
          result_status,
          placed_at,
          settled_at,
          refunded_at,
          metadata,
          created_at,
          updated_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15::jsonb,
          now(),
          now()
        )
        returning *
      `,
      [
        input.id,
        input.userId,
        input.walletId,
        input.raceId,
        input.currency,
        input.betType,
        input.selectionId,
        String(input.stakeMinor),
        input.payoutMinor === null || input.payoutMinor === undefined
          ? null
          : String(input.payoutMinor),
        input.status,
        input.resultStatus,
        input.placedAt ?? new Date(),
        input.settledAt ?? null,
        input.refundedAt ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    )
    return mapBetRow(result.rows[0])
  }

  async findBetById(betId: string): Promise<BetRecord | null> {
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<BetRow>(
      `
        select *
        from bets
        where id = $1
        limit 1
      `,
      [betId],
    )
    return result.rows[0] ? mapBetRow(result.rows[0]) : null
  }

  async listBetsByUserId(userId: string, limit = 50): Promise<BetRecord[]> {
    const pool = getOptionalPool()
    if (!pool) return []

    const result = await pool.query<BetRow>(
      `
        select *
        from bets
        where user_id = $1
        order by created_at desc
        limit $2
      `,
      [userId, limit],
    )
    return result.rows.map(mapBetRow)
  }

  async listBetsByRaceId(
    raceId: string,
    queryable?: Queryable,
  ): Promise<BetRecord[]> {
    const executor = queryable ?? getOptionalPool()
    if (!executor) return []

    const result = await executor.query<BetRow>(
      `
        select *
        from bets
        where race_id = $1
        order by created_at asc, id asc
      `,
      [raceId],
    )
    return result.rows.map(mapBetRow)
  }

  async listUnsettledBetsByRaceId(
    raceId: string,
    queryable: Queryable,
  ): Promise<BetRecord[]> {
    const result = await queryable.query<BetRow>(
      `
        select *
        from bets
        where race_id = $1
          and status = 'placed'
          and result_status = 'pending'
        order by created_at asc, id asc
        for update
      `,
      [raceId],
    )
    return result.rows.map(mapBetRow)
  }

  async markBetSettled(
    input: MarkBetSettledInput,
    queryable: Queryable,
  ): Promise<BetRecord | null> {
    const result = await queryable.query<BetRow>(
      `
        update bets
        set payout_minor = $2,
            status = $3,
            result_status = $4,
            settled_at = $5,
            updated_at = now()
        where id = $1
        returning *
      `,
      [
        input.betId,
        String(input.payoutMinor),
        input.status,
        input.resultStatus,
        input.settledAt,
      ],
    )
    return result.rows[0] ? mapBetRow(result.rows[0]) : null
  }

  async markBetRefunded(
    input: MarkBetRefundedInput,
    queryable: Queryable,
  ): Promise<BetRecord | null> {
    const result = await queryable.query<BetRow>(
      `
        update bets
        set status = $2,
            result_status = $3,
            refunded_at = $4,
            updated_at = now()
        where id = $1
        returning *
      `,
      [input.betId, input.status, input.resultStatus, input.refundedAt],
    )
    return result.rows[0] ? mapBetRow(result.rows[0]) : null
  }
}

let sharedBetRepository: BetRepository | null = null

export function getBetRepository(): BetRepository {
  if (!sharedBetRepository) {
    sharedBetRepository = new PgBetRepository()
  }
  return sharedBetRepository
}

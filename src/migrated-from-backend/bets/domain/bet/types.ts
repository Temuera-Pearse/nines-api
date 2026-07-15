export type BetType = 'win'

export type BetStatus = 'placed' | 'settled' | 'refunded' | 'cancelled'

export type BetResultStatus = 'pending' | 'won' | 'lost' | 'void' | 'refunded'

/**
 * Backend-local bet read model only. Canonical accepted financial bet state
 * lives in nines-financial `financial_bets`.
 */
export interface BetRecord {
  id: string
  userId: string
  walletId: string
  raceId: string
  currency: string
  betType: BetType
  selectionId: string
  stakeMinor: bigint
  payoutMinor: bigint | null
  status: BetStatus
  resultStatus: BetResultStatus
  placedAt: Date
  settledAt: Date | null
  refundedAt: Date | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface CreateBetInput {
  id: string
  userId: string
  walletId: string
  raceId: string
  currency: string
  betType: BetType
  selectionId: string
  stakeMinor: bigint
  payoutMinor?: bigint | null
  status: BetStatus
  resultStatus: BetResultStatus
  placedAt?: Date
  settledAt?: Date | null
  refundedAt?: Date | null
  metadata?: Record<string, unknown>
}

export interface PlaceBetInput {
  userId: string
  raceId: string
  selectionId: string
  stakeMinor: bigint
  currency?: string
  betType?: BetType
  idempotencyKey?: string
  metadata?: Record<string, unknown>
}

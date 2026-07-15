import type { BetRecord } from '../bet/types.js'
import type { WalletLedgerEntryRecord } from '../user/types.js'

export interface SettledBetRecord {
  bet: BetRecord
  ledgerEntry: WalletLedgerEntryRecord | null
}

export interface SettleRaceBetsResult {
  raceId: string
  winnerId: string
  settledAt: Date
  processedCount: number
  wonCount: number
  lostCount: number
  totalPayoutMinor: bigint
  settledBets: SettledBetRecord[]
}
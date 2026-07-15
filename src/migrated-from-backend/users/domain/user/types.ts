export type UserAccountStatus =
  | 'pending'
  | 'active'
  | 'restricted'
  | 'suspended'
  | 'blocked'
  | 'closed'

export type AgeVerificationStatus =
  | 'unverified'
  | 'self_attested'
  | 'verified'
  | 'underage'
  | 'rejected'

export type WalletLedgerEntryType =
  | 'admin_credit'
  | 'admin_debit'
  | 'bet_stake'
  | 'bet_refund'
  | 'settlement_credit'
  | 'settlement_reversal'
  | 'adjustment'

export interface UserRecord {
  id: string
  username: string
  email: string | null
  accountStatus: UserAccountStatus
  dateOfBirth: string
  ageVerificationStatus: AgeVerificationStatus
  createdAt: Date
  updatedAt: Date
}

export interface WalletRecord {
  id: string
  userId: string
  currency: string
  balanceMinor: bigint
  createdAt: Date
  updatedAt: Date
}

export interface WalletLedgerEntryRecord {
  id: number
  walletId: string
  entryType: WalletLedgerEntryType
  deltaMinor: bigint
  balanceAfterMinor: bigint
  referenceType: string | null
  referenceId: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface CreateUserInput {
  username: string
  email?: string | null
  dateOfBirth: string
  currency?: string
}

export interface UpdateUserAccountStatusInput {
  userId: string
  accountStatus: UserAccountStatus
}

export interface UpdateAgeVerificationStatusInput {
  userId: string
  ageVerificationStatus: AgeVerificationStatus
}

export interface WalletAdjustmentInput {
  userId: string
  amountMinor: bigint
  currency?: string
  entryType: WalletLedgerEntryType
  referenceType?: string | null
  referenceId?: string | null
  metadata?: Record<string, unknown>
}

export interface BetEligibilityResult {
  allowed: boolean
  reasons: string[]
}

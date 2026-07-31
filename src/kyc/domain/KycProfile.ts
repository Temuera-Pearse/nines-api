import type { KycStatus } from './KycStatus.js'

export interface KycProfile {
  id: string
  playerId: string
  status: KycStatus
  provider: string | null
  currentSessionId: string | null
  verifiedAt: Date | null
  expiresAt: Date | null
  failureReasonCode: string | null
  version: number
  createdAt: Date
  updatedAt: Date
}

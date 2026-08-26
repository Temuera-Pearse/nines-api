import type { KycReasonCode } from './KycReasonCode.js'
import type { KycStatus } from './KycStatus.js'

const ALLOWED_TRANSITIONS: Readonly<Record<KycStatus, readonly KycStatus[]>> = {
  not_started: ['pending'],
  pending: ['verified', 'failed', 'manual_review', 'expired'],
  manual_review: ['verified', 'failed', 'pending', 'expired'],
  verified: ['expired', 'manual_review'],
  failed: ['pending'],
  expired: ['pending'],
}

export const KYC_TRANSITION_TABLE = ALLOWED_TRANSITIONS

export function canTransitionKycStatus(from: KycStatus, to: KycStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export interface KycStatusTransition {
  id: string
  kycProfileId: string
  playerId: string
  sessionId: string | null
  fromStatus: KycStatus
  toStatus: KycStatus
  reasonCode: KycReasonCode
  reasonCodes: string[]
  trigger: string
  actorType: 'PLAYER' | 'ADMIN' | 'PROVIDER' | 'SYSTEM'
  actorId: string | null
  providerEventId: string | null
  correlationId: string
  policyVersion: string | null
  profileVersion: number
  metadata: Record<string, unknown>
  createdAt: Date
}

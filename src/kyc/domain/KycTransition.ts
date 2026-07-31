import type { KycReasonCode } from './KycReasonCode.js'
import type { KycStatus } from './KycStatus.js'

const ALLOWED_TRANSITIONS: Readonly<Record<KycStatus, readonly KycStatus[]>> = {
  not_started: ['pending'],
  pending: ['verified', 'failed', 'manual_review', 'expired'],
  manual_review: ['verified', 'failed', 'expired'],
  verified: ['expired'],
  failed: ['pending'],
  expired: ['pending'],
}

export function canTransitionKycStatus(from: KycStatus, to: KycStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export interface KycStatusTransition {
  id: string
  playerId: string
  sessionId: string | null
  fromStatus: KycStatus
  toStatus: KycStatus
  reasonCode: KycReasonCode
  actorType: string
  actorId: string | null
  providerEventId: string | null
  correlationId: string
  metadata: Record<string, unknown>
  createdAt: Date
}

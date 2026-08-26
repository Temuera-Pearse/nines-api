import type { KycActorType } from '../application/KycContext.js'
import type { KycStatus } from './KycStatus.js'

export const KYC_MANUAL_REVIEW_STATUSES = [
  'requested',
  'open',
  'assigned',
  'completed',
] as const

export type KycManualReviewStatus = (typeof KYC_MANUAL_REVIEW_STATUSES)[number]

export interface KycManualReview {
  id: string
  playerId: string
  kycProfileId: string
  sessionId: string | null
  status: KycManualReviewStatus
  assignedActorId: string | null
  requestedAt: Date
  openedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface KycManualReviewAction {
  id: string
  reviewId: string
  playerId: string
  kycProfileId: string
  previousStatus: KycStatus
  newStatus: KycStatus
  action: string
  actorType: KycActorType
  actorId: string | null
  reasonCodes: string[]
  notes: string | null
  createdAt: Date
}

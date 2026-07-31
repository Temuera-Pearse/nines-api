import type { KycStatus } from './KycStatus.js'

export const KYC_EVENT_RESULT_STATUSES = [
  'pending',
  'verified',
  'failed',
  'manual_review',
  'expired',
] as const

export type KycEventResultStatus = Extract<
  KycStatus,
  (typeof KYC_EVENT_RESULT_STATUSES)[number]
>

export const KYC_EVENT_PROCESSING_STATUSES = [
  'received',
  'processed',
  'ignored_duplicate',
  'ignored_stale',
  'rejected',
] as const

export type KycEventProcessingStatus =
  (typeof KYC_EVENT_PROCESSING_STATUSES)[number]

export interface NormalizedKycProviderEvent {
  provider: string
  providerEventId: string
  providerSessionReference: string
  eventType: string
  resultingStatus: KycEventResultStatus
  occurredAt: Date
  reasonCode: string | null
  payloadHash: string
  metadata: Record<string, unknown>
}

export interface StoredKycProviderEvent extends NormalizedKycProviderEvent {
  id: string
  processingStatus: KycEventProcessingStatus
  processingReasonCode: string | null
  correlationId: string
  receivedAt: Date
  processedAt: Date | null
}

export function isStaleKycEvent(input: {
  event: NormalizedKycProviderEvent
  sessionStartedAt: Date
  sessionLastEventAt: Date | null
  sessionIsCurrent: boolean
  sessionStatus: string
}): boolean {
  if (!input.sessionIsCurrent) return true
  if (input.event.occurredAt.getTime() < input.sessionStartedAt.getTime()) return true
  if (
    input.sessionLastEventAt &&
    input.event.occurredAt.getTime() <= input.sessionLastEventAt.getTime()
  ) {
    return true
  }
  if (
    ['verified', 'failed', 'expired', 'creation_failed'].includes(input.sessionStatus)
  ) {
    return true
  }
  return input.event.resultingStatus === 'pending' && input.sessionStatus !== 'pending'
}

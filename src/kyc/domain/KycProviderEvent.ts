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
  'ignored_expired',
  'rejected',
] as const

export type KycEventProcessingStatus =
  (typeof KYC_EVENT_PROCESSING_STATUSES)[number]

export interface KycProviderEventMetadata {
  source?: string
}

const METADATA_KEYS = new Set<keyof KycProviderEventMetadata>(['source'])

export function normalizeKycProviderEventMetadata(
  value: unknown,
): KycProviderEventMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = (value as Record<string, unknown>).source
  return typeof source === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(source)
    ? { source }
    : {}
}

export function assertKycProviderEventMetadata(
  value: KycProviderEventMetadata,
): void {
  const keys = Object.keys(value)
  if (keys.some((key) => !METADATA_KEYS.has(key as keyof KycProviderEventMetadata))) {
    throw new Error('KYC provider event metadata contains non-allowlisted fields')
  }
  if (
    value.source !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.source)
  ) {
    throw new Error('KYC provider event metadata source is invalid')
  }
}

export interface NormalizedKycProviderEvent {
  provider: string
  providerEventId: string
  providerSessionReference: string
  claimedPlayerReference: string | null
  eventType: string
  resultingStatus: KycEventResultStatus
  occurredAt: Date
  reasonCode: string | null
  payloadHash: string
  metadata: KycProviderEventMetadata
}

export interface StoredKycProviderEvent extends NormalizedKycProviderEvent {
  id: string
  processingStatus: KycEventProcessingStatus
  processingReasonCode: string | null
  correlationId: string
  receivedAt: Date
  acceptedAt: Date | null
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

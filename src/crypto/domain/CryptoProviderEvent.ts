import { isTerminalCryptoFundingStatus, type CryptoFundingStatus } from './CryptoFunding.js'

export const CRYPTO_PROVIDER_EVENT_STATUSES = [
  'payment_detected',
  'confirming',
  'confirmed',
  'failed',
  'expired',
] as const

export type CryptoProviderEventStatus = (typeof CRYPTO_PROVIDER_EVENT_STATUSES)[number]

export const CRYPTO_EVENT_PROCESSING_STATUSES = [
  'received',
  'processed',
  'ignored_duplicate',
  'ignored_stale',
  'ignored_expired',
  'rejected',
] as const

export type CryptoEventProcessingStatus = (typeof CRYPTO_EVENT_PROCESSING_STATUSES)[number]

export interface CryptoProviderEventMetadata {
  providerTransactionId?: string
  confirmationStage?: string
  sequence?: number
}

export interface NormalizedCryptoProviderEvent {
  provider: string
  providerEventId: string
  providerReference: string
  claimedFundingIntentId: string | null
  claimedPlayerId: string | null
  eventType: string
  status: CryptoProviderEventStatus
  providerOccurredAt: Date
  asset: string | null
  amount: string | null
  payloadHash: string
  metadata: CryptoProviderEventMetadata
}

export interface StoredCryptoProviderEvent extends NormalizedCryptoProviderEvent {
  id: string
  fundingIntentId: string | null
  processingStatus: CryptoEventProcessingStatus
  processingReasonCode: string | null
  correlationId: string
  receivedAt: Date
  acceptedAt: Date | null
  processedAt: Date | null
}

export function providerStatusToFundingStatus(
  status: CryptoProviderEventStatus,
): CryptoFundingStatus {
  if (status === 'payment_detected') return 'detected'
  return status
}

export function isCryptoEventStale(input: {
  providerOccurredAt: Date
  fundingCreatedAt: Date
  lastProviderEventAt: Date | null
  currentStatus: CryptoFundingStatus
  targetStatus: CryptoFundingStatus
}): boolean {
  if (isTerminalCryptoFundingStatus(input.currentStatus)) return true
  if (input.providerOccurredAt < input.fundingCreatedAt) return true
  if (input.lastProviderEventAt && input.providerOccurredAt <= input.lastProviderEventAt) return true
  const rank: Partial<Record<CryptoFundingStatus, number>> = {
    awaiting_payment: 0,
    detected: 1,
    confirming: 2,
    confirmed: 3,
  }
  const currentRank = rank[input.currentStatus]
  const targetRank = rank[input.targetStatus]
  return currentRank !== undefined && targetRank !== undefined && targetRank <= currentRank
}

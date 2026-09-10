import type { KycActorType } from '../../kyc/application/KycContext.js'

export const CRYPTO_FUNDING_STATUSES = [
  'provider_pending',
  'awaiting_payment',
  'detected',
  'confirming',
  'confirmed',
  'failed',
  'expired',
  'reconciliation_required',
  'creation_failed',
] as const

export type CryptoFundingStatus = (typeof CRYPTO_FUNDING_STATUSES)[number]

const TRANSITIONS: Record<CryptoFundingStatus, readonly CryptoFundingStatus[]> = {
  provider_pending: ['awaiting_payment', 'creation_failed', 'failed', 'expired'],
  awaiting_payment: [
    'detected',
    'confirming',
    'confirmed',
    'failed',
    'expired',
    'reconciliation_required',
  ],
  detected: ['confirming', 'confirmed', 'failed', 'expired', 'reconciliation_required'],
  confirming: ['confirmed', 'failed', 'expired', 'reconciliation_required'],
  confirmed: [],
  failed: [],
  expired: [],
  reconciliation_required: [],
  creation_failed: [],
}

export function canTransitionCryptoFunding(
  from: CryptoFundingStatus,
  to: CryptoFundingStatus,
): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isTerminalCryptoFundingStatus(status: CryptoFundingStatus): boolean {
  return ['confirmed', 'failed', 'expired', 'reconciliation_required', 'creation_failed'].includes(
    status,
  )
}

export interface CryptoFundingIntent {
  id: string
  playerId: string
  asset: string
  requestedAmount: string
  status: CryptoFundingStatus
  provider: string
  idempotencyKey: string
  requestHash: string
  eligibilityDecisionId: string | null
  eligibilityPolicyVersion: string | null
  eligibilityEvaluatedAt: Date | null
  providerReference: string | null
  paymentUrl: string | null
  expiresAt: Date
  confirmedAt: Date | null
  failedAt: Date | null
  lastProviderEventAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface CryptoFundingActorContext {
  actorType: KycActorType
  actorId: string | null
  correlationId: string
}

export interface CryptoFundingPublicResult {
  id: string
  status: CryptoFundingStatus
  asset: string
  amount: string
  provider: {
    type: string
    sessionReference: string | null
    paymentUrl: string | null
  }
  createdAt: Date
  expiresAt: Date
  confirmedAt: Date | null
}

export function toCryptoFundingPublicResult(
  intent: CryptoFundingIntent,
): CryptoFundingPublicResult {
  return {
    id: intent.id,
    status: intent.status,
    asset: intent.asset,
    amount: intent.requestedAmount,
    provider: {
      type: intent.provider,
      sessionReference: intent.providerReference,
      paymentUrl: intent.paymentUrl,
    },
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    confirmedAt: intent.confirmedAt,
  }
}

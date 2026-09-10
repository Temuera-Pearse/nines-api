import type { CanonicalJson } from '../../shared/contracts/canonicalJson.js'
import { hashCanonicalJson } from '../../shared/contracts/canonicalJson.js'

export const CONFIRMED_FUNDING_ATTESTATION_SCHEMA_VERSION = 1 as const
export const CONFIRMED_FUNDING_EVENT_TYPE = 'external_funding_confirmed' as const

export interface ConfirmedFundingAttestationV1 {
  schemaVersion: 1
  eventType: typeof CONFIRMED_FUNDING_EVENT_TYPE
  fundingAttestationId: string
  issuer: 'nines-api'
  audience: 'nines-financial'
  environment: 'development' | 'test' | 'production'
  playerId: string
  fundingIntentId: string
  provider: {
    name: string
    paymentReference: string
    confirmationEventId: string
  }
  externalPayment: {
    asset: string
    atomicUnits: string
    scale: number
  }
  confirmedAt: string
  issuedAt: string
  automaticProcessingUntil: string
  purchaseEligibility: {
    decisionId: string
    policyVersion: string
    evaluatedAt: string
  }
  correlationId: string
  causationId: string
}

export function hashConfirmedFundingAttestation(attestation: ConfirmedFundingAttestationV1): string {
  return hashCanonicalJson(attestation as unknown as CanonicalJson)
}

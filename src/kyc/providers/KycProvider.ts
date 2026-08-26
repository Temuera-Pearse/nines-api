import type { NormalizedKycProviderEvent } from '../domain/KycProviderEvent.js'
import type { KycReasonCode } from '../domain/KycReasonCode.js'

export interface CreateKycSessionInput {
  playerId: string
  internalSessionId: string
  /**
   * Stable provider idempotency key. Every provider adapter must map this value
   * to the provider's idempotent session-creation mechanism.
   */
  idempotencyKey: string
  correlationId: string
}

export interface CreateKycSessionResult {
  provider: string
  providerSessionReference: string
  verificationUrl: string | null
  expiresAt: Date
}

export interface KycProviderEventInput {
  payload: unknown
}

export interface KycProvider {
  readonly providerName: string
  createVerificationSession(
    input: CreateKycSessionInput,
  ): Promise<CreateKycSessionResult>
  verifyAndNormalizeEvent(
    input: KycProviderEventInput,
  ): Promise<NormalizedKycProviderEvent>
}

export class KycProviderInputError extends Error {
  readonly reasonCode: KycReasonCode

  constructor(message: string, reasonCode: KycReasonCode = 'KYC_EVENT_INVALID') {
    super(message)
    this.name = 'KycProviderInputError'
    this.reasonCode = reasonCode
  }
}

import type { NormalizedKycProviderEvent } from '../domain/KycProviderEvent.js'

export interface CreateKycSessionInput {
  playerId: string
  internalSessionId: string
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
  constructor(message: string) {
    super(message)
    this.name = 'KycProviderInputError'
  }
}

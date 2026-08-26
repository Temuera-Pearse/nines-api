import type { NormalizedCryptoProviderEvent } from '../domain/CryptoProviderEvent.js'

export interface CreateCryptoFundingSessionInput {
  fundingIntentId: string
  playerId: string
  asset: string
  amount: string
  /** Every adapter must map this stable value to its provider idempotency mechanism. */
  idempotencyKey: string
  correlationId: string
}

export interface CreateCryptoFundingSessionResult {
  provider: string
  providerReference: string
  paymentUrl: string | null
}

export interface RawCryptoProviderEvent {
  payload: unknown
  signature: string | null
  /** Exact request bytes for real adapters whose signatures cover the wire payload. */
  rawBody?: Buffer
  /** Ephemeral request headers; adapters must not persist credentials or arbitrary values. */
  headers?: Readonly<Record<string, string | string[] | undefined>>
}

export interface CryptoFundingProvider {
  readonly providerName: string
  createFundingSession(
    input: CreateCryptoFundingSessionInput,
  ): Promise<CreateCryptoFundingSessionResult>
  parseAndVerifyEvent(input: RawCryptoProviderEvent): Promise<NormalizedCryptoProviderEvent>
}

export class CryptoProviderCreationError extends Error {
  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CryptoProviderCreationError'
  }
}

export class CryptoProviderInputError extends Error {
  constructor(
    message: string,
    readonly reasonCode:
      | 'CRYPTO_PROVIDER_EVENT_INVALID'
      | 'CRYPTO_PROVIDER_EVENT_UNAUTHENTICATED' = 'CRYPTO_PROVIDER_EVENT_INVALID',
  ) {
    super(message)
    this.name = 'CryptoProviderInputError'
  }
}

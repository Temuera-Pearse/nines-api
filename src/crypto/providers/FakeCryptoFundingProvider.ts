import { createHash, timingSafeEqual } from 'node:crypto'
import {
  CRYPTO_PROVIDER_EVENT_STATUSES,
  type CryptoProviderEventMetadata,
  type CryptoProviderEventStatus,
  type NormalizedCryptoProviderEvent,
} from '../domain/CryptoProviderEvent.js'
import { normalizeCryptoAsset, parseCryptoAmount } from '../domain/CryptoAmount.js'
import {
  type CreateCryptoFundingSessionInput,
  type CreateCryptoFundingSessionResult,
  type CryptoFundingProvider,
  CryptoProviderInputError,
  type RawCryptoProviderEvent,
} from './CryptoFundingProvider.js'

interface FakeCryptoEventPayload {
  provider?: string
  providerEventId: string
  providerReference: string
  fundingIntentId?: string
  playerId?: string
  eventType: string
  status: CryptoProviderEventStatus
  occurredAt: string
  asset?: string | null
  amount?: string | null
  metadata?: Record<string, unknown>
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function hashCryptoProviderPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function safeRequiredString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
}

function safeOptionalString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value.length <= maximumLength
    ? value
    : undefined
}

function normalizeMetadata(value: unknown): CryptoProviderEventMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const providerTransactionId = safeOptionalString(raw.providerTransactionId, 128)
  const confirmationStage = safeOptionalString(raw.confirmationStage, 64)
  const sequence =
    typeof raw.sequence === 'number' && Number.isSafeInteger(raw.sequence) && raw.sequence >= 0
      ? raw.sequence
      : undefined
  return {
    ...(providerTransactionId ? { providerTransactionId } : {}),
    ...(confirmationStage ? { confirmationStage } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  }
}

export class FakeCryptoFundingProvider implements CryptoFundingProvider {
  readonly providerName = 'fake'
  private readonly sessions = new Map<string, {
    fingerprint: string
    result: CreateCryptoFundingSessionResult
  }>()

  constructor(
    private readonly webhookSecret: string,
    private readonly paymentBaseUrl: string | null = null,
    private readonly beforeCreate: ((input: CreateCryptoFundingSessionInput) => Promise<void> | void) | null = null,
  ) {}

  async createFundingSession(
    input: CreateCryptoFundingSessionInput,
  ): Promise<CreateCryptoFundingSessionResult> {
    if (input.idempotencyKey !== input.fundingIntentId) {
      throw new Error('Fake crypto provider requires the funding intent ID as its idempotency key')
    }
    const fingerprint = hashCryptoProviderPayload({
      fundingIntentId: input.fundingIntentId,
      playerId: input.playerId,
      asset: input.asset,
      amount: input.amount,
    })
    const existing = this.sessions.get(input.idempotencyKey)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error('Fake crypto provider idempotency key was reused with different parameters')
      }
      return existing.result
    }
    await this.beforeCreate?.(input)
    const raced = this.sessions.get(input.idempotencyKey)
    if (raced) {
      if (raced.fingerprint !== fingerprint) {
        throw new Error('Fake crypto provider idempotency key was reused with different parameters')
      }
      return raced.result
    }
    const result: CreateCryptoFundingSessionResult = {
      provider: this.providerName,
      providerReference: `fake-funding-${input.fundingIntentId}`,
      paymentUrl: this.paymentBaseUrl
        ? `${this.paymentBaseUrl}/dev/crypto/funding/${input.fundingIntentId}`
        : null,
    }
    this.sessions.set(input.idempotencyKey, { fingerprint, result })
    return result
  }

  async parseAndVerifyEvent(
    input: RawCryptoProviderEvent,
  ): Promise<NormalizedCryptoProviderEvent> {
    const expected = Buffer.from(this.webhookSecret)
    const actual = Buffer.from(input.signature ?? '')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new CryptoProviderInputError(
        'Fake crypto provider signature is invalid',
        'CRYPTO_PROVIDER_EVENT_UNAUTHENTICATED',
      )
    }
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new CryptoProviderInputError('Fake crypto provider event must be an object')
    }
    const payload = input.payload as Partial<FakeCryptoEventPayload>
    if (
      !safeRequiredString(payload.providerEventId, 128) ||
      !safeRequiredString(payload.providerReference, 256) ||
      !safeRequiredString(payload.eventType, 128) ||
      typeof payload.occurredAt !== 'string' || payload.occurredAt.length > 64 || !payload.occurredAt.trim() ||
      !CRYPTO_PROVIDER_EVENT_STATUSES.includes(payload.status as CryptoProviderEventStatus)
    ) {
      throw new CryptoProviderInputError('Fake crypto provider event structure is invalid')
    }
    if (payload.provider !== undefined && payload.provider !== this.providerName) {
      throw new CryptoProviderInputError('Fake crypto provider identity is invalid')
    }
    if (payload.eventType !== `funding.${payload.status}`) {
      throw new CryptoProviderInputError('Fake crypto provider event type is unsupported')
    }
    const occurredAt = new Date(payload.occurredAt)
    if (Number.isNaN(occurredAt.getTime())) {
      throw new CryptoProviderInputError('Fake crypto provider event timestamp is invalid')
    }
    let asset: string | null = null
    if (payload.asset !== undefined && payload.asset !== null) {
      try {
        asset = normalizeCryptoAsset(payload.asset)
      } catch {
        throw new CryptoProviderInputError('Fake crypto provider event asset is invalid')
      }
    }
    let amount: string | null = null
    if (payload.amount !== undefined && payload.amount !== null) {
      try {
        amount = parseCryptoAmount(payload.amount, 30).canonical
      } catch {
        throw new CryptoProviderInputError('Fake crypto provider event amount is invalid')
      }
    }
    return {
      provider: this.providerName,
      providerEventId: payload.providerEventId,
      providerReference: payload.providerReference,
      claimedFundingIntentId: safeOptionalString(payload.fundingIntentId, 128) ?? null,
      claimedPlayerId: safeOptionalString(payload.playerId, 128) ?? null,
      eventType: payload.eventType,
      status: payload.status as CryptoProviderEventStatus,
      providerOccurredAt: occurredAt,
      asset,
      amount,
      payloadHash: hashCryptoProviderPayload(input.payload),
      metadata: normalizeMetadata(payload.metadata),
    }
  }

  buildEvent(input: {
    providerEventId: string
    providerReference: string
    fundingIntentId?: string | null
    playerId?: string | null
    status: CryptoProviderEventStatus
    occurredAt: Date
    asset?: string | null
    amount?: string | null
    metadata?: Record<string, unknown>
  }): FakeCryptoEventPayload {
    return {
      provider: this.providerName,
      providerEventId: input.providerEventId,
      providerReference: input.providerReference,
      fundingIntentId: input.fundingIntentId ?? undefined,
      playerId: input.playerId ?? undefined,
      eventType: `funding.${input.status}`,
      status: input.status,
      occurredAt: input.occurredAt.toISOString(),
      asset: input.asset ?? null,
      amount: input.amount ?? null,
      metadata: input.metadata ?? {},
    }
  }

  signature(): string {
    return this.webhookSecret
  }
}

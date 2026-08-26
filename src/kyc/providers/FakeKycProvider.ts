import { createHash } from 'node:crypto'
import {
  KYC_EVENT_RESULT_STATUSES,
  normalizeKycProviderEventMetadata,
  type KycEventResultStatus,
  type NormalizedKycProviderEvent,
} from '../domain/KycProviderEvent.js'
import {
  type CreateKycSessionInput,
  type CreateKycSessionResult,
  type KycProvider,
  type KycProviderEventInput,
  KycProviderInputError,
} from './KycProvider.js'

interface FakeEventPayload {
  provider?: string
  playerId?: string
  providerEventId: string
  providerSessionReference: string
  eventType: string
  resultingStatus: KycEventResultStatus
  occurredAt: string
  reasonCode?: string | null
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

export function deterministicPayloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function safeReasonCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

export class FakeKycProvider implements KycProvider {
  readonly providerName = 'fake'
  private readonly createdSessions = new Map<string, CreateKycSessionResult>()

  constructor(
    private readonly sessionTtlMs: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly hostedBaseUrl: string | null = null,
  ) {}

  async createVerificationSession(
    input: CreateKycSessionInput,
  ): Promise<CreateKycSessionResult> {
    if (input.idempotencyKey !== input.internalSessionId) {
      throw new Error('Fake KYC provider requires the internal session ID as its idempotency key')
    }
    const existing = this.createdSessions.get(input.idempotencyKey)
    if (existing) return existing
    const expiresAt = new Date(this.clock().getTime() + this.sessionTtlMs)
    const created = {
      provider: this.providerName,
      providerSessionReference: `fake-session-${input.internalSessionId}`,
      verificationUrl: this.hostedBaseUrl
        ? `${this.hostedBaseUrl}/dev/kyc/mock/${input.internalSessionId}`
        : null,
      expiresAt,
    }
    this.createdSessions.set(input.idempotencyKey, created)
    return created
  }

  async verifyAndNormalizeEvent(
    input: KycProviderEventInput,
  ): Promise<NormalizedKycProviderEvent> {
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new KycProviderInputError('Fake KYC event must be an object')
    }
    const payload = input.payload as Partial<FakeEventPayload>
    if (
      !nonBlank(payload.providerEventId) ||
      !nonBlank(payload.providerSessionReference) ||
      !nonBlank(payload.eventType) ||
      !KYC_EVENT_RESULT_STATUSES.includes(
        payload.resultingStatus as KycEventResultStatus,
      ) ||
      !nonBlank(payload.occurredAt)
    ) {
      throw new KycProviderInputError('Fake KYC event structure is invalid')
    }
    if (payload.provider !== undefined && payload.provider !== this.providerName) {
      throw new KycProviderInputError(
        'Fake KYC event provider does not match the adapter',
        'KYC_PROVIDER_MISMATCH',
      )
    }
    if (payload.eventType !== `verification.${payload.resultingStatus}`) {
      throw new KycProviderInputError('Fake KYC event type is unsupported')
    }
    const occurredAt = new Date(payload.occurredAt)
    if (Number.isNaN(occurredAt.getTime())) {
      throw new KycProviderInputError('Fake KYC event timestamp is invalid')
    }
    const metadata = normalizeKycProviderEventMetadata(payload.metadata)

    return {
      provider: this.providerName,
      providerEventId: payload.providerEventId,
      providerSessionReference: payload.providerSessionReference,
      claimedPlayerReference: nonBlank(payload.playerId) ? payload.playerId : null,
      eventType: payload.eventType,
      resultingStatus: payload.resultingStatus as KycEventResultStatus,
      occurredAt,
      reasonCode: safeReasonCode(payload.reasonCode) ? payload.reasonCode : null,
      payloadHash: deterministicPayloadHash(input.payload),
      metadata,
    }
  }

  buildEvent(input: {
    providerEventId: string
    providerSessionReference: string
    resultingStatus: KycEventResultStatus
    occurredAt: Date
    reasonCode?: string | null
    claimedPlayerReference?: string | null
    metadata?: Record<string, unknown>
  }): FakeEventPayload {
    return {
      provider: this.providerName,
      providerEventId: input.providerEventId,
      providerSessionReference: input.providerSessionReference,
      playerId: input.claimedPlayerReference ?? undefined,
      eventType: `verification.${input.resultingStatus}`,
      resultingStatus: input.resultingStatus,
      occurredAt: input.occurredAt.toISOString(),
      reasonCode: input.reasonCode ?? null,
      metadata: input.metadata ?? {},
    }
  }
}

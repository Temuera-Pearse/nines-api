import { createHash } from 'node:crypto'
import {
  KYC_EVENT_RESULT_STATUSES,
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

export class FakeKycProvider implements KycProvider {
  readonly providerName = 'fake'

  constructor(
    private readonly sessionTtlMs: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly hostedBaseUrl: string | null = null,
  ) {}

  async createVerificationSession(
    input: CreateKycSessionInput,
  ): Promise<CreateKycSessionResult> {
    const expiresAt = new Date(this.clock().getTime() + this.sessionTtlMs)
    return {
      provider: this.providerName,
      providerSessionReference: `fake-session-${input.internalSessionId}`,
      verificationUrl: this.hostedBaseUrl
        ? `${this.hostedBaseUrl}/dev/kyc/mock/${input.internalSessionId}`
        : null,
      expiresAt,
    }
  }

  async verifyAndNormalizeEvent(
    input: KycProviderEventInput,
  ): Promise<NormalizedKycProviderEvent> {
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new KycProviderInputError('Fake KYC event must be an object')
    }
    const payload = input.payload as Partial<FakeEventPayload>
    if (
      (payload.provider !== undefined && payload.provider !== this.providerName) ||
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
    const occurredAt = new Date(payload.occurredAt)
    if (Number.isNaN(occurredAt.getTime())) {
      throw new KycProviderInputError('Fake KYC event timestamp is invalid')
    }
    const metadata =
      payload.metadata &&
      typeof payload.metadata === 'object' &&
      !Array.isArray(payload.metadata)
        ? payload.metadata
        : {}

    return {
      provider: this.providerName,
      providerEventId: payload.providerEventId,
      providerSessionReference: payload.providerSessionReference,
      eventType: payload.eventType,
      resultingStatus: payload.resultingStatus as KycEventResultStatus,
      occurredAt,
      reasonCode: nonBlank(payload.reasonCode) ? payload.reasonCode : null,
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
    metadata?: Record<string, unknown>
  }): FakeEventPayload {
    return {
      provider: this.providerName,
      providerEventId: input.providerEventId,
      providerSessionReference: input.providerSessionReference,
      eventType: `verification.${input.resultingStatus}`,
      resultingStatus: input.resultingStatus,
      occurredAt: input.occurredAt.toISOString(),
      reasonCode: input.reasonCode ?? null,
      metadata: input.metadata ?? {},
    }
  }
}

import { describe, expect, it } from 'vitest'
import type { NormalizedKycProviderEvent } from './KycProviderEvent.js'
import { isStaleKycEvent } from './KycProviderEvent.js'

const event: NormalizedKycProviderEvent = {
  provider: 'fake',
  providerEventId: 'event-1',
  providerSessionReference: 'session-1',
  eventType: 'verification.verified',
  resultingStatus: 'verified',
  occurredAt: new Date('2026-01-02T00:00:00Z'),
  reasonCode: null,
  payloadHash: 'a'.repeat(64),
  metadata: {},
}

describe('KYC event precedence', () => {
  it('accepts a forward event for the current pending session', () => {
    expect(
      isStaleKycEvent({
        event,
        sessionStartedAt: new Date('2026-01-01T00:00:00Z'),
        sessionLastEventAt: null,
        sessionIsCurrent: true,
        sessionStatus: 'pending',
      }),
    ).toBe(false)
  })

  it('rejects obsolete sessions, older timestamps, and terminal sessions', () => {
    expect(
      isStaleKycEvent({
        event,
        sessionStartedAt: new Date('2026-01-01T00:00:00Z'),
        sessionLastEventAt: null,
        sessionIsCurrent: false,
        sessionStatus: 'pending',
      }),
    ).toBe(true)
    expect(
      isStaleKycEvent({
        event,
        sessionStartedAt: new Date('2026-01-01T00:00:00Z'),
        sessionLastEventAt: new Date('2026-01-03T00:00:00Z'),
        sessionIsCurrent: true,
        sessionStatus: 'pending',
      }),
    ).toBe(true)
    expect(
      isStaleKycEvent({
        event,
        sessionStartedAt: new Date('2026-01-01T00:00:00Z'),
        sessionLastEventAt: null,
        sessionIsCurrent: true,
        sessionStatus: 'verified',
      }),
    ).toBe(true)
  })

  it('rejects late pending events after manual review', () => {
    expect(
      isStaleKycEvent({
        event: { ...event, resultingStatus: 'pending' },
        sessionStartedAt: new Date('2026-01-01T00:00:00Z'),
        sessionLastEventAt: null,
        sessionIsCurrent: true,
        sessionStatus: 'manual_review',
      }),
    ).toBe(true)
  })
})

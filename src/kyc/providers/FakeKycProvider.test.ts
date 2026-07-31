import { describe, expect, it } from 'vitest'
import { FakeKycProvider, deterministicPayloadHash } from './FakeKycProvider.js'

const now = new Date('2026-07-23T10:00:00Z')
const provider = new FakeKycProvider(
  60 * 60_000,
  () => now,
  'http://localhost:3002',
)

describe('FakeKycProvider', () => {
  it('creates deterministic local sessions without network calls', async () => {
    await expect(
      provider.createVerificationSession({
        playerId: 'player-1',
        internalSessionId: 'session-1',
        correlationId: 'corr-1',
      }),
    ).resolves.toEqual({
      provider: 'fake',
      providerSessionReference: 'fake-session-session-1',
      verificationUrl: 'http://localhost:3002/dev/kyc/mock/session-1',
      expiresAt: new Date('2026-07-23T11:00:00Z'),
    })
  })

  it('omits a hosted URL when the development route is disabled', async () => {
    const disabled = new FakeKycProvider(60 * 60_000, () => now)
    await expect(
      disabled.createVerificationSession({
        playerId: 'player-1',
        internalSessionId: 'session-1',
        correlationId: 'corr-1',
      }),
    ).resolves.toMatchObject({ verificationUrl: null })
  })

  it.each(['pending', 'verified', 'failed', 'manual_review', 'expired'] as const)(
    'normalizes a deterministic %s event',
    async (resultingStatus) => {
      const payload = provider.buildEvent({
        providerEventId: `event-${resultingStatus}`,
        providerSessionReference: 'fake-session-session-1',
        resultingStatus,
        occurredAt: now,
        metadata: { caseId: 'case-1' },
      })
      const normalized = await provider.verifyAndNormalizeEvent({ payload })
      expect(normalized).toMatchObject({
        provider: 'fake',
        providerEventId: `event-${resultingStatus}`,
        resultingStatus,
        occurredAt: now,
      })
      expect(normalized.payloadHash).toBe(deterministicPayloadHash(payload))
    },
  )

  it('hashes equivalent objects independently of key ordering', () => {
    expect(deterministicPayloadHash({ b: 2, a: 1 })).toBe(
      deterministicPayloadHash({ a: 1, b: 2 }),
    )
  })

  it('rejects malformed, mismatched, and invalid-status events', async () => {
    await expect(provider.verifyAndNormalizeEvent({ payload: null })).rejects.toThrow(
      'must be an object',
    )
    await expect(
      provider.verifyAndNormalizeEvent({
        payload: {
          provider: 'other',
          providerEventId: 'event',
          providerSessionReference: 'session',
          eventType: 'verification.verified',
          resultingStatus: 'verified',
          occurredAt: now.toISOString(),
        },
      }),
    ).rejects.toThrow('structure is invalid')
  })
})

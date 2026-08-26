import { describe, expect, it } from 'vitest'
import { FakeCryptoFundingProvider } from './FakeCryptoFundingProvider.js'

const provider = new FakeCryptoFundingProvider('development-secret-123')

describe('FakeCryptoFundingProvider', () => {
  it('actively enforces and replays provider-side idempotency', async () => {
    const input = { fundingIntentId: 'intent-1', playerId: 'player-1', asset: 'USDC', amount: '100',
      idempotencyKey: 'intent-1', correlationId: 'corr-1' }
    const results = await Promise.all(Array.from({ length: 10 }, () => provider.createFundingSession(input)))
    expect(new Set(results.map((result) => result.providerReference))).toEqual(new Set(['fake-funding-intent-1']))
    expect(results.every((result) => result === results[0])).toBe(true)
    await expect(provider.createFundingSession({ ...input, idempotencyKey: 'wrong' })).rejects.toThrow(/funding intent ID/)
    await expect(provider.createFundingSession({ ...input, amount: '101' })).rejects.toThrow(/different parameters/)
  })
  it('authenticates, normalizes, and allowlists callback metadata', async () => {
    const payload = provider.buildEvent({ providerEventId: 'event-1', providerReference: 'reference-1',
      status: 'confirmed', occurredAt: new Date('2026-08-01T00:00:00Z'), asset: 'usdc', amount: '100.00',
      metadata: { providerTransactionId: 'tx-1', sequence: 2, privateKey: 'must-not-survive', arbitrary: 'drop' } })
    await expect(provider.parseAndVerifyEvent({ payload, signature: provider.signature() })).resolves.toMatchObject({
      asset: 'USDC', amount: '100', metadata: { providerTransactionId: 'tx-1', sequence: 2 },
    })
    await expect(provider.parseAndVerifyEvent({ payload, signature: 'wrong-secret-value-1' })).rejects.toMatchObject({
      reasonCode: 'CRYPTO_PROVIDER_EVENT_UNAUTHENTICATED',
    })
  })

  it('makes provider failure and in-flight creation races deterministic', async () => {
    const timeout = new FakeCryptoFundingProvider(
      'development-secret-123',
      null,
      () => { throw new Error('simulated provider timeout') },
    )
    const input = { fundingIntentId: 'intent-timeout', playerId: 'player-1', asset: 'USDC', amount: '100',
      idempotencyKey: 'intent-timeout', correlationId: 'corr-timeout' }
    await expect(timeout.createFundingSession(input)).rejects.toThrow('simulated provider timeout')

    let release!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const concurrent = new FakeCryptoFundingProvider(
      'development-secret-123',
      null,
      async () => { signalStarted(); await gate },
    )
    const creations = Array.from({ length: 8 }, () => concurrent.createFundingSession({
      ...input,
      fundingIntentId: 'intent-race',
      idempotencyKey: 'intent-race',
    }))
    await started
    release()
    const results = await Promise.all(creations)
    expect(new Set(results.map((result) => result.providerReference))).toEqual(
      new Set(['fake-funding-intent-race']),
    )
    expect(results.every((result) => result === results[0])).toBe(true)
  })

  it('rejects malformed normalized values before persistence', async () => {
    const invalidAmount = provider.buildEvent({ providerEventId: 'event-invalid-amount',
      providerReference: 'reference-1', status: 'confirmed',
      occurredAt: new Date('2026-08-01T00:00:00Z'), asset: 'USDC', amount: '1e3' })
    await expect(provider.parseAndVerifyEvent({ payload: invalidAmount, signature: provider.signature() }))
      .rejects.toMatchObject({ reasonCode: 'CRYPTO_PROVIDER_EVENT_INVALID' })
  })
})

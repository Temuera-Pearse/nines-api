import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresAuditRepository } from '../src/audit/PostgresAuditRepository.js'
import { CreateCryptoFundingIntentService, type CryptoAssetPolicy } from '../src/crypto/application/CreateCryptoFundingIntentService.js'
import { ExpireCryptoFundingIntentsService } from '../src/crypto/application/ExpireCryptoFundingIntentsService.js'
import { ProcessCryptoProviderEventService } from '../src/crypto/application/ProcessCryptoProviderEventService.js'
import { TransitionCryptoFundingService } from '../src/crypto/application/TransitionCryptoFundingService.js'
import { PostgresCryptoFundingRepository } from '../src/crypto/infrastructure/PostgresCryptoFundingRepository.js'
import { FakeCryptoFundingProvider } from '../src/crypto/providers/FakeCryptoFundingProvider.js'
import { CryptoProviderCreationError, type CryptoFundingProvider } from '../src/crypto/providers/CryptoFundingProvider.js'
import { EvaluateEligibilityService } from '../src/eligibility/application/EvaluateEligibilityService.js'
import { PostgresEligibilityDecisionRepository } from '../src/eligibility/infrastructure/PostgresEligibilityDecisionRepository.js'
import { PostgresRestrictionRepository } from '../src/eligibility/infrastructure/PostgresRestrictionRepository.js'
import { TransitionKycStatusService } from '../src/kyc/application/TransitionKycStatusService.js'
import { PostgresKycManualReviewRepository } from '../src/kyc/infrastructure/PostgresKycManualReviewRepository.js'
import { PostgresKycProfileRepository } from '../src/kyc/infrastructure/PostgresKycProfileRepository.js'
import { PostgresKycStatusReader } from '../src/kyc/infrastructure/PostgresKycStatusReader.js'
import { PostgresKycStatusTransitionRepository } from '../src/kyc/infrastructure/PostgresKycStatusTransitionRepository.js'
import { PostgresPlayerRepository } from '../src/players/infrastructure/PostgresPlayerRepository.js'
import { createTestPool, resetAndMigrateTestDatabase, truncatePhase1Tables } from './support/database.js'
import { withTransaction } from '../src/shared/db/transaction.js'

let pool: Pool
let now = new Date('2026-08-10T10:00:00Z')
const WEBHOOK_SECRET = 'integration-secret-123'
const policy: CryptoAssetPolicy = { asset: 'USDC', decimals: 6, minimumAmount: '1', maximumAmount: '100000' }
const audit = new PostgresAuditRepository()
const repository = new PostgresCryptoFundingRepository()
const players = new PostgresPlayerRepository()
const provider = new FakeCryptoFundingProvider(WEBHOOK_SECRET)
const actor = (correlationId: string) => ({ actorType: 'PLAYER' as const, actorId: 'auth0|crypto-player', correlationId })
const providerActor = (correlationId: string) => ({ actorType: 'PROVIDER' as const, actorId: 'fake', correlationId })

function transitionService() { return new TransitionCryptoFundingService(repository, audit, () => now) }
function eligibility() {
  const profiles = new PostgresKycProfileRepository()
  const kycTransition = new TransitionKycStatusService(profiles, new PostgresKycStatusTransitionRepository(),
    new PostgresKycManualReviewRepository(), audit, () => now)
  return new EvaluateEligibilityService(pool, new PostgresRestrictionRepository(),
    new PostgresEligibilityDecisionRepository(), audit,
    new PostgresKycStatusReader(pool, profiles, audit, kycTransition, () => now), () => now)
}
function createService(cryptoProvider: CryptoFundingProvider = provider) {
  return new CreateCryptoFundingIntentService(pool, players, repository, transitionService(), audit,
    eligibility(), cryptoProvider, true, [policy], 60 * 60_000, () => now)
}
function eventService() {
  return new ProcessCryptoProviderEventService(pool, repository, transitionService(), audit,
    provider, [policy], 5 * 60_000, () => now)
}
function expiryService(batchSize = 100) {
  return new ExpireCryptoFundingIntentsService(pool, repository, transitionService(), audit, batchSize)
}

async function createPlayer(options: { active?: boolean; verified?: boolean } = {}): Promise<string> {
  const playerId = randomUUID()
  await pool.query(`INSERT INTO players (id, account_status) VALUES ($1, $2)`,
    [playerId, options.active === false ? 'restricted' : 'active'])
  if (options.verified !== false) {
    await pool.query(`INSERT INTO player_kyc_profiles
      (id, player_id, status, verified_at, expires_at)
      VALUES ($1, $2, 'verified', $3, $4)`,
      [randomUUID(), playerId, now, new Date(now.getTime() + 24 * 60 * 60_000)])
  }
  return playerId
}

async function createIntent(playerId: string, key = randomUUID(), amount = '100') {
  return createService().execute({ playerId, asset: 'USDC', amount, idempotencyKey: key }, actor(`corr-create-${key}`))
}

async function providerEvent(intent: Awaited<ReturnType<typeof createIntent>>, status: 'payment_detected' | 'confirming' | 'confirmed' | 'failed' | 'expired',
  eventId: string, overrides: { occurredAt?: Date; asset?: string | null; amount?: string | null; playerId?: string | null; fundingIntentId?: string | null } = {}) {
  const payload = provider.buildEvent({ providerEventId: eventId,
    providerReference: intent.provider.sessionReference!, fundingIntentId: overrides.fundingIntentId ?? intent.id,
    playerId: overrides.playerId, status, occurredAt: overrides.occurredAt ?? now,
    asset: overrides.asset === undefined ? intent.asset : overrides.asset,
    amount: overrides.amount === undefined ? intent.amount : overrides.amount,
    metadata: { providerTransactionId: `tx-${eventId}`, sequence: 1, privateKey: 'never-store' } })
  return eventService().execute({ payload, signature: WEBHOOK_SECRET }, providerActor(`corr-event-${eventId}`))
}

beforeAll(async () => { pool = createTestPool(); await resetAndMigrateTestDatabase(pool) })
beforeEach(async () => { now = new Date('2026-08-10T10:00:00Z'); await truncatePhase1Tables(pool) })
afterAll(async () => { await pool.end() })

describe('crypto funding creation and idempotency', () => {
  it('creates one logical provider session for concurrent equivalent requests', async () => {
    const playerId = await createPlayer()
    const results = await Promise.all(Array.from({ length: 10 }, () => createIntent(playerId, 'same-key')))
    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    expect(results.every((result) => result.status === 'awaiting_payment')).toBe(true)
    const counts = await pool.query<{ intents: number; sessions: number }>(
      `SELECT (SELECT COUNT(*)::int FROM crypto_funding_intents) AS intents,
              (SELECT COUNT(*)::int FROM crypto_funding_provider_sessions) AS sessions`)
    expect(counts.rows[0]).toEqual({ intents: 1, sessions: 1 })
  })

  it('returns the same intent for equivalent input and conflicts for changed input', async () => {
    const playerId = await createPlayer()
    const first = await createIntent(playerId, 'stable-key', '100.00')
    await expect(createIntent(playerId, 'stable-key', '100')).resolves.toEqual(first)
    await expect(createIntent(playerId, 'stable-key', '101')).rejects.toMatchObject({ code: 'CRYPTO_IDEMPOTENCY_CONFLICT', status: 409 })
  })

  it('denies restricted, KYC-required, and jurisdiction-blocked players', async () => {
    const restricted = await createPlayer({ active: false })
    await expect(createIntent(restricted, 'restricted')).rejects.toMatchObject({
      code: 'CRYPTO_FUNDING_NOT_PERMITTED',
      publicDetails: { reasonCodes: ['ACCOUNT_RESTRICTED'] },
    })
    const noKyc = await createPlayer({ verified: false })
    await expect(createIntent(noKyc, 'no-kyc')).rejects.toMatchObject({
      code: 'CRYPTO_FUNDING_NOT_PERMITTED',
      publicDetails: { reasonCodes: ['KYC_NOT_VERIFIED'] },
    })
    const blocked = await createPlayer()
    await pool.query(`INSERT INTO player_restrictions
      (id, player_id, restriction_type, reason_code, source, starts_at)
      VALUES ($1,$2,'jurisdiction_blocked','TEST_BLOCK','test',$3)`, [randomUUID(), blocked, now])
    await expect(createIntent(blocked, 'blocked')).rejects.toMatchObject({
      code: 'CRYPTO_FUNDING_NOT_PERMITTED',
      publicDetails: { reasonCodes: ['JURISDICTION_BLOCKED'] },
    })
  })

  it('replays a safe creation failure for the original key and allows a new key', async () => {
    const playerId = await createPlayer()
    let calls = 0
    const unavailable: CryptoFundingProvider = { providerName: 'fake',
      async createFundingSession() { calls += 1; throw new CryptoProviderCreationError('provider rejected creation', false) },
      parseAndVerifyEvent: (input) => provider.parseAndVerifyEvent(input) }
    const service = createService(unavailable)
    for (let index = 0; index < 2; index += 1) {
      await expect(service.execute({ playerId, asset: 'USDC', amount: '100', idempotencyKey: 'failed-key' }, actor(`corr-failed-${index}`)))
        .rejects.toMatchObject({ code: 'CRYPTO_FUNDING_CREATION_FAILED', status: 503 })
    }
    expect(calls).toBe(1)
    await expect(createIntent(playerId, 'new-key')).resolves.toMatchObject({ status: 'awaiting_payment' })
  })

  it('safely retries an ambiguous provider timeout with the same internal intent', async () => {
    const playerId = await createPlayer()
    let calls = 0
    const timeoutThenSuccess: CryptoFundingProvider = {
      providerName: 'fake',
      async createFundingSession(input) {
        calls += 1
        if (calls === 1) throw new CryptoProviderCreationError('simulated timeout', true)
        return provider.createFundingSession(input)
      },
      parseAndVerifyEvent: (input) => provider.parseAndVerifyEvent(input),
    }
    const service = createService(timeoutThenSuccess)
    const input = { playerId, asset: 'USDC', amount: '100', idempotencyKey: 'timeout-key' }
    await expect(service.execute(input, actor('corr-timeout-1')))
      .rejects.toMatchObject({ code: 'CRYPTO_PROVIDER_UNAVAILABLE', status: 503 })
    const recovered = await service.execute(input, actor('corr-timeout-2'))
    expect(recovered.status).toBe('awaiting_payment')
    expect(calls).toBe(2)
    expect((await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM crypto_funding_intents WHERE player_id = $1`,
      [playerId],
    )).rows[0].count).toBe(1)
  })
})

describe('crypto provider events, confirmation, and reconciliation', () => {
  it('recovers a callback that races provider-session response persistence', async () => {
    const playerId = await createPlayer()
    let release!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const delayedProvider = new FakeCryptoFundingProvider(WEBHOOK_SECRET, null, async () => {
      signalStarted()
      await gate
    })
    const creation = createService(delayedProvider).execute(
      { playerId, asset: 'USDC', amount: '100', idempotencyKey: 'callback-before-response' },
      actor('corr-callback-before-response'),
    )
    await started
    const pending = await pool.query<{ id: string }>(
      `SELECT id FROM crypto_funding_intents WHERE player_id = $1`,
      [playerId],
    )
    const intentId = pending.rows[0].id
    const payload = provider.buildEvent({
      providerEventId: 'callback-before-response-event',
      providerReference: `fake-funding-${intentId}`,
      fundingIntentId: intentId,
      playerId,
      status: 'confirmed',
      occurredAt: now,
      asset: 'USDC',
      amount: '100',
    })
    try {
      await expect(eventService().execute(
        { payload, signature: WEBHOOK_SECRET },
        providerActor('corr-callback-before-response-event'),
      )).resolves.toMatchObject({ processingStatus: 'processed', fundingStatus: 'confirmed' })
    } finally {
      release()
    }
    await expect(creation).resolves.toMatchObject({ id: intentId, status: 'confirmed' })
    const effects = await pool.query<{ sessions: number; instructions: number }>(
      `SELECT
        (SELECT COUNT(*)::int FROM crypto_funding_provider_sessions
         WHERE funding_intent_id = $1 AND status = 'active') AS sessions,
        (SELECT COUNT(*)::int FROM financial_funding_instructions
         WHERE funding_intent_id = $1) AS instructions`,
      [intentId],
    )
    expect(effects.rows[0]).toEqual({ sessions: 1, instructions: 1 })
  })

  it('keeps detection and confirmation distinct and creates one funding instruction', async () => {
    const intent = await createIntent(await createPlayer(), 'progression')
    await expect(providerEvent(intent, 'payment_detected', 'event-detected')).resolves.toMatchObject({ fundingStatus: 'detected' })
    now = new Date(now.getTime() + 1_000)
    await expect(providerEvent(intent, 'confirming', 'event-confirming')).resolves.toMatchObject({ fundingStatus: 'confirming' })
    now = new Date(now.getTime() + 1_000)
    const confirmed = await providerEvent(intent, 'confirmed', 'event-confirmed')
    expect(confirmed.fundingStatus).toBe('confirmed')
    const duplicate = await providerEvent(intent, 'confirmed', 'event-confirmed')
    expect(duplicate.processingStatus).toBe('ignored_duplicate')
    now = new Date(now.getTime() + 1_000)
    const laterConfirmation = await providerEvent(intent, 'confirmed', 'event-confirmed-later')
    expect(laterConfirmation.processingStatus).toBe('ignored_stale')
    const counts = await pool.query<{ instructions: number; transitions: number }>(
      `SELECT (SELECT COUNT(*)::int FROM financial_funding_instructions WHERE funding_intent_id = $1) AS instructions,
              (SELECT COUNT(*)::int FROM crypto_funding_transitions WHERE funding_intent_id = $1) AS transitions`, [intent.id])
    expect(counts.rows[0]).toEqual({ instructions: 1, transitions: 4 })
  })

  it('converges concurrent duplicate callbacks and ignores stale ordering', async () => {
    const intent = await createIntent(await createPlayer(), 'event-concurrency')
    const results = await Promise.all(Array.from({ length: 8 }, () => providerEvent(intent, 'payment_detected', 'same-event')))
    expect(results.filter((result) => result.processingStatus === 'processed')).toHaveLength(1)
    expect(results.filter((result) => result.processingStatus === 'ignored_duplicate')).toHaveLength(7)
    now = new Date(now.getTime() + 2_000)
    await providerEvent(intent, 'confirming', 'newer-event')
    const stale = await providerEvent(intent, 'payment_detected', 'older-event', { occurredAt: new Date(now.getTime() - 1_000) })
    expect(stale.processingStatus).toBe('ignored_stale')
  })

  it('ignores a first callback whose provider time predates the intent', async () => {
    const intent = await createIntent(await createPlayer(), 'predated-event')
    const stale = await providerEvent(intent, 'confirmed', 'predated-confirmation', {
      occurredAt: new Date(intent.createdAt.getTime() - 1),
    })
    expect(stale).toMatchObject({ processingStatus: 'ignored_stale', fundingStatus: 'awaiting_payment' })
  })

  it('rejects future, unknown-reference, and ownership-conflict events durably', async () => {
    const intent = await createIntent(await createPlayer(), 'security-events')
    const future = await providerEvent(intent, 'confirmed', 'future-event', { occurredAt: new Date(now.getTime() + 5 * 60_000 + 1) })
    expect(future).toMatchObject({ processingStatus: 'rejected', reasonCode: 'CRYPTO_PROVIDER_EVENT_FUTURE_TIMESTAMP' })
    const unknownPayload = provider.buildEvent({ providerEventId: 'unknown-event', providerReference: 'missing-reference',
      status: 'confirmed', occurredAt: now, asset: 'USDC', amount: '100' })
    await expect(eventService().execute({ payload: unknownPayload, signature: WEBHOOK_SECRET }, providerActor('corr-unknown')))
      .resolves.toMatchObject({ reasonCode: 'CRYPTO_PROVIDER_REFERENCE_UNKNOWN' })
    const ownership = await providerEvent(intent, 'confirmed', 'ownership-event', { playerId: randomUUID() })
    expect(ownership.reasonCode).toBe('CRYPTO_PROVIDER_OWNERSHIP_MISMATCH')
    const audits = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM audit_events
      WHERE action = 'crypto.provider_event_rejected'`)
    expect(audits.rows[0].count).toBeGreaterThanOrEqual(3)
  })

  it.each([
    ['ASSET_MISMATCH', 'BTC', '100'],
    ['UNDERPAID', 'USDC', '99'],
    ['OVERPAID', 'USDC', '101'],
    ['AMOUNT_UNDETERMINED', 'USDC', null],
  ] as const)('records %s instead of creating a credit instruction', async (type, asset, amount) => {
    const intent = await createIntent(await createPlayer(), `mismatch-${type}`)
    const result = await providerEvent(intent, 'confirmed', `event-${type}`, { asset, amount })
    expect(result.processingStatus).toBe('rejected')
    const reconciliations = await pool.query<{ discrepancy_type: string }>(
      `SELECT discrepancy_type FROM crypto_funding_reconciliations WHERE funding_intent_id = $1`, [intent.id])
    expect(reconciliations.rows).toEqual([{ discrepancy_type: type }])
    const instructions = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM financial_funding_instructions WHERE funding_intent_id = $1`, [intent.id])
    expect(instructions.rows[0].count).toBe(0)
  })

  it('rolls confirmation back atomically when instruction persistence fails', async () => {
    const intent = await createIntent(await createPlayer(), 'rollback-confirmation')
    await pool.query(`ALTER TABLE financial_funding_instructions
      ADD CONSTRAINT crypto_test_force_instruction_failure CHECK (funding_intent_id IS NULL)`)
    try {
      await expect(providerEvent(intent, 'confirmed', 'rollback-event')).rejects.toMatchObject({ code: '23514' })
    } finally {
      await pool.query(`ALTER TABLE financial_funding_instructions DROP CONSTRAINT crypto_test_force_instruction_failure`)
    }
    expect((await repository.findById(intent.id, pool))?.status).toBe('awaiting_payment')
    expect(await repository.findEvent('fake', 'rollback-event', pool)).toBeNull()
  })

  it('enforces transition and financial-instruction coupling in PostgreSQL', async () => {
    const intent = await createIntent(await createPlayer(), 'database-guards')
    await expect(pool.query(
      `UPDATE crypto_funding_intents
       SET status = 'confirmed', confirmed_at = $2, version = version + 1, updated_at = $2
       WHERE id = $1`,
      [intent.id, now],
    )).rejects.toMatchObject({ code: '23514' })
    expect((await repository.findById(intent.id, pool))?.status).toBe('awaiting_payment')

    await expect(withTransaction(pool, async (client) => {
      const before = await repository.findByIdForUpdate(intent.id, client)
      if (!before) throw new Error('Test funding intent disappeared')
      await repository.updateStatus({
        intentId: before.id,
        expectedVersion: before.version,
        status: 'confirmed',
        confirmedAt: now,
      }, client)
      await repository.appendTransition({
        id: randomUUID(), intent: before, newStatus: 'confirmed', trigger: 'TEST_BYPASS',
        reasonCode: 'CRYPTO_PAYMENT_CONFIRMED', actorType: 'SYSTEM', actorId: 'test',
        providerEventRecordId: null, correlationId: 'corr-database-guard', createdAt: now,
      }, client)
    })).rejects.toMatchObject({ code: '23514' })
    expect((await repository.findById(intent.id, pool))?.status).toBe('awaiting_payment')
  })
})

describe('crypto funding expiry', () => {
  it('retains the provider reference when creation finishes after internal expiry', async () => {
    const playerId = await createPlayer()
    let release!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const delayedProvider = new FakeCryptoFundingProvider(WEBHOOK_SECRET, null, async () => {
      signalStarted()
      await gate
    })
    const creation = createService(delayedProvider).execute(
      { playerId, asset: 'USDC', amount: '100', idempotencyKey: 'provider-call-expiry' },
      actor('corr-provider-call-expiry'),
    )
    await started
    const pending = await pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM crypto_funding_intents WHERE player_id = $1`,
      [playerId],
    )
    now = pending.rows[0].expires_at
    try {
      await expect(expiryService().execute(now, {
        actorType: 'SYSTEM', actorId: 'expiry-worker', correlationId: 'corr-provider-call-expired',
      })).resolves.toMatchObject({ expired: 1 })
    } finally {
      release()
    }
    const expired = await creation
    expect(expired).toMatchObject({ status: 'expired' })
    expect(expired.provider.sessionReference).toMatch(/^fake-funding-/)
    await expect(providerEvent(expired, 'confirmed', 'provider-call-expired-confirmation', {
      occurredAt: now,
    })).resolves.toMatchObject({ processingStatus: 'ignored_expired', fundingStatus: 'expired' })
    const reconciliations = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM crypto_funding_reconciliations
       WHERE funding_intent_id = $1 AND discrepancy_type = 'PAYMENT_AFTER_EXPIRY'`,
      [expired.id],
    )
    expect(reconciliations.rows[0].count).toBe(1)
  })

  it('does not revive an expired payment and records late external value', async () => {
    const intent = await createIntent(await createPlayer(), 'late-payment')
    now = intent.expiresAt
    const result = await providerEvent(intent, 'confirmed', 'late-confirmation', { occurredAt: now })
    expect(result).toMatchObject({ processingStatus: 'ignored_expired', fundingStatus: 'expired' })
    const reconciliation = await pool.query<{ discrepancy_type: string }>(
      `SELECT discrepancy_type FROM crypto_funding_reconciliations WHERE funding_intent_id = $1`, [intent.id])
    expect(reconciliation.rows).toEqual([{ discrepancy_type: 'PAYMENT_AFTER_EXPIRY' }])
  })

  it('is repeatable and safe across concurrent expiry workers', async () => {
    const intent = await createIntent(await createPlayer(), 'expiry-worker')
    now = intent.expiresAt
    const results = await Promise.all([
      expiryService().execute(now, { actorType: 'SYSTEM', actorId: 'worker-1', correlationId: 'corr-worker-1' }),
      expiryService().execute(now, { actorType: 'SYSTEM', actorId: 'worker-2', correlationId: 'corr-worker-2' }),
    ])
    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(1)
    await expect(expiryService().execute(now, { actorType: 'SYSTEM', actorId: 'worker-3', correlationId: 'corr-worker-3' }))
      .resolves.toEqual({ examined: 0, expired: 0, reconciliations: 0 })
  })

  it('serializes a callback racing the expiry worker without reviving the intent', async () => {
    const intent = await createIntent(await createPlayer(), 'expiry-callback-race')
    now = intent.expiresAt
    const [callback, expiry] = await Promise.all([
      providerEvent(intent, 'confirmed', 'racing-confirmation', { occurredAt: now }),
      expiryService().execute(now, {
        actorType: 'SYSTEM', actorId: 'racing-worker', correlationId: 'corr-racing-worker',
      }),
    ])
    expect(callback).toMatchObject({ processingStatus: 'ignored_expired', fundingStatus: 'expired' })
    expect(expiry.expired).toBeGreaterThanOrEqual(0)
    expect(expiry.expired).toBeLessThanOrEqual(1)
    expect((await repository.findById(intent.id, pool))?.status).toBe('expired')
    const effects = await pool.query<{ reconciliations: number; instructions: number }>(
      `SELECT
        (SELECT COUNT(*)::int FROM crypto_funding_reconciliations
         WHERE funding_intent_id = $1 AND discrepancy_type = 'PAYMENT_AFTER_EXPIRY') AS reconciliations,
        (SELECT COUNT(*)::int FROM financial_funding_instructions
         WHERE funding_intent_id = $1) AS instructions`,
      [intent.id],
    )
    expect(effects.rows[0]).toEqual({ reconciliations: 1, instructions: 0 })
  })
})

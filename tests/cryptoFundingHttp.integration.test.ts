import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { AuthenticatedIdentity } from '../src/auth/AuthenticatedIdentity.js'
import type { VerifyBearerToken } from '../src/auth/auth0Jwt.js'
import { loadConfig } from '../src/config/config.js'
import { FakeCryptoFundingProvider } from '../src/crypto/providers/FakeCryptoFundingProvider.js'
import { createSilentLogger } from '../src/shared/observability/logger.js'
import { createTestPool, resetAndMigrateTestDatabase, truncatePhase1Tables } from './support/database.js'

let pool: Pool
let now = new Date('2026-08-10T10:00:00Z')
const secret = 'http-integration-secret-123'
const identity: AuthenticatedIdentity = {
  provider: 'auth0', issuer: 'https://tenant.example.auth0.com/', subject: 'auth0|crypto-http',
  email: 'crypto-http@example.com', emailVerified: true, displayName: 'Crypto HTTP', tokenType: 'human',
}
const verifier: VerifyBearerToken = async () => identity
const config = loadConfig({
  NODE_ENV: 'test', AUTH0_ISSUER: identity.issuer, AUTH0_AUDIENCE: 'https://nines-api.example',
  CORS_ORIGIN: 'https://app.example', CRYPTO_FUNDING_ENABLED: 'true', CRYPTO_PROVIDER: 'fake',
  CRYPTO_FAKE_WEBHOOK_SECRET: secret, CRYPTO_SUPPORTED_ASSETS: 'USDC:6',
})
const fakeProvider = new FakeCryptoFundingProvider(secret)
const auth = { Authorization: 'Bearer token' }

function app() { return createApp({ config, pool, logger: createSilentLogger(), verifyBearerToken: verifier, clock: () => now, cryptoFundingProvider: fakeProvider }) }

async function seedEligibleIdentity(): Promise<string> {
  const playerId = randomUUID()
  await pool.query(`INSERT INTO players (id, email, account_status) VALUES ($1,$2,'active')`, [playerId, identity.email])
  await pool.query(`INSERT INTO authentication_identities
    (id, player_id, provider, issuer, subject) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), playerId, identity.provider, identity.issuer, identity.subject])
  await pool.query(`INSERT INTO player_kyc_profiles
    (id, player_id, status, verified_at, expires_at) VALUES ($1,$2,'verified',$3,$4)`,
    [randomUUID(), playerId, now, new Date(now.getTime() + 24 * 60 * 60_000)])
  return playerId
}

beforeAll(async () => { pool = createTestPool(); await resetAndMigrateTestDatabase(pool) })
beforeEach(async () => { now = new Date('2026-08-10T10:00:00Z'); await truncatePhase1Tables(pool) })
afterAll(async () => { await pool.end() })

describe('crypto funding HTTP boundary', () => {
  it('requires idempotency, exposes only safe fields, and supports owned list/get', async () => {
    await seedEligibleIdentity()
    const missingKey = await request(app()).post('/v1/crypto/funding-intents').set(auth).send({ asset: 'USDC', amount: '100' })
    expect(missingKey.status).toBe(400)
    expect(missingKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    const created = await request(app()).post('/v1/crypto/funding-intents').set(auth)
      .set('Idempotency-Key', 'http-crypto-key').send({ asset: 'USDC', amount: '100.00' })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ status: 'awaiting_payment', asset: 'USDC', amount: '100', provider: { type: 'fake' } })
    expect(created.body.createdAt).toBe(now.toISOString())
    const serialized = JSON.stringify(created.body)
    for (const forbidden of ['idempotencyKey', 'requestHash', 'webhook', 'secret', 'privateKey', 'metadata']) expect(serialized).not.toContain(forbidden)
    const listed = await request(app()).get('/v1/crypto/funding-intents').set(auth)
    expect(listed.body.items).toHaveLength(1)
    const fetched = await request(app()).get(`/v1/crypto/funding-intents/${created.body.id}`).set(auth)
    expect(fetched.body).toEqual(created.body)
  })

  it('authenticates callbacks and confirms through the provider-neutral route', async () => {
    await seedEligibleIdentity()
    const created = await request(app()).post('/v1/crypto/funding-intents').set(auth)
      .set('Idempotency-Key', 'http-confirm-key').send({ asset: 'USDC', amount: '25' })
    const payload = fakeProvider.buildEvent({ providerEventId: 'http-confirm-event',
      providerReference: created.body.provider.sessionReference, fundingIntentId: created.body.id,
      status: 'confirmed', occurredAt: now, asset: 'USDC', amount: '25' })
    const unauthenticated = await request(app()).post('/internal/provider-events/crypto/fake').send(payload)
    expect(unauthenticated.status).toBe(401)
    const confirmed = await request(app()).post('/internal/provider-events/crypto/fake')
      .set('X-Crypto-Provider-Signature', secret).send(payload)
    expect(confirmed.status).toBe(200)
    expect(confirmed.body).toMatchObject({ processingStatus: 'processed', fundingStatus: 'confirmed' })
    const fetched = await request(app()).get(`/v1/crypto/funding-intents/${created.body.id}`).set(auth)
    expect(fetched.body.status).toBe('confirmed')
  })
})

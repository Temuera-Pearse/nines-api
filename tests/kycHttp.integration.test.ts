import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { PostgresAuditRepository } from '../src/audit/PostgresAuditRepository.js'
import type { AuthenticatedIdentity } from '../src/auth/AuthenticatedIdentity.js'
import { AuthError } from '../src/auth/AuthError.js'
import type { VerifyBearerToken } from '../src/auth/auth0Jwt.js'
import { loadConfig } from '../src/config/config.js'
import { PlayerRestrictionService } from '../src/eligibility/application/PlayerRestrictionService.js'
import { PostgresRestrictionRepository } from '../src/eligibility/infrastructure/PostgresRestrictionRepository.js'
import { ProcessKycProviderEventService } from '../src/kyc/application/ProcessKycProviderEventService.js'
import { PostgresKycProfileRepository } from '../src/kyc/infrastructure/PostgresKycProfileRepository.js'
import { PostgresKycProviderEventRepository } from '../src/kyc/infrastructure/PostgresKycProviderEventRepository.js'
import { PostgresKycSessionRepository } from '../src/kyc/infrastructure/PostgresKycSessionRepository.js'
import { PostgresKycStatusTransitionRepository } from '../src/kyc/infrastructure/PostgresKycStatusTransitionRepository.js'
import { FakeKycProvider } from '../src/kyc/providers/FakeKycProvider.js'
import { ChangeAccountStatusService } from '../src/players/application/ChangeAccountStatusService.js'
import { PostgresAccountStatusTransitionRepository } from '../src/players/infrastructure/PostgresAccountStatusTransitionRepository.js'
import { PostgresPlayerRepository } from '../src/players/infrastructure/PostgresPlayerRepository.js'
import { createSilentLogger } from '../src/shared/observability/logger.js'
import {
  createTestPool,
  resetAndMigrateTestDatabase,
  truncatePhase1Tables,
} from './support/database.js'

let pool: Pool
let now = new Date('2026-07-23T10:00:00Z')
const logger = createSilentLogger()
const config = loadConfig({
  NODE_ENV: 'test',
  AUTH0_ISSUER: 'https://tenant.example.auth0.com/',
  AUTH0_AUDIENCE: 'https://nines-api.example',
  CORS_ORIGIN: 'https://app.example',
  KYC_SESSION_TTL_MINUTES: '60',
  KYC_VERIFICATION_TTL_DAYS: '1',
  ENABLE_FAKE_KYC_TEST_ROUTES: 'true',
  PUBLIC_API_BASE_URL: 'http://localhost:3002',
})
const identity: AuthenticatedIdentity = {
  provider: 'auth0',
  issuer: config.auth0.issuer,
  subject: 'auth0|kyc-http-player',
  email: 'kyc-http@example.com',
  emailVerified: true,
  displayName: 'KYC HTTP Player',
  tokenType: 'human',
}
const verifier: VerifyBearerToken = async (token) => {
  if (token === 'human-token') return identity
  if (token === 'machine-token') {
    throw new AuthError('AUTH_PLAYER_TOKEN_REQUIRED', { status: 403 })
  }
  throw new AuthError('AUTH_TOKEN_INVALID')
}
const auth = { Authorization: 'Bearer human-token' }

function app() {
  return createApp({
    config,
    pool,
    logger,
    verifyBearerToken: verifier,
    clock: () => now,
  })
}

function eventService() {
  return new ProcessKycProviderEventService(
    pool,
    new PostgresKycProfileRepository(),
    new PostgresKycSessionRepository(),
    new PostgresKycProviderEventRepository(),
    new PostgresKycStatusTransitionRepository(),
    new PostgresAuditRepository(),
    new FakeKycProvider(60 * 60_000, () => now),
    24 * 60 * 60_000,
    () => now,
  )
}

async function processOutcome(
  sessionId: string,
  status: 'verified' | 'failed' | 'manual_review' | 'expired',
  eventId: string,
  offsetMs = 1_000,
) {
  const fake = new FakeKycProvider(60 * 60_000, () => now)
  return eventService().execute(
    {
      payload: fake.buildEvent({
        providerEventId: eventId,
        providerSessionReference: `fake-session-${sessionId}`,
        resultingStatus: status,
        occurredAt: new Date(now.getTime() + offsetMs),
      }),
    },
    {
      actorType: 'fake_provider',
      actorId: 'fake',
      correlationId: `corr-${eventId}`,
    },
  )
}

async function me() {
  return request(app()).get('/v1/me').set(auth)
}

async function startKyc(key: string) {
  return request(app())
    .post('/v1/me/kyc/sessions')
    .set(auth)
    .set('Idempotency-Key', key)
}

async function mockOutcome(sessionId: string, outcome: 'pass' | 'fail') {
  return request(app())
    .post(`/dev/kyc/mock/${sessionId}/outcome`)
    .set('X-Correlation-Id', `corr-mock-${sessionId}-${outcome}`)
    .send({ outcome })
}

beforeAll(async () => {
  pool = createTestPool()
  await resetAndMigrateTestDatabase(pool)
})

beforeEach(async () => {
  now = new Date('2026-07-23T10:00:00Z')
  await truncatePhase1Tables(pool)
})

afterAll(async () => {
  await pool.end()
})

describe('player-facing KYC API', () => {
  it('requires an authenticated human token', async () => {
    const missing = await request(app()).get('/v1/me/kyc')
    expect(missing.status).toBe(401)
    expect(missing.body.error.code).toBe('AUTH_HEADER_MISSING')

    const machine = await request(app())
      .post('/v1/me/kyc/sessions')
      .set('Authorization', 'Bearer machine-token')
    expect(machine.status).toBe(403)
    expect(machine.body.error.code).toBe('AUTH_PLAYER_TOKEN_REQUIRED')
  })

  it('returns and persists a safe not-started profile', async () => {
    const response = await request(app())
      .get('/v1/me/kyc')
      .set(auth)
      .set('X-Correlation-Id', 'corr-kyc-profile')
    expect(response.status).toBe(200)
    expect(response.headers['x-correlation-id']).toBe('corr-kyc-profile')
    expect(response.body).toEqual({
      status: 'not_started',
      verifiedAt: null,
      expiresAt: null,
      currentSession: null,
    })
  })

  it('starts and idempotently resumes one safe pending session', async () => {
    const first = await startKyc('http-stable-key')
    const repeat = await startKyc('http-stable-key')
    const noKeyRepeat = await request(app()).post('/v1/me/kyc/sessions').set(auth)
    expect(first.status).toBe(200)
    expect(repeat.status).toBe(200)
    expect(noKeyRepeat.status).toBe(200)
    expect(repeat.body).toEqual(first.body)
    expect(noKeyRepeat.body.sessionId).toBe(first.body.sessionId)
    expect(first.body).toEqual({
      sessionId: first.body.sessionId,
      status: 'pending',
      provider: 'fake',
      verificationUrl: `http://localhost:3002/dev/kyc/mock/${first.body.sessionId}`,
      expiresAt: '2026-07-23T11:00:00.000Z',
    })

    const profile = await request(app()).get('/v1/me/kyc').set(auth)
    expect(profile.body.currentSession).toEqual({
      sessionId: first.body.sessionId,
      status: 'pending',
      provider: 'fake',
      verificationUrl: `http://localhost:3002/dev/kyc/mock/${first.body.sessionId}`,
      expiresAt: '2026-07-23T11:00:00.000Z',
    })
    expect(profile.body).not.toHaveProperty('providerSessionReference')
    expect(profile.body).not.toHaveProperty('payloadHash')
  })

  it('serves only a current, unexpired pending session on the hosted page', async () => {
    const session = await startKyc('hosted-page-key')
    const page = await request(app()).get(
      `/dev/kyc/mock/${session.body.sessionId}`,
    )
    expect(page.status).toBe(200)
    expect(page.text).toContain('This is a mock KYC page.')
    expect(page.text).toContain(
      'For now, would you like to pass or fail verification?',
    )

    const unknown = await request(app()).get(
      '/dev/kyc/mock/22222222-2222-4222-8222-222222222222',
    )
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('KYC_SESSION_NOT_FOUND')

    now = new Date('2026-07-23T11:00:01Z')
    const expired = await request(app()).get(
      `/dev/kyc/mock/${session.body.sessionId}`,
    )
    expect(expired.status).toBe(410)
    expect(expired.body.error.code).toBe('KYC_SESSION_EXPIRED')
    const expiredOutcome = await mockOutcome(session.body.sessionId, 'pass')
    expect(expiredOutcome.status).toBe(410)
  })

  it('processes a pass through the provider-event pathway idempotently', async () => {
    const session = await startKyc('hosted-pass-key')
    now = new Date('2026-07-23T10:00:01Z')
    const first = await mockOutcome(session.body.sessionId, 'pass')
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      sessionId: session.body.sessionId,
      outcome: 'pass',
      sessionStatus: 'verified',
      kycStatus: 'verified',
      processingStatus: 'processed',
    })
    const duplicate = await mockOutcome(session.body.sessionId, 'pass')
    expect(duplicate.status).toBe(200)
    expect(duplicate.body).toMatchObject({
      kycStatus: 'verified',
      processingStatus: 'ignored_duplicate',
    })
    expect((await me()).body.kycStatus).toBe('verified')

    const event = await pool.query<{
      provider_event_id: string
      normalized_status: string
      metadata: Record<string, unknown>
    }>(
      `SELECT provider_event_id, normalized_status, metadata
       FROM kyc_provider_events
       WHERE provider_event_id = $1`,
      [`mock-hosted-${session.body.sessionId}-pass`],
    )
    expect(event.rows).toEqual([
      {
        provider_event_id: `mock-hosted-${session.body.sessionId}-pass`,
        normalized_status: 'verified',
        metadata: { source: 'mock_hosted_page' },
      },
    ])
    const transition = await pool.query<{ id: string }>(
      `SELECT id FROM kyc_status_transitions
       WHERE session_id = $1 AND to_status = 'verified'`,
      [session.body.sessionId],
    )
    expect(transition.rows).toHaveLength(1)
    await expect(
      pool.query(
        'UPDATE kyc_status_transitions SET reason_code = $1 WHERE id = $2',
        ['MUTATION_NOT_ALLOWED', transition.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('processes fail and prevents a superseded session from changing state', async () => {
    const first = await startKyc('hosted-fail-key')
    now = new Date('2026-07-23T10:00:01Z')
    const failed = await mockOutcome(first.body.sessionId, 'fail')
    expect(failed.status).toBe(200)
    expect(failed.body).toMatchObject({
      outcome: 'fail',
      sessionStatus: 'failed',
      kycStatus: 'failed',
      processingStatus: 'processed',
    })

    now = new Date('2026-07-23T10:00:02Z')
    const second = await startKyc('hosted-second-key')
    expect(second.body.sessionId).not.toBe(first.body.sessionId)
    const supersededPage = await request(app()).get(
      `/dev/kyc/mock/${first.body.sessionId}`,
    )
    expect(supersededPage.status).toBe(409)
    expect(supersededPage.body.error.code).toBe('KYC_SESSION_SUPERSEDED')
    const stalePass = await mockOutcome(first.body.sessionId, 'pass')
    expect(stalePass.status).toBe(409)
    expect(stalePass.body.error.code).toBe('KYC_SESSION_SUPERSEDED')
    expect((await request(app()).get('/v1/me/kyc').set(auth)).body).toMatchObject({
      status: 'pending',
      currentSession: { sessionId: second.body.sessionId },
    })
  })

  it('reflects pending and verified stored state in /v1/me permissions', async () => {
    const session = await startKyc('http-verify-key')
    const pending = await me()
    expect(pending.body.kycStatus).toBe('pending')
    expect(pending.body.permissions.deposit).toBe(false)

    await processOutcome(session.body.sessionId, 'verified', 'http-event-verified')
    const playerId = pending.body.playerId
    await new ChangeAccountStatusService(
      pool,
      new PostgresPlayerRepository(),
      new PostgresAccountStatusTransitionRepository(),
      new PostgresAuditRepository(),
    ).execute(
      { playerId, toStatus: 'active', reasonCode: 'HTTP_TEST_ACTIVATE' },
      {
        actorType: 'test_operator',
        actorId: 'operator-1',
        correlationId: 'corr-http-activate',
      },
    )

    const verified = await me()
    expect(verified.body).toMatchObject({
      accountStatus: 'active',
      kycStatus: 'verified',
      permissions: {
        deposit: true,
        withdraw: true,
        placeWager: true,
      },
    })

    await new PlayerRestrictionService(
      pool,
      new PostgresPlayerRepository(),
      new PostgresRestrictionRepository(),
      new PostgresAuditRepository(),
      () => now,
    ).addRestriction(
      {
        playerId,
        type: 'deposits_blocked',
        reasonCode: 'HTTP_TEST_DEPOSIT_BLOCK',
        source: 'test',
      },
      {
        actorType: 'test_operator',
        actorId: 'operator-1',
        correlationId: 'corr-http-restrict',
      },
    )
    const restricted = await me()
    expect(restricted.body.kycStatus).toBe('verified')
    expect(restricted.body.permissions.deposit).toBe(false)
    expect(restricted.body.permissions.withdraw).toBe(true)
  })

  it('reports failed, manual-review, and expired outcomes safely', async () => {
    const failedSession = await startKyc('http-failed-key')
    await processOutcome(failedSession.body.sessionId, 'failed', 'http-event-failed')
    expect((await request(app()).get('/v1/me/kyc').set(auth)).body.status).toBe('failed')
    expect((await me()).body.kycStatus).toBe('failed')

    const manualSession = await startKyc('http-manual-key')
    await processOutcome(
      manualSession.body.sessionId,
      'manual_review',
      'http-event-manual',
    )
    const manual = await request(app()).get('/v1/me/kyc').set(auth)
    expect(manual.body.status).toBe('manual_review')
    expect(manual.body.currentSession.sessionId).toBe(manualSession.body.sessionId)
    expect((await me()).body.kycStatus).toBe('manual_review')

    await processOutcome(
      manualSession.body.sessionId,
      'expired',
      'http-event-expired',
      2_000,
    )
    const expired = await request(app()).get('/v1/me/kyc').set(auth)
    expect(expired.body).toMatchObject({ status: 'expired', currentSession: null })
    expect((await me()).body.kycStatus).toBe('expired')
  })

  it('denies closed accounts with safe correlated details', async () => {
    const player = await me()
    await new ChangeAccountStatusService(
      pool,
      new PostgresPlayerRepository(),
      new PostgresAccountStatusTransitionRepository(),
      new PostgresAuditRepository(),
    ).execute(
      {
        playerId: player.body.playerId,
        toStatus: 'closed',
        reasonCode: 'HTTP_TEST_CLOSE',
      },
      {
        actorType: 'test_operator',
        actorId: 'operator-1',
        correlationId: 'corr-close',
      },
    )
    const denied = await request(app())
      .post('/v1/me/kyc/sessions')
      .set(auth)
      .set('X-Correlation-Id', 'corr-closed-start')
    expect(denied.status).toBe(403)
    expect(denied.body.error).toMatchObject({
      code: 'KYC_OPERATION_NOT_ALLOWED',
      correlationId: 'corr-closed-start',
      reasonCodes: ['ACCOUNT_CLOSED'],
    })
    expect(JSON.stringify(denied.body)).not.toContain('transition')
  })

  it('rejects unsafe idempotency keys without creating a session', async () => {
    const response = await request(app())
      .post('/v1/me/kyc/sessions')
      .set(auth)
      .set('Idempotency-Key', 'unsafe key with spaces')
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID')
    const count = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM kyc_verification_sessions',
    )
    expect(count.rows[0].count).toBe(0)
  })
})

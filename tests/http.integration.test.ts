import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { AuthenticatedIdentity } from '../src/auth/AuthenticatedIdentity.js'
import { AuthError } from '../src/auth/AuthError.js'
import type { VerifyBearerToken } from '../src/auth/auth0Jwt.js'
import { loadConfig } from '../src/config/config.js'
import { GetCurrentPlayerService } from '../src/players/application/GetCurrentPlayerService.js'
import { createSilentLogger } from '../src/shared/observability/logger.js'
import { createTestPool, resetAndMigrateTestDatabase, truncatePhase1Tables } from './support/database.js'

let pool: Pool
const logger = createSilentLogger()
const config = loadConfig({
  NODE_ENV: 'test',
  AUTH0_ISSUER: 'https://tenant.example.auth0.com/',
  AUTH0_AUDIENCE: 'https://nines-api.example',
  CORS_ORIGIN: 'https://app.example',
})

const humanIdentity: AuthenticatedIdentity = {
  provider: 'auth0',
  issuer: config.auth0.issuer,
  subject: 'auth0|http-player',
  email: 'http@example.com',
  emailVerified: true,
  displayName: 'HTTP Player',
  tokenType: 'human',
}

const testVerifier: VerifyBearerToken = async (token) => {
  if (token === 'human-token') return humanIdentity
  if (token === 'machine-token') {
    throw new AuthError('AUTH_PLAYER_TOKEN_REQUIRED', { status: 403 })
  }
  throw new AuthError('AUTH_TOKEN_INVALID')
}

beforeAll(async () => {
  pool = createTestPool()
  await resetAndMigrateTestDatabase(pool)
})

beforeEach(async () => {
  await truncatePhase1Tables(pool)
})

afterAll(async () => {
  await pool.end()
})

function app() {
  return createApp({ config, pool, logger, verifyBearerToken: testVerifier })
}

describe('health endpoints', () => {
  it('reports liveness without querying dependencies', async () => {
    const response = await request(app()).get('/health/live')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'live', service: 'nines-api' })
  })

  it('reports readiness for a connected database', async () => {
    const response = await request(app()).get('/health/ready')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ready', service: 'nines-api' })
  })

  it('reports not ready without exposing dependency details', async () => {
    const unavailablePool = { query: async () => Promise.reject(new Error('secret db details')) } as Pool
    const response = await request(
      createApp({ config, pool: unavailablePool, logger, verifyBearerToken: testVerifier }),
    ).get('/health/ready')
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ status: 'not_ready', service: 'nines-api' })
    expect(JSON.stringify(response.body)).not.toContain('secret')
  })
})

describe('GET /v1/me', () => {
  it('rejects missing, invalid, and machine tokens with stable errors', async () => {
    const missing = await request(app()).get('/v1/me')
    expect(missing.status).toBe(401)
    expect(missing.body.error.code).toBe('AUTH_HEADER_MISSING')

    const invalid = await request(app()).get('/v1/me').set('Authorization', 'Bearer invalid')
    expect(invalid.status).toBe(401)
    expect(invalid.body.error.code).toBe('AUTH_TOKEN_INVALID')

    const machine = await request(app())
      .get('/v1/me')
      .set('Authorization', 'Bearer machine-token')
    expect(machine.status).toBe(403)
    expect(machine.body.error.code).toBe('AUTH_PLAYER_TOKEN_REQUIRED')
  })

  it('creates and repeatedly returns one stable restricted internal player', async () => {
    const first = await request(app())
      .get('/v1/me')
      .set('Authorization', 'Bearer human-token')
      .set('X-Correlation-Id', 'safe-correlation-1')
    expect(first.status).toBe(200)
    expect(first.headers['x-correlation-id']).toBe('safe-correlation-1')
    expect(first.body).toMatchObject({
      email: 'http@example.com',
      displayName: 'HTTP Player',
      accountStatus: 'restricted',
      kycStatus: 'not_started',
      permissions: {
        viewRaces: true,
        usePracticeBalance: false,
        deposit: false,
        withdraw: false,
        placeWager: false,
        startKyc: true,
        manageProfile: true,
      },
    })
    expect(first.body.playerId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.body.playerId).not.toBe(humanIdentity.subject)

    const repeat = await request(app())
      .get('/v1/me')
      .set('Authorization', 'Bearer human-token')
    expect(repeat.status).toBe(200)
    expect(repeat.body.playerId).toBe(first.body.playerId)
    const decisions = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM eligibility_decisions WHERE player_id = $1',
      [first.body.playerId],
    )
    expect(decisions.rows[0].count).toBe(12)
  })

  it('generates a new correlation ID when the incoming value is unsafe', async () => {
    const response = await request(app())
      .get('/v1/me')
      .set('Authorization', 'Bearer human-token')
      .set('X-Correlation-Id', 'unsafe value with spaces')
    expect(response.status).toBe(200)
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('compatibility and error handling', () => {
  it('keeps /auth/me on the same player service and marks it deprecated', async () => {
    const response = await request(app())
      .get('/auth/me')
      .set('Authorization', 'Bearer human-token')
    expect(response.status).toBe(200)
    expect(response.headers.deprecation).toBe('true')
    expect(response.headers.link).toContain('/v1/me')
    expect(response.body.userId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns a correlated 404 response', async () => {
    const response = await request(app()).get('/does-not-exist')
    expect(response.status).toBe(404)
    expect(response.body.error).toMatchObject({
      code: 'ROUTE_NOT_FOUND',
      message: 'Route not found',
      correlationId: response.headers['x-correlation-id'],
    })
  })

  it('returns a generic production-safe 500 response', async () => {
    const failingCurrentPlayer = new GetCurrentPlayerService(
      { execute: async () => Promise.reject(new Error('sensitive internal failure')) } as never,
      { forPlayer: async () => Promise.reject(new Error('not reached')) } as never,
    )
    const response = await request(
      createApp({
        config,
        pool,
        logger,
        verifyBearerToken: testVerifier,
        getCurrentPlayer: failingCurrentPlayer,
      }),
    )
      .get('/v1/me')
      .set('Authorization', 'Bearer human-token')
    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(response.body)).not.toContain('sensitive')
  })
})

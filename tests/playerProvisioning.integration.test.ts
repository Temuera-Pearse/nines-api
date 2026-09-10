import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AuthenticatedIdentity } from '../src/auth/AuthenticatedIdentity.js'
import type { AuditRepository } from '../src/audit/AuditRepository.js'
import { PostgresAuditRepository } from '../src/audit/PostgresAuditRepository.js'
import { ResolveOrCreatePlayerService } from '../src/players/application/ResolveOrCreatePlayerService.js'
import { PostgresAuthenticationIdentityRepository } from '../src/players/infrastructure/PostgresAuthenticationIdentityRepository.js'
import { PostgresPlayerRepository } from '../src/players/infrastructure/PostgresPlayerRepository.js'
import { runMigrations } from '../src/shared/db/migrations.js'
import { createSilentLogger } from '../src/shared/observability/logger.js'
import {
  createTestPool,
  resetAndMigrateTestDatabase,
  truncatePhase1Tables,
} from './support/database.js'

let pool: Pool

const baseIdentity: AuthenticatedIdentity = {
  provider: 'auth0',
  issuer: 'https://tenant.example.auth0.com/',
  subject: 'auth0|player-1',
  email: 'first@example.com',
  emailVerified: true,
  displayName: 'First Player',
  tokenType: 'human',
}

function service(audit: AuditRepository = new PostgresAuditRepository()) {
  return new ResolveOrCreatePlayerService(
    pool,
    new PostgresPlayerRepository(),
    new PostgresAuthenticationIdentityRepository(),
    audit,
    createSilentLogger(),
  )
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

describe('database migrations', () => {
  it('created the Phase 1 tables and constraints on an empty database', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'players',
           'authentication_identities',
           'audit_events',
           'player_account_status_transitions',
           'player_restrictions',
           'eligibility_decisions',
           'player_kyc_profiles',
           'kyc_verification_sessions',
           'kyc_status_transitions',
           'kyc_provider_events'
         )
       ORDER BY table_name`,
    )
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'audit_events',
      'authentication_identities',
      'eligibility_decisions',
      'kyc_provider_events',
      'kyc_status_transitions',
      'kyc_verification_sessions',
      'player_account_status_transitions',
      'player_kyc_profiles',
      'player_restrictions',
      'players',
    ])
  })

  it('does not reapply an already applied migration', async () => {
    const result = await runMigrations(
      pool,
      path.resolve(process.cwd(), 'db/migrations'),
    )
    expect(result.applied).toEqual([])
    expect(result.alreadyApplied).toEqual([
      '001_phase_1_player_identity.sql',
      '002_phase_2_eligibility.sql',
      '003_phase_3_kyc.sql',
      '004_phase_3_5_kyc_lifecycle_hardening.sql',
      '005_phase_4_crypto_funding.sql',
      '006_confirmed_funding_attestations.sql',
    ])
  })

  it('enforces identity uniqueness and restricted account defaults', async () => {
    const playerId = randomUUID()
    await pool.query('INSERT INTO players (id) VALUES ($1)', [playerId])
    const player = await pool.query(
      'SELECT account_status FROM players WHERE id = $1',
      [playerId],
    )
    expect(player.rows[0].account_status).toBe('restricted')

    await pool.query(
      `INSERT INTO authentication_identities (id, player_id, provider, issuer, subject)
       VALUES ($1, $2, 'auth0', $3, $4)`,
      [randomUUID(), playerId, baseIdentity.issuer, baseIdentity.subject],
    )
    await expect(
      pool.query(
        `INSERT INTO authentication_identities (id, player_id, provider, issuer, subject)
         VALUES ($1, $2, 'auth0', $3, $4)`,
        [randomUUID(), playerId, baseIdentity.issuer, baseIdentity.subject],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('transactional player provisioning', () => {
  it('creates a restricted player, identity, and audit event on first login', async () => {
    const result = await service().execute(baseIdentity, {
      correlationId: 'corr-first',
    })
    expect(result.created).toBe(true)
    expect(result.player).toMatchObject({
      email: 'first@example.com',
      displayName: 'First Player',
      accountStatus: 'restricted',
    })
    const audit = await pool.query(
      'SELECT action, correlation_id FROM audit_events',
    )
    expect(audit.rows).toEqual([
      { action: 'player.provisioned', correlation_id: 'corr-first' },
    ])
  })

  it('returns the same player on repeat and concurrent first login', async () => {
    const repeated = await service().execute(baseIdentity, {
      correlationId: 'corr-1',
    })
    const repeat = await service().execute(baseIdentity, {
      correlationId: 'corr-2',
    })
    expect(repeat.created).toBe(false)
    expect(repeat.player.id).toBe(repeated.player.id)

    await truncatePhase1Tables(pool)
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service().execute(baseIdentity, {
          correlationId: `corr-concurrent-${index}`,
        }),
      ),
    )
    expect(new Set(concurrent.map((entry) => entry.player.id)).size).toBe(1)
    expect(
      (await pool.query('SELECT COUNT(*)::int AS count FROM players')).rows[0]
        .count,
    ).toBe(1)
    expect(
      (await pool.query('SELECT COUNT(*)::int AS count FROM audit_events'))
        .rows[0].count,
    ).toBe(1)
  })

  it('updates mutable profile fields without changing status or identity', async () => {
    const first = await service().execute(baseIdentity, {
      correlationId: 'corr-1',
    })
    const changed = await service().execute(
      {
        ...baseIdentity,
        email: 'changed@example.com',
        displayName: 'Changed Name',
      },
      { correlationId: 'corr-2' },
    )
    expect(changed.player).toMatchObject({
      id: first.player.id,
      email: 'changed@example.com',
      displayName: 'Changed Name',
      accountStatus: 'restricted',
      version: 2,
    })
  })

  it('supports absent email and never links different subjects by matching email', async () => {
    const withoutEmail = await service().execute(
      { ...baseIdentity, subject: 'auth0|no-email', email: null },
      { correlationId: 'corr-1' },
    )
    expect(withoutEmail.player.email).toBeNull()

    const sameEmailA = await service().execute(baseIdentity, {
      correlationId: 'corr-2',
    })
    const sameEmailB = await service().execute(
      { ...baseIdentity, subject: 'google-oauth2|different-subject' },
      { correlationId: 'corr-3' },
    )
    expect(sameEmailB.player.id).not.toBe(sameEmailA.player.id)
  })

  it('rolls back player and identity creation when audit persistence fails', async () => {
    const failingAudit: AuditRepository = {
      async append() {
        throw new Error('simulated audit failure')
      },
    }
    await expect(
      service(failingAudit).execute(baseIdentity, {
        correlationId: 'corr-fail',
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_STORE_UNAVAILABLE' })
    expect(
      (await pool.query('SELECT COUNT(*)::int AS count FROM players')).rows[0]
        .count,
    ).toBe(0)
    expect(
      (
        await pool.query(
          'SELECT COUNT(*)::int AS count FROM authentication_identities',
        )
      ).rows[0].count,
    ).toBe(0)
  })

  it('returns a dependency error on database failure', async () => {
    const failedPool = createTestPool()
    await failedPool.end()
    const failedService = new ResolveOrCreatePlayerService(
      failedPool,
      new PostgresPlayerRepository(),
      new PostgresAuthenticationIdentityRepository(),
      new PostgresAuditRepository(),
      createSilentLogger(),
    )
    await expect(
      failedService.execute(baseIdentity, { correlationId: 'corr-db-fail' }),
    ).rejects.toMatchObject({ code: 'PLAYER_STORE_UNAVAILABLE', status: 503 })
  })
})

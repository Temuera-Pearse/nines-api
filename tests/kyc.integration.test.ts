import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresAuditRepository } from '../src/audit/PostgresAuditRepository.js'
import type { AuthenticatedIdentity } from '../src/auth/AuthenticatedIdentity.js'
import { EvaluateEligibilityService } from '../src/eligibility/application/EvaluateEligibilityService.js'
import { PlayerRestrictionService } from '../src/eligibility/application/PlayerRestrictionService.js'
import { PostgresEligibilityDecisionRepository } from '../src/eligibility/infrastructure/PostgresEligibilityDecisionRepository.js'
import { PostgresRestrictionRepository } from '../src/eligibility/infrastructure/PostgresRestrictionRepository.js'
import { ExpireKycSessionsService } from '../src/kyc/application/ExpireKycSessionsService.js'
import { GetKycProfileService } from '../src/kyc/application/GetKycProfileService.js'
import { ProcessKycProviderEventService } from '../src/kyc/application/ProcessKycProviderEventService.js'
import { StartKycVerificationService } from '../src/kyc/application/StartKycVerificationService.js'
import { PostgresKycProfileRepository } from '../src/kyc/infrastructure/PostgresKycProfileRepository.js'
import { PostgresKycProviderEventRepository } from '../src/kyc/infrastructure/PostgresKycProviderEventRepository.js'
import { PostgresKycSessionRepository } from '../src/kyc/infrastructure/PostgresKycSessionRepository.js'
import { PostgresKycStatusReader } from '../src/kyc/infrastructure/PostgresKycStatusReader.js'
import { PostgresKycStatusTransitionRepository } from '../src/kyc/infrastructure/PostgresKycStatusTransitionRepository.js'
import { FakeKycProvider } from '../src/kyc/providers/FakeKycProvider.js'
import type { KycProvider } from '../src/kyc/providers/KycProvider.js'
import { EligibilityPermissionService } from '../src/permissions/EligibilityPermissionService.js'
import { ChangeAccountStatusService } from '../src/players/application/ChangeAccountStatusService.js'
import { ResolveOrCreatePlayerService } from '../src/players/application/ResolveOrCreatePlayerService.js'
import type { Player } from '../src/players/domain/Player.js'
import { PostgresAccountStatusTransitionRepository } from '../src/players/infrastructure/PostgresAccountStatusTransitionRepository.js'
import { PostgresAuthenticationIdentityRepository } from '../src/players/infrastructure/PostgresAuthenticationIdentityRepository.js'
import { PostgresPlayerRepository } from '../src/players/infrastructure/PostgresPlayerRepository.js'
import { createSilentLogger } from '../src/shared/observability/logger.js'
import {
  createTestPool,
  resetAndMigrateTestDatabase,
  truncatePhase1Tables,
} from './support/database.js'

let pool: Pool
let now = new Date('2026-07-23T10:00:00Z')
const SESSION_TTL_MS = 60 * 60_000
const VERIFICATION_TTL_MS = 24 * 60 * 60_000
const audit = new PostgresAuditRepository()
const players = new PostgresPlayerRepository()
const identities = new PostgresAuthenticationIdentityRepository()
const profiles = new PostgresKycProfileRepository()
const sessions = new PostgresKycSessionRepository()
const events = new PostgresKycProviderEventRepository()
const transitions = new PostgresKycStatusTransitionRepository()
const restrictions = new PostgresRestrictionRepository()
const logger = createSilentLogger()

const identity: AuthenticatedIdentity = {
  provider: 'auth0',
  issuer: 'https://tenant.example.auth0.com/',
  subject: 'auth0|kyc-player',
  email: 'kyc@example.com',
  emailVerified: true,
  displayName: 'KYC Player',
  tokenType: 'human',
}

const actor = (correlationId: string) => ({
  actorType: 'test_operator',
  actorId: 'operator-1',
  correlationId,
})

function provider() {
  return new FakeKycProvider(SESSION_TTL_MS, () => now)
}

function resolver() {
  return new ResolveOrCreatePlayerService(
    pool,
    players,
    identities,
    audit,
    logger,
  )
}

function eligibility() {
  return new EvaluateEligibilityService(
    pool,
    restrictions,
    new PostgresEligibilityDecisionRepository(),
    audit,
    new PostgresKycStatusReader(pool, profiles, audit),
    () => now,
  )
}

function getProfile() {
  return new GetKycProfileService(pool, players, profiles, sessions, audit)
}

function startService() {
  return new StartKycVerificationService(
    pool,
    players,
    profiles,
    sessions,
    transitions,
    audit,
    eligibility(),
    provider(),
    () => now,
  )
}

function eventService() {
  return new ProcessKycProviderEventService(
    pool,
    profiles,
    sessions,
    events,
    transitions,
    audit,
    provider(),
    VERIFICATION_TTL_MS,
    () => now,
  )
}

function expiryService() {
  return new ExpireKycSessionsService(pool, profiles, sessions, transitions, audit)
}

async function createPlayer(): Promise<Player> {
  return (await resolver().execute(identity, { correlationId: 'corr-kyc-provision' })).player
}

async function start(player: Player, key = randomUUID()) {
  return startService().execute(
    { playerId: player.id, idempotencyKey: key },
    actor(`corr-start-${key}`),
  )
}

async function outcome(
  sessionId: string,
  status: 'pending' | 'verified' | 'failed' | 'manual_review' | 'expired',
  eventId: string,
  occurredAt = new Date(now.getTime() + 1_000),
) {
  const fake = provider()
  return eventService().execute(
    {
      payload: fake.buildEvent({
        providerEventId: eventId,
        providerSessionReference: `fake-session-${sessionId}`,
        resultingStatus: status,
        occurredAt,
      }),
    },
    actor(`corr-event-${eventId}`),
  )
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

describe('KYC profile and session concurrency', () => {
  it('lazily creates exactly one profile under concurrent reads', async () => {
    const player = await createPlayer()
    const service = getProfile()
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.execute(player.id, actor(`corr-profile-${index}`)),
      ),
    )
    expect(results.every((result) => result.status === 'not_started')).toBe(true)
    expect(results.every((result) => result.currentSession === null)).toBe(true)
    const profileCount = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM player_kyc_profiles WHERE player_id = $1',
      [player.id],
    )
    expect(profileCount.rows[0].count).toBe(1)
    const auditCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_events
       WHERE player_id = $1 AND action = 'kyc.profile_created'`,
      [player.id],
    )
    expect(auditCount.rows[0].count).toBe(1)
  })

  it('creates one effective session for concurrent and idempotent starts', async () => {
    const player = await createPlayer()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => start(player, 'stable-start-key')),
    )
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1)
    expect(results.every((result) => result.status === 'pending')).toBe(true)
    expect(results[0].verificationUrl).toBeNull()

    const rows = await pool.query<{
      count: number
      active_count: number
      max_attempt: number
    }>(
      `SELECT
         COUNT(*)::int AS count,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS active_count,
         MAX(attempt_number)::int AS max_attempt
       FROM kyc_verification_sessions
       WHERE player_id = $1`,
      [player.id],
    )
    expect(rows.rows[0]).toEqual({ count: 1, active_count: 1, max_attempt: 1 })
    await expect(
      pool.query(
        `INSERT INTO kyc_verification_sessions
          (id, player_id, provider, provider_session_reference, status,
           attempt_number, started_at, completed_at)
         VALUES ($1, $2, 'fake', $3, 'creation_failed', 2, $4, $4)`,
        [
          randomUUID(),
          player.id,
          `fake-session-${results[0].sessionId}`,
          now,
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' })
    const transitionsCount = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM kyc_status_transitions WHERE player_id = $1',
      [player.id],
    )
    expect(transitionsCount.rows[0].count).toBe(1)
  })

  it('marks provider creation failure recoverably without changing profile state', async () => {
    const player = await createPlayer()
    const unavailableProvider: KycProvider = {
      providerName: 'fake',
      async createVerificationSession() {
        throw new Error('simulated provider outage with secret details')
      },
      async verifyAndNormalizeEvent() {
        throw new Error('not used')
      },
    }
    const unavailable = new StartKycVerificationService(
      pool,
      players,
      profiles,
      sessions,
      transitions,
      audit,
      eligibility(),
      unavailableProvider,
      () => now,
    )
    await expect(
      unavailable.execute(
        { playerId: player.id, idempotencyKey: 'provider-failure' },
        actor('corr-provider-failure'),
      ),
    ).rejects.toMatchObject({
      code: 'KYC_SESSION_CREATION_FAILED',
      status: 503,
      publicMessage: 'KYC verification is temporarily unavailable',
    })
    expect((await getProfile().execute(player.id, actor('corr-failure-read'))).status).toBe(
      'not_started',
    )
    const failed = await pool.query<{ status: string }>(
      'SELECT status FROM kyc_verification_sessions WHERE player_id = $1',
      [player.id],
    )
    expect(failed.rows).toEqual([{ status: 'creation_failed' }])
    await expect(start(player, 'provider-retry')).resolves.toMatchObject({
      status: 'pending',
    })
  })
})

describe('provider event processing', () => {
  it('persists a verified flow and ignores the duplicate event idempotently', async () => {
    const player = await createPlayer()
    const session = await start(player, 'verify-key')
    const first = await outcome(session.sessionId, 'verified', 'event-verified')
    expect(first).toMatchObject({
      processingStatus: 'processed',
      resultingKycStatus: 'verified',
      reasonCode: 'KYC_PROVIDER_VERIFIED',
    })
    const duplicate = await outcome(session.sessionId, 'verified', 'event-verified')
    expect(duplicate).toMatchObject({
      eventId: first.eventId,
      processingStatus: 'ignored_duplicate',
      reasonCode: 'KYC_EVENT_DUPLICATE',
    })

    const profile = await getProfile().execute(player.id, actor('corr-read-verified'))
    expect(profile).toMatchObject({
      status: 'verified',
      verifiedAt: new Date('2026-07-23T10:00:01Z'),
      expiresAt: new Date('2026-07-24T10:00:01Z'),
      currentSession: null,
    })
    expect(
      (
        await pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM kyc_provider_events
           WHERE provider = 'fake' AND provider_event_id = 'event-verified'`,
        )
      ).rows[0].count,
    ).toBe(1)
  })

  it('supports failed retry and prevents the old session from overwriting the new attempt', async () => {
    const player = await createPlayer()
    const first = await start(player, 'attempt-one')
    await outcome(first.sessionId, 'failed', 'event-failed')
    const second = await start(player, 'attempt-two')
    expect(second.sessionId).not.toBe(first.sessionId)

    const stale = await outcome(first.sessionId, 'verified', 'event-old-verified')
    expect(stale).toMatchObject({
      processingStatus: 'ignored_stale',
      resultingKycStatus: 'pending',
      reasonCode: 'KYC_EVENT_STALE',
    })
    await outcome(second.sessionId, 'verified', 'event-new-verified')

    const profile = await getProfile().execute(player.id, actor('corr-read-retry'))
    expect(profile.status).toBe('verified')
    const attempts = await pool.query<{ attempt_number: number; status: string }>(
      `SELECT attempt_number, status FROM kyc_verification_sessions
       WHERE player_id = $1 ORDER BY attempt_number`,
      [player.id],
    )
    expect(attempts.rows).toEqual([
      { attempt_number: 1, status: 'failed' },
      { attempt_number: 2, status: 'verified' },
    ])
  })

  it('supports manual review followed by a later verified result', async () => {
    const player = await createPlayer()
    const session = await start(player, 'manual-key')
    await outcome(session.sessionId, 'manual_review', 'event-manual')
    expect((await getProfile().execute(player.id, actor('corr-read-manual'))).status).toBe(
      'manual_review',
    )
    await outcome(
      session.sessionId,
      'verified',
      'event-manual-verified',
      new Date(now.getTime() + 2_000),
    )
    expect(
      (await getProfile().execute(player.id, actor('corr-read-manual-verified'))).status,
    ).toBe('verified')
  })

  it('records unknown, stale, and out-of-order events without corrupting state', async () => {
    const player = await createPlayer()
    const session = await start(player, 'ordering-key')
    const unknown = await outcome(randomUUID(), 'verified', 'event-unknown')
    expect(unknown).toMatchObject({
      processingStatus: 'rejected',
      reasonCode: 'KYC_PROVIDER_REFERENCE_MISMATCH',
    })
    await outcome(
      session.sessionId,
      'manual_review',
      'event-order-manual',
      new Date(now.getTime() + 5_000),
    )
    const latePending = await outcome(
      session.sessionId,
      'pending',
      'event-late-pending',
      new Date(now.getTime() + 4_000),
    )
    expect(latePending.processingStatus).toBe('ignored_stale')
    expect((await getProfile().execute(player.id, actor('corr-order-read'))).status).toBe(
      'manual_review',
    )

    const processing = await pool.query<{
      provider_event_id: string
      processing_status: string
    }>(
      `SELECT provider_event_id, processing_status FROM kyc_provider_events
       WHERE provider_event_id IN ('event-unknown', 'event-late-pending')
       ORDER BY provider_event_id`,
    )
    expect(processing.rows).toEqual([
      { provider_event_id: 'event-late-pending', processing_status: 'ignored_stale' },
      { provider_event_id: 'event-unknown', processing_status: 'rejected' },
    ])
  })

  it('serializes contradictory terminal events so exactly one applies', async () => {
    const player = await createPlayer()
    const session = await start(player, 'contradictory-key')
    const [verified, failed] = await Promise.all([
      outcome(session.sessionId, 'verified', 'event-race-verified'),
      outcome(session.sessionId, 'failed', 'event-race-failed'),
    ])
    expect([verified.processingStatus, failed.processingStatus].sort()).toEqual([
      'ignored_stale',
      'processed',
    ])
    const profile = await getProfile().execute(player.id, actor('corr-race-read'))
    expect(['verified', 'failed']).toContain(profile.status)
    const transitionCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM kyc_status_transitions
       WHERE player_id = $1 AND to_status IN ('verified', 'failed')`,
      [player.id],
    )
    expect(transitionCount.rows[0].count).toBe(1)
  })

  it('stores only sanitized normalized metadata and a deterministic hash', async () => {
    const player = await createPlayer()
    const session = await start(player, 'metadata-key')
    const fake = provider()
    await eventService().execute(
      {
        payload: fake.buildEvent({
          providerEventId: 'event-sanitized',
          providerSessionReference: `fake-session-${session.sessionId}`,
          resultingStatus: 'verified',
          occurredAt: new Date(now.getTime() + 1_000),
          metadata: {
            caseId: 'case-safe',
            bearerToken: 'must-not-persist',
            nested: { password: 'must-not-persist' },
          },
        }),
      },
      actor('corr-sanitized'),
    )
    const stored = await pool.query<{
      metadata: Record<string, unknown>
      payload_hash: string
    }>(
      `SELECT metadata, payload_hash FROM kyc_provider_events
       WHERE provider_event_id = 'event-sanitized'`,
    )
    expect(stored.rows[0].metadata).toEqual({
      caseId: 'case-safe',
      bearerToken: '[REDACTED]',
      nested: { password: '[REDACTED]' },
    })
    expect(stored.rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rolls back event, session, and profile updates when transition persistence fails', async () => {
    const player = await createPlayer()
    const session = await start(player, 'rollback-key')
    await pool.query(
      `ALTER TABLE kyc_status_transitions
       ADD CONSTRAINT kyc_test_forced_failure_check
       CHECK (correlation_id <> 'corr-forced-transition-failure')`,
    )
    const fake = provider()
    try {
      await expect(
        eventService().execute(
          {
            payload: fake.buildEvent({
              providerEventId: 'event-forced-rollback',
              providerSessionReference: `fake-session-${session.sessionId}`,
              resultingStatus: 'verified',
              occurredAt: new Date(now.getTime() + 1_000),
            }),
          },
          {
            actorType: 'test_operator',
            actorId: 'operator-1',
            correlationId: 'corr-forced-transition-failure',
          },
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await pool.query(
        `ALTER TABLE kyc_status_transitions
         DROP CONSTRAINT kyc_test_forced_failure_check`,
      )
    }

    expect((await getProfile().execute(player.id, actor('corr-rollback-read'))).status).toBe(
      'pending',
    )
    const sessionRow = await pool.query<{ status: string }>(
      'SELECT status FROM kyc_verification_sessions WHERE id = $1',
      [session.sessionId],
    )
    expect(sessionRow.rows[0].status).toBe('pending')
    const eventCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM kyc_provider_events
       WHERE provider_event_id = 'event-forced-rollback'`,
    )
    expect(eventCount.rows[0].count).toBe(0)
  })
})

describe('expiry, history, and eligibility integration', () => {
  it('expires sessions and verified profiles idempotently and supports retry', async () => {
    const player = await createPlayer()
    const first = await start(player, 'expiring-session')
    now = new Date('2026-07-23T12:00:00Z')
    const sessionExpiry = await expiryService().execute(now, actor('corr-expire-session'))
    expect(sessionExpiry).toMatchObject({
      expiredSessionIds: [first.sessionId],
    })
    expect((await getProfile().execute(player.id, actor('corr-expired-read'))).status).toBe(
      'expired',
    )
    expect(
      await expiryService().execute(now, actor('corr-expire-session-repeat')),
    ).toEqual({ expiredSessionIds: [], expiredProfileIds: [] })

    const second = await start(player, 'retry-expired')
    await outcome(
      second.sessionId,
      'verified',
      'event-expiry-verified',
      new Date(now.getTime() + 1_000),
    )
    now = new Date('2026-07-25T12:00:00Z')
    const verificationExpiry = await expiryService().execute(
      now,
      actor('corr-expire-verification'),
    )
    expect(verificationExpiry.expiredProfileIds).toHaveLength(1)
    expect(
      (await getProfile().execute(player.id, actor('corr-verification-expired-read'))).status,
    ).toBe('expired')
  })

  it('feeds verified stored state into eligibility without bypassing account or restrictions', async () => {
    let player = await createPlayer()
    const session = await start(player, 'eligibility-key')
    await outcome(session.sessionId, 'verified', 'event-eligibility-verified')
    player = await new ChangeAccountStatusService(
      pool,
      players,
      new PostgresAccountStatusTransitionRepository(),
      audit,
    ).execute(
      { playerId: player.id, toStatus: 'active', reasonCode: 'TEST_ACTIVATE' },
      actor('corr-activate'),
    )
    const permissionService = new EligibilityPermissionService(eligibility())
    const allowed = await permissionService.forPlayer(player, {
      correlationId: 'corr-permissions-allowed',
      actorId: identity.subject,
    })
    expect(allowed).toMatchObject({
      kycStatus: 'verified',
      permissions: {
        deposit: true,
        withdraw: true,
        placeWager: true,
      },
    })

    await new PlayerRestrictionService(
      pool,
      players,
      restrictions,
      audit,
      () => now,
    ).addRestriction(
      {
        playerId: player.id,
        type: 'deposits_blocked',
        reasonCode: 'TEST_DEPOSIT_BLOCK',
        source: 'test',
      },
      actor('corr-deposit-block'),
    )
    const restricted = await permissionService.forPlayer(player, {
      correlationId: 'corr-permissions-restricted',
      actorId: identity.subject,
    })
    expect(restricted.kycStatus).toBe('verified')
    expect(restricted.permissions.deposit).toBe(false)
    expect(restricted.permissions.withdraw).toBe(true)
  })

  it('keeps transition history and provider event identity immutable', async () => {
    const player = await createPlayer()
    const session = await start(player, 'immutable-key')
    await outcome(session.sessionId, 'failed', 'event-immutable')
    await expect(
      pool.query(
        `UPDATE kyc_status_transitions
         SET reason_code = 'MUTATED'
         WHERE player_id = $1`,
        [player.id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      pool.query(
        `UPDATE kyc_provider_events
         SET provider_event_id = 'mutated'
         WHERE provider_event_id = 'event-immutable'`,
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })
})

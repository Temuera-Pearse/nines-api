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
import { KycManualReviewService } from '../src/kyc/application/KycManualReviewService.js'
import { ProcessKycProviderEventService } from '../src/kyc/application/ProcessKycProviderEventService.js'
import { StartKycVerificationService } from '../src/kyc/application/StartKycVerificationService.js'
import { TransitionKycStatusService } from '../src/kyc/application/TransitionKycStatusService.js'
import { PostgresKycManualReviewRepository } from '../src/kyc/infrastructure/PostgresKycManualReviewRepository.js'
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
import { withTransaction } from '../src/shared/db/transaction.js'
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
const reviews = new PostgresKycManualReviewRepository()
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
  actorType: 'ADMIN' as const,
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

function eligibility(databasePool: Pool = pool) {
  return new EvaluateEligibilityService(
    databasePool,
    restrictions,
    new PostgresEligibilityDecisionRepository(),
    audit,
    new PostgresKycStatusReader(
      databasePool,
      profiles,
      audit,
      transitionService(),
      () => now,
    ),
    () => now,
  )
}

function getProfile() {
  return new GetKycProfileService(
    pool,
    players,
    profiles,
    sessions,
    audit,
    transitionService(),
  )
}

function transitionService() {
  return new TransitionKycStatusService(
    profiles,
    transitions,
    reviews,
    audit,
    () => now,
  )
}

function startService(kycProvider: KycProvider = provider()) {
  return new StartKycVerificationService(
    pool,
    players,
    profiles,
    sessions,
    transitionService(),
    audit,
    eligibility(),
    kycProvider,
    () => now,
  )
}

function eventService() {
  return new ProcessKycProviderEventService(
    pool,
    profiles,
    sessions,
    events,
    transitionService(),
    audit,
    provider(),
    VERIFICATION_TTL_MS,
    () => now,
  )
}

function expiryService() {
  return new ExpireKycSessionsService(
    pool,
    profiles,
    sessions,
    transitionService(),
    audit,
  )
}

function reviewService() {
  return new KycManualReviewService(
    pool,
    reviews,
    sessions,
    transitionService(),
    audit,
    VERIFICATION_TTL_MS,
    () => now,
  )
}

async function createPlayer(): Promise<Player> {
  return (await resolver().execute(identity, { correlationId: 'corr-kyc-provision' })).player
}

async function createPlayerWithSubject(subject: string): Promise<Player> {
  return (
    await resolver().execute(
      { ...identity, subject, email: `${subject}@example.com` },
      { correlationId: `corr-kyc-provision-${subject}` },
    )
  ).player
}

async function start(player: Player, key: string = randomUUID()) {
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
    {
      actorType: 'PROVIDER',
      actorId: 'fake',
      correlationId: `corr-event-${eventId}`,
    },
  )
}

async function activeReviewId(playerId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM kyc_manual_reviews
     WHERE player_id = $1 AND status <> 'completed'`,
    [playerId],
  )
  if (!result.rows[0]) throw new Error('Expected an active manual review')
  return result.rows[0].id
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

  it.each([2, 10])(
    'creates one logical provider session for %i concurrent starts',
    async (concurrency) => {
      const player = await createPlayer()
      const delegate = provider()
      const logicalCreationKeys = new Set<string>()
      let providerCalls = 0
      const replaySafeProvider: KycProvider = {
        providerName: delegate.providerName,
        async createVerificationSession(input) {
          providerCalls += 1
          logicalCreationKeys.add(input.idempotencyKey)
          return delegate.createVerificationSession(input)
        },
        verifyAndNormalizeEvent: (input) => delegate.verifyAndNormalizeEvent(input),
      }
      const service = startService(replaySafeProvider)
      const results = await Promise.all(
        Array.from({ length: concurrency }, (_, index) =>
          service.execute(
            { playerId: player.id, idempotencyKey: 'concurrent-provider-key' },
            actor(`corr-concurrent-provider-${index}`),
          ),
        ),
      )

      expect(new Set(results.map((result) => result.sessionId)).size).toBe(1)
      expect(new Set(results.map((result) => result.verificationUrl)).size).toBe(1)
      expect(logicalCreationKeys).toEqual(new Set([results[0].sessionId]))
      expect(providerCalls).toBeGreaterThanOrEqual(1)
    },
  )

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
      transitionService(),
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
    await expect(
      unavailable.execute(
        { playerId: player.id, idempotencyKey: 'provider-failure' },
        actor('corr-provider-failure-replay'),
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
    await expect(
      unavailable.execute(
        { playerId: player.id, idempotencyKey: 'provider-failure' },
        actor('corr-provider-failure-after-new-attempt'),
      ),
    ).rejects.toMatchObject({ code: 'KYC_SESSION_CREATION_FAILED', status: 503 })
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
      verifiedAt: new Date('2026-07-23T10:00:00Z'),
      expiresAt: new Date('2026-07-24T10:00:00Z'),
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

  it.each([
    ['exactly at', new Date('2026-07-23T11:00:00Z')],
    ['after', new Date('2026-07-23T11:00:01Z')],
  ])('expires a session and ignores a callback %s expiry', async (_label, callbackAt) => {
    const player = await createPlayer()
    const session = await start(player, `expired-callback-${_label}`)
    now = callbackAt

    const ignored = await outcome(
      session.sessionId,
      'verified',
      `event-expired-${_label}`,
      callbackAt,
    )
    expect(ignored).toMatchObject({
      processingStatus: 'ignored_expired',
      resultingKycStatus: 'expired',
      reasonCode: 'KYC_PROVIDER_EVENT_SESSION_EXPIRED',
    })
    expect((await profiles.findForPlayer(player.id, pool))?.status).toBe('expired')
    expect((await sessions.findById(session.sessionId, pool))?.status).toBe('expired')

    const duplicate = await outcome(
      session.sessionId,
      'verified',
      `event-expired-${_label}`,
      callbackAt,
    )
    expect(duplicate).toMatchObject({
      eventId: ignored.eventId,
      processingStatus: 'ignored_duplicate',
      reasonCode: 'KYC_EVENT_DUPLICATE',
    })
  })

  it('serializes a due callback racing the expiry worker without allowing approval', async () => {
    const player = await createPlayer()
    const session = await start(player, 'callback-expiry-race')
    now = new Date('2026-07-23T11:00:00Z')

    const [callback, worker] = await Promise.all([
      outcome(
        session.sessionId,
        'verified',
        'event-callback-expiry-race',
        now,
      ),
      expiryService().execute(now, {
        actorType: 'SYSTEM',
        actorId: 'race-worker',
        correlationId: 'corr-callback-expiry-race-worker',
      }),
    ])

    expect(callback).toMatchObject({
      processingStatus: 'ignored_expired',
      reasonCode: 'KYC_PROVIDER_EVENT_SESSION_EXPIRED',
    })
    expect((await profiles.findForPlayer(player.id, pool))?.status).toBe('expired')
    expect((await sessions.findById(session.sessionId, pool))?.status).toBe('expired')
    expect(worker.failures).toEqual([])
    const approvals = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM kyc_status_transitions
       WHERE player_id = $1 AND to_status = 'verified'`,
      [player.id],
    )
    expect(approvals.rows[0].count).toBe(0)
  })

  it('bounds future provider timestamps and uses receipt time for verification TTL', async () => {
    const player = await createPlayer()
    const session = await start(player, 'timestamp-skew-key')
    const insideSkew = new Date(now.getTime() + 5 * 60_000)
    const accepted = await outcome(
      session.sessionId,
      'verified',
      'event-inside-skew',
      insideSkew,
    )
    expect(accepted.processingStatus).toBe('processed')
    expect(await profiles.findForPlayer(player.id, pool)).toMatchObject({
      status: 'verified',
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    })
    const acceptedEvent = await pool.query<{
      event_timestamp: Date
      received_at: Date
      accepted_at: Date | null
    }>(
      `SELECT event_timestamp, received_at, accepted_at
       FROM kyc_provider_events WHERE provider_event_id = 'event-inside-skew'`,
    )
    expect(acceptedEvent.rows[0]).toEqual({
      event_timestamp: insideSkew,
      received_at: now,
      accepted_at: now,
    })

    const secondPlayer = await createPlayerWithSubject('auth0|future-skew-player')
    const secondSession = await start(secondPlayer, 'timestamp-skew-rejected-key')
    const outsideSkew = new Date(now.getTime() + 5 * 60_000 + 1)
    const rejected = await outcome(
      secondSession.sessionId,
      'verified',
      'event-outside-skew',
      outsideSkew,
    )
    expect(rejected).toMatchObject({
      processingStatus: 'rejected',
      reasonCode: 'KYC_PROVIDER_EVENT_FUTURE_TIMESTAMP',
    })
    expect((await profiles.findForPlayer(secondPlayer.id, pool))?.status).toBe('pending')
    const rejectedEvent = await pool.query<{
      processing_status: string
      processing_reason_code: string
      accepted_at: Date | null
    }>(
      `SELECT processing_status, processing_reason_code, accepted_at
       FROM kyc_provider_events WHERE provider_event_id = 'event-outside-skew'`,
    )
    expect(rejectedEvent.rows[0]).toEqual({
      processing_status: 'rejected',
      processing_reason_code: 'KYC_PROVIDER_EVENT_FUTURE_TIMESTAMP',
      accepted_at: null,
    })
  })

  it('converges concurrent duplicate deliveries on one event and transition', async () => {
    const player = await createPlayer()
    const session = await start(player, 'concurrent-event-key')
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        outcome(session.sessionId, 'verified', 'event-concurrent-duplicate'),
      ),
    )
    expect(results.filter((result) => result.processingStatus === 'processed')).toHaveLength(1)
    expect(
      results.filter((result) => result.processingStatus === 'ignored_duplicate'),
    ).toHaveLength(5)
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1)
    const effects = await pool.query<{ events: number; transitions: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM kyc_provider_events
          WHERE provider_event_id = 'event-concurrent-duplicate') AS events,
         (SELECT COUNT(*)::int FROM kyc_status_transitions
          WHERE player_id = $1 AND to_status = 'verified') AS transitions`,
      [player.id],
    )
    expect(effects.rows[0]).toEqual({ events: 1, transitions: 1 })
  })

  it('rejects player and provider ownership mismatches without changing state', async () => {
    const player = await createPlayer()
    const session = await start(player, 'ownership-key')
    const fake = provider()
    const wrongPlayer = await eventService().execute(
      {
        payload: fake.buildEvent({
          providerEventId: 'event-wrong-player',
          providerSessionReference: `fake-session-${session.sessionId}`,
          claimedPlayerReference: randomUUID(),
          resultingStatus: 'verified',
          occurredAt: new Date(now.getTime() + 1_000),
        }),
      },
      { actorType: 'PROVIDER', actorId: 'fake', correlationId: 'corr-wrong-player' },
    )
    expect(wrongPlayer).toMatchObject({
      processingStatus: 'rejected',
      reasonCode: 'KYC_PLAYER_MISMATCH',
    })
    await expect(
      eventService().execute(
        {
          payload: {
            ...fake.buildEvent({
              providerEventId: 'event-wrong-provider',
              providerSessionReference: `fake-session-${session.sessionId}`,
              resultingStatus: 'verified',
              occurredAt: new Date(now.getTime() + 2_000),
            }),
            provider: 'unexpected-provider',
          },
        },
        {
          actorType: 'PROVIDER',
          actorId: 'unexpected-provider',
          correlationId: 'corr-wrong-provider',
        },
      ),
    ).rejects.toMatchObject({ code: 'KYC_PROVIDER_MISMATCH', status: 400 })
    expect((await getProfile().execute(player.id, actor('corr-owner-read'))).status).toBe(
      'pending',
    )
  })

  it('commits a durable security audit for an event identity collision', async () => {
    const player = await createPlayer()
    const session = await start(player, 'identity-conflict-key')
    await outcome(session.sessionId, 'pending', 'event-identity-conflict')

    await expect(
      outcome(
        session.sessionId,
        'failed',
        'event-identity-conflict',
        new Date(now.getTime() + 1_000),
      ),
    ).rejects.toMatchObject({
      code: 'KYC_PROVIDER_EVENT_IDENTITY_CONFLICT',
      status: 409,
    })

    const securityAudit = await pool.query<{
      outcome: string
      reason_code: string
      metadata: Record<string, unknown>
    }>(
      `SELECT outcome, reason_code, metadata
       FROM audit_events
       WHERE action = 'kyc.event_identity_conflict'
         AND correlation_id = 'corr-event-event-identity-conflict'`,
    )
    expect(securityAudit.rows).toHaveLength(1)
    expect(securityAudit.rows[0]).toMatchObject({
      outcome: 'rejected',
      reason_code: 'KYC_PROVIDER_EVENT_IDENTITY_CONFLICT',
    })
    expect(securityAudit.rows[0].metadata).not.toHaveProperty('payloadHash')
    expect((await profiles.findForPlayer(player.id, pool))?.status).toBe('pending')
    const storedEvent = await events.find('fake', 'event-identity-conflict', pool)
    expect(storedEvent?.processingStatus).toBe('processed')
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
      reasonCode: 'KYC_PROVIDER_SESSION_NOT_FOUND',
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

  it('stores only allowlisted provider metadata and a deterministic hash', async () => {
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
            source: 'provider_test',
            caseId: 'must-not-persist',
            bearerToken: 'must-not-persist',
            documentImage: 'must-not-persist',
            nested: { password: 'must-not-persist', dateOfBirth: 'must-not-persist' },
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
    expect(stored.rows[0].metadata).toEqual({ source: 'provider_test' })
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
            actorType: 'ADMIN',
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
  it('processes verified-profile expiry despite an expired-session backlog', async () => {
    const pendingPlayer = await createPlayer()
    const pendingSession = await start(pendingPlayer, 'backlog-pending')
    const verifiedPlayer = await createPlayerWithSubject('auth0|backlog-verified')
    const verifiedSession = await start(verifiedPlayer, 'backlog-verified')
    await outcome(verifiedSession.sessionId, 'verified', 'event-backlog-verified')
    now = new Date('2026-07-25T12:00:00Z')

    const boundedExpiry = new ExpireKycSessionsService(
      pool,
      profiles,
      sessions,
      transitionService(),
      audit,
      1,
      1,
    )
    const result = await boundedExpiry.execute(now, actor('corr-independent-expiry-batches'))

    expect(result).toMatchObject({
      expiredSessionIds: [pendingSession.sessionId],
      sessionsExamined: 1,
      sessionsExpired: 1,
      profilesExamined: 1,
      profilesExpired: 1,
      failures: [],
    })
    expect(result.expiredProfileIds).toHaveLength(2)
    expect((await profiles.findForPlayer(pendingPlayer.id, pool))?.status).toBe('expired')
    expect((await profiles.findForPlayer(verifiedPlayer.id, pool))?.status).toBe('expired')
  })

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
    ).toEqual({
      expiredSessionIds: [],
      expiredProfileIds: [],
      sessionsExamined: 0,
      sessionsExpired: 0,
      profilesExamined: 0,
      profilesExpired: 0,
      failures: [],
    })

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

  it('lets concurrent expiry workers claim a due profile exactly once', async () => {
    const player = await createPlayer()
    const session = await start(player, 'expiry-race')
    await outcome(session.sessionId, 'verified', 'event-expiry-race')
    now = new Date('2026-07-25T12:00:00Z')
    const results = await Promise.all([
      expiryService().execute(now, {
        actorType: 'SYSTEM',
        actorId: 'worker-1',
        correlationId: 'corr-expiry-worker-1',
      }),
      expiryService().execute(now, {
        actorType: 'SYSTEM',
        actorId: 'worker-2',
        correlationId: 'corr-expiry-worker-2',
      }),
    ])
    expect(results.flatMap((result) => result.expiredProfileIds)).toHaveLength(1)
    const transitionsResult = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM kyc_status_transitions
       WHERE player_id = $1 AND to_status = 'expired'`,
      [player.id],
    )
    expect(transitionsResult.rows[0].count).toBe(1)
  })

  it('enforces transitions centrally and at the database boundary', async () => {
    const player = await createPlayer()
    await getProfile().execute(player.id, actor('corr-create-profile'))
    await expect(
      withTransaction(pool, (client) =>
        transitionService().execute(
          {
            playerId: player.id,
            toStatus: 'verified',
            trigger: 'MANUAL_REVIEW_DECISION',
            reasonCode: 'KYC_MANUAL_REVIEW_APPROVED',
          },
          actor('corr-invalid-transition'),
          client,
        ),
      ),
    ).rejects.toMatchObject({ code: 'KYC_INVALID_STATE_TRANSITION', status: 409 })
    await expect(
      pool.query(
        `UPDATE player_kyc_profiles
         SET status = 'failed', failure_reason_code = 'BYPASS_ATTEMPT',
             version = version + 1
         WHERE player_id = $1`,
        [player.id],
      ),
    ).rejects.toBeDefined()
    expect((await profiles.findForPlayer(player.id, pool))?.status).toBe('not_started')
  })

  it('records the complete manual-review approval workflow immutably', async () => {
    const player = await createPlayer()
    const session = await start(player, 'manual-approve-key')
    await outcome(session.sessionId, 'manual_review', 'event-review-requested')
    const reviewId = await activeReviewId(player.id)
    await reviewService().open(
      { reviewId, reasonCodes: ['DOCUMENT_CHECK_REQUIRED'], notes: 'Open case.' },
      actor('corr-review-open'),
    )
    await reviewService().assign(
      {
        reviewId,
        assigneeActorId: 'admin-reviewer-2',
        reasonCodes: ['SPECIALIST_REVIEW'],
      },
      actor('corr-review-assign'),
    )
    now = new Date('2026-07-23T10:00:10Z')
    const completed = await reviewService().approve(
      {
        reviewId,
        reasonCodes: ['DOCUMENTS_ACCEPTED'],
        notes: 'Threshold and document checks passed.',
      },
      actor('corr-review-approve'),
    )
    expect(completed).toMatchObject({ id: reviewId, status: 'completed' })
    expect((await profiles.findForPlayer(player.id, pool))?.status).toBe('verified')
    const actions = await pool.query<{
      action: string
      actor_type: string
      previous_status: string
      new_status: string
    }>(
      `SELECT action, actor_type, previous_status, new_status
       FROM kyc_manual_review_actions
       WHERE review_id = $1 ORDER BY created_at, id`,
      [reviewId],
    )
    expect(actions.rows.map((row) => row.action).sort()).toEqual([
      'review_approved',
      'review_assigned',
      'review_opened',
      'review_requested',
    ])
    expect(actions.rows.every((row) => row.actor_type === 'ADMIN' || row.actor_type === 'PROVIDER')).toBe(true)
    const decision = actions.rows.find((row) => row.action === 'review_approved')
    expect(decision).toMatchObject({
      previous_status: 'manual_review',
      new_status: 'verified',
    })
    const transition = await pool.query<{
      kyc_profile_id: string
      actor_type: string
      actor_id: string | null
      reason_codes: string[]
      transition_trigger: string
      policy_version: string | null
      profile_version: number
    }>(
      `SELECT kyc_profile_id, actor_type, actor_id, reason_codes,
              transition_trigger, policy_version, profile_version
       FROM kyc_status_transitions
       WHERE player_id = $1 AND to_status = 'verified'`,
      [player.id],
    )
    expect(transition.rows[0]).toMatchObject({
      actor_type: 'ADMIN',
      actor_id: 'operator-1',
      transition_trigger: 'MANUAL_REVIEW_DECISION',
      policy_version: 'eligibility-policy-v1',
    })
    expect(transition.rows[0].kyc_profile_id).toBeTruthy()
    expect(transition.rows[0].profile_version).toBeGreaterThan(1)
    expect(transition.rows[0].reason_codes).toContain('KYC_MANUAL_REVIEW_APPROVED')
    expect(transition.rows[0].reason_codes).toContain('DOCUMENTS_ACCEPTED')
    await expect(
      pool.query(
        `UPDATE kyc_manual_review_actions SET notes = 'changed' WHERE review_id = $1`,
        [reviewId],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('records a manual-review rejection and denies eligibility', async () => {
    let player = await createPlayer()
    const session = await start(player, 'manual-reject-key')
    await outcome(session.sessionId, 'manual_review', 'event-review-reject')
    const reviewId = await activeReviewId(player.id)
    now = new Date('2026-07-23T10:00:10Z')
    await reviewService().reject(
      { reviewId, reasonCodes: ['IDENTITY_MISMATCH'] },
      actor('corr-review-reject'),
    )
    expect((await profiles.findForPlayer(player.id, pool))?.status).toBe('failed')
    player = await new ChangeAccountStatusService(
      pool,
      players,
      new PostgresAccountStatusTransitionRepository(),
      audit,
    ).execute(
      { playerId: player.id, toStatus: 'active', reasonCode: 'TEST_ACTIVATE' },
      actor('corr-review-reject-activate'),
    )
    const permissions = await new EligibilityPermissionService(eligibility()).forPlayer(
      player,
      { correlationId: 'corr-review-reject-permissions', actorId: identity.subject },
    )
    expect(permissions).toMatchObject({
      kycStatus: 'failed',
      permissions: { deposit: false, withdraw: false, placeWager: false },
    })
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

  it('projects all /v1/me permissions through one database connection', async () => {
    const player = await createPlayer()
    let connectionCount = 0
    const trackedPool = {
      connect: async () => {
        connectionCount += 1
        return pool.connect()
      },
    } as Pool

    const projected = await new EligibilityPermissionService(
      eligibility(trackedPool),
    ).forPlayer(player, {
      correlationId: 'corr-permissions-single-connection',
      actorId: identity.subject,
    })

    expect(projected.permissions).toBeDefined()
    expect(connectionCount).toBe(1)
    const decisions = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM eligibility_decisions
       WHERE correlation_id = 'corr-permissions-single-connection'`,
    )
    expect(decisions.rows[0].count).toBe(6)
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

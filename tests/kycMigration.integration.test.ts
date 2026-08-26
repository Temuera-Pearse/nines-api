import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresKycProfileRepository } from '../src/kyc/infrastructure/PostgresKycProfileRepository.js'
import { PostgresKycProviderEventRepository } from '../src/kyc/infrastructure/PostgresKycProviderEventRepository.js'
import { createTestPool, resetTestDatabase } from './support/database.js'

let pool: Pool

const migrationDirectory = path.resolve(process.cwd(), 'db/migrations')
const knownActorMappings = [
  ['PLAYER', 'PLAYER'],
  ['external_identity', 'PLAYER'],
  ['PROVIDER', 'PROVIDER'],
  ['fake_provider', 'PROVIDER'],
  ['SYSTEM', 'SYSTEM'],
  ['ADMIN', 'ADMIN'],
] as const

async function applyMigration(filename: string): Promise<void> {
  const sql = await readFile(path.join(migrationDirectory, filename), 'utf8')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

beforeAll(async () => {
  pool = createTestPool()
  await resetTestDatabase(pool)
  await applyMigration('001_phase_1_player_identity.sql')
  await applyMigration('002_phase_2_eligibility.sql')
  await applyMigration('003_phase_3_kyc.sql')
})

afterAll(async () => {
  await pool.end()
})

describe('populated lifecycle migration upgrades', () => {
  it('preserves Phase 3 records through Phase 3.5 and Phase 4', async () => {
    const transitionIds = new Map<string, string>()
    for (const [index, [legacyActor]] of knownActorMappings.entries()) {
      const playerId = randomUUID()
      const profileId = randomUUID()
      const transitionId = randomUUID()
      transitionIds.set(legacyActor, transitionId)
      await pool.query(
        `INSERT INTO players (id, account_status) VALUES ($1, 'restricted')`,
        [playerId],
      )
      await pool.query(
        `INSERT INTO player_kyc_profiles (id, player_id) VALUES ($1, $2)`,
        [profileId, playerId],
      )
      await pool.query(
        `INSERT INTO kyc_status_transitions
          (id, player_id, from_status, to_status, reason_code, actor_type,
           actor_id, correlation_id, metadata)
         VALUES ($1, $2, 'not_started', 'pending', 'KYC_SESSION_STARTED', $3,
                 $4, $5, $6::jsonb)`,
        [
          transitionId,
          playerId,
          legacyActor,
          `legacy-actor-${index}`,
          `corr-legacy-${index}`,
          JSON.stringify({ preserved: true }),
        ],
      )
    }

    const unknownPlayerId = randomUUID()
    const unknownProfileId = randomUUID()
    const unknownTransitionId = randomUUID()
    await pool.query(
      `INSERT INTO players (id, account_status) VALUES ($1, 'restricted')`,
      [unknownPlayerId],
    )
    await pool.query(
      `INSERT INTO player_kyc_profiles (id, player_id) VALUES ($1, $2)`,
      [unknownProfileId, unknownPlayerId],
    )
    await pool.query(
      `INSERT INTO kyc_status_transitions
        (id, player_id, from_status, to_status, reason_code, actor_type,
         actor_id, correlation_id, metadata)
       VALUES ($1, $2, 'not_started', 'pending', 'KYC_SESSION_STARTED',
               'malformed-super-admin', 'legacy-worker', 'corr-legacy-unknown', '{}'::jsonb)`,
      [unknownTransitionId, unknownPlayerId],
    )

    const reviewPlayerId = randomUUID()
    const reviewProfileId = randomUUID()
    const reviewSessionId = randomUUID()
    const providerEventId = randomUUID()
    const legacyTime = new Date('2026-07-01T10:00:00Z')
    await pool.query(
      `INSERT INTO players (id, account_status) VALUES ($1, 'restricted')`,
      [reviewPlayerId],
    )
    await pool.query(
      `INSERT INTO kyc_verification_sessions
        (id, player_id, provider, provider_session_reference, status,
         attempt_number, started_at, expires_at, last_event_at)
       VALUES ($1, $2, 'fake', $3, 'manual_review', 1, $4, $5, $4)`,
      [
        reviewSessionId,
        reviewPlayerId,
        `fake-session-${reviewSessionId}`,
        legacyTime,
        new Date('2026-07-01T11:00:00Z'),
      ],
    )
    await pool.query(
      `INSERT INTO player_kyc_profiles
        (id, player_id, status, provider, current_session_id, created_at, updated_at)
       VALUES ($1, $2, 'manual_review', 'fake', $3, $4, $4)`,
      [reviewProfileId, reviewPlayerId, reviewSessionId, legacyTime],
    )
    await pool.query(
      `INSERT INTO kyc_provider_events
        (id, provider, provider_event_id, provider_session_reference, event_type,
         normalized_status, event_timestamp, payload_hash, processing_status,
         processing_reason_code, correlation_id, received_at, processed_at, metadata)
       VALUES ($1, 'fake', 'legacy-provider-event', $2, 'verification.manual_review',
               'manual_review', $3, $4, 'processed', 'KYC_PROVIDER_MANUAL_REVIEW',
               'corr-legacy-event', $3, $3, $5::jsonb)`,
      [
        providerEventId,
        `fake-session-${reviewSessionId}`,
        legacyTime,
        'a'.repeat(64),
        JSON.stringify({ source: 'legacy_fixture' }),
      ],
    )

    await applyMigration('004_phase_3_5_kyc_lifecycle_hardening.sql')

    for (const [legacyActor, expectedActor] of knownActorMappings) {
      const migrated = await pool.query<{
        actor_type: string
        kyc_profile_id: string
        reason_codes: string[]
        transition_trigger: string
        metadata: Record<string, unknown>
      }>(
        `SELECT actor_type, kyc_profile_id, reason_codes, transition_trigger, metadata
         FROM kyc_status_transitions WHERE id = $1`,
        [transitionIds.get(legacyActor)],
      )
      expect(migrated.rows[0]).toMatchObject({
        actor_type: expectedActor,
        reason_codes: ['KYC_SESSION_STARTED'],
        transition_trigger: 'legacy',
        metadata: { preserved: true },
      })
      expect(migrated.rows[0].kyc_profile_id).toBeTruthy()
    }

    const unknown = await pool.query<{
      actor_type: string
      metadata: Record<string, unknown>
    }>(
      `SELECT actor_type, metadata FROM kyc_status_transitions WHERE id = $1`,
      [unknownTransitionId],
    )
    expect(unknown.rows[0]).toEqual({
      actor_type: 'SYSTEM',
      metadata: { legacyActorType: 'malformed-super-admin' },
    })

    const event = await new PostgresKycProviderEventRepository().find(
      'fake',
      'legacy-provider-event',
      pool,
    )
    expect(event).toMatchObject({
      id: providerEventId,
      processingStatus: 'processed',
      acceptedAt: legacyTime,
      metadata: { source: 'legacy_fixture' },
    })
    const profile = await new PostgresKycProfileRepository().findForPlayer(
      reviewPlayerId,
      pool,
    )
    expect(profile).toMatchObject({
      id: reviewProfileId,
      status: 'manual_review',
      currentSessionId: reviewSessionId,
    })
    const review = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM kyc_manual_reviews
       WHERE kyc_profile_id = $1 AND status = 'open'`,
      [reviewProfileId],
    )
    expect(review.rows[0].count).toBe(1)

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN (
           'kyc_transitions_profile_created_idx',
           'player_kyc_profiles_verified_expiry_idx',
           'kyc_manual_reviews_one_active_profile_idx',
           'kyc_provider_events_provider_event_unique'
         )`,
    )
    expect(new Set(indexes.rows.map((row) => row.indexname))).toEqual(
      new Set([
        'kyc_transitions_profile_created_idx',
        'player_kyc_profiles_verified_expiry_idx',
        'kyc_manual_reviews_one_active_profile_idx',
        'kyc_provider_events_provider_event_unique',
      ]),
    )
    await expect(
      pool.query(
        `INSERT INTO kyc_provider_events
          (id, provider, provider_event_id, provider_session_reference, event_type,
           normalized_status, event_timestamp, payload_hash, correlation_id)
         VALUES ($1, 'fake', 'legacy-provider-event', $2, 'verification.pending',
                 'pending', NOW(), $3, 'corr-duplicate')`,
        [randomUUID(), `fake-session-${reviewSessionId}`, 'b'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await applyMigration('005_phase_4_crypto_funding.sql')

    const preservedEvent = await new PostgresKycProviderEventRepository().find(
      'fake',
      'legacy-provider-event',
      pool,
    )
    expect(preservedEvent).toMatchObject({ id: providerEventId, processingStatus: 'processed' })
    const phaseFourTables = await pool.query<{ name: string | null }>(
      `SELECT TO_REGCLASS(name)::text AS name
       FROM UNNEST($1::text[]) AS requested(name)`,
      [[
        'crypto_funding_intents',
        'crypto_funding_provider_sessions',
        'crypto_provider_events',
        'crypto_funding_transitions',
        'financial_funding_instructions',
        'crypto_funding_reconciliations',
      ]],
    )
    expect(phaseFourTables.rows.map((row) => row.name)).toEqual([
      'crypto_funding_intents',
      'crypto_funding_provider_sessions',
      'crypto_provider_events',
      'crypto_funding_transitions',
      'financial_funding_instructions',
      'crypto_funding_reconciliations',
    ])
  })
})

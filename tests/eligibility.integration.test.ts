import { randomUUID } from 'node:crypto'
import express from 'express'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresAuditRepository } from '../src/audit/PostgresAuditRepository.js'
import type { AuthenticatedIdentity } from '../src/auth/AuthenticatedIdentity.js'
import { requireAuth0Identity } from '../src/auth/auth0Jwt.js'
import { EvaluateEligibilityService } from '../src/eligibility/application/EvaluateEligibilityService.js'
import { PlayerRestrictionService } from '../src/eligibility/application/PlayerRestrictionService.js'
import {
  requireEligibility,
  type EligibilityRequest,
} from '../src/eligibility/application/requireEligibility.js'
import { ELIGIBILITY_POLICY_VERSION } from '../src/eligibility/domain/EligibilityDecision.js'
import { PostgresEligibilityDecisionRepository } from '../src/eligibility/infrastructure/PostgresEligibilityDecisionRepository.js'
import { PostgresRestrictionRepository } from '../src/eligibility/infrastructure/PostgresRestrictionRepository.js'
import { PostgresKycProfileRepository } from '../src/kyc/infrastructure/PostgresKycProfileRepository.js'
import { PostgresKycStatusReader } from '../src/kyc/infrastructure/PostgresKycStatusReader.js'
import { ChangeAccountStatusService } from '../src/players/application/ChangeAccountStatusService.js'
import { ResolveOrCreatePlayerService } from '../src/players/application/ResolveOrCreatePlayerService.js'
import type { AccountStatus } from '../src/players/domain/AccountStatus.js'
import type { Player } from '../src/players/domain/Player.js'
import { PostgresAccountStatusTransitionRepository } from '../src/players/infrastructure/PostgresAccountStatusTransitionRepository.js'
import { PostgresAuthenticationIdentityRepository } from '../src/players/infrastructure/PostgresAuthenticationIdentityRepository.js'
import { PostgresPlayerRepository } from '../src/players/infrastructure/PostgresPlayerRepository.js'
import { errorHandler } from '../src/shared/http/errorHandler.js'
import { createRequestContextMiddleware } from '../src/shared/http/requestContext.js'
import { createSilentLogger } from '../src/shared/observability/logger.js'
import {
  createTestPool,
  resetAndMigrateTestDatabase,
  truncatePhase1Tables,
} from './support/database.js'

let pool: Pool
let now = new Date('2026-01-10T00:00:00Z')
const logger = createSilentLogger()
const audit = new PostgresAuditRepository()
const players = new PostgresPlayerRepository()
const identities = new PostgresAuthenticationIdentityRepository()
const restrictions = new PostgresRestrictionRepository()
const kycProfiles = new PostgresKycProfileRepository()

const identity: AuthenticatedIdentity = {
  provider: 'auth0',
  issuer: 'https://tenant.example.auth0.com/',
  subject: 'auth0|eligibility-player',
  email: 'eligibility@example.com',
  emailVerified: true,
  displayName: 'Eligibility Player',
  tokenType: 'human',
}

function resolver() {
  return new ResolveOrCreatePlayerService(pool, players, identities, audit, logger)
}

function accountStatuses() {
  return new ChangeAccountStatusService(
    pool,
    players,
    new PostgresAccountStatusTransitionRepository(),
    audit,
  )
}

function restrictionService() {
  return new PlayerRestrictionService(pool, players, restrictions, audit, () => now)
}

function evaluator() {
  return new EvaluateEligibilityService(
    pool,
    restrictions,
    new PostgresEligibilityDecisionRepository(),
    audit,
    new PostgresKycStatusReader(pool, kycProfiles, audit),
    () => now,
  )
}

const actor = (correlationId: string) => ({
  actorType: 'test_operator',
  actorId: 'operator-1',
  correlationId,
})

async function createPlayer(): Promise<Player> {
  return (await resolver().execute(identity, { correlationId: 'corr-provision' })).player
}

async function changeStatus(player: Player, toStatus: AccountStatus): Promise<Player> {
  return accountStatuses().execute(
    {
      playerId: player.id,
      toStatus,
      reasonCode: `TEST_${toStatus.toUpperCase()}`,
    },
    actor(`corr-status-${toStatus}`),
  )
}

async function setVerifiedKyc(playerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO player_kyc_profiles
      (id, player_id, status, provider, verified_at, expires_at)
     VALUES ($1, $2, 'verified', 'fake', $3, $4)
     ON CONFLICT (player_id) DO UPDATE
     SET status = 'verified',
         provider = 'fake',
         verified_at = EXCLUDED.verified_at,
         expires_at = EXCLUDED.expires_at,
         version = player_kyc_profiles.version + 1,
         updated_at = NOW()`,
    [
      randomUUID(),
      playerId,
      new Date('2026-01-09T00:00:00Z'),
      new Date('2027-01-09T00:00:00Z'),
    ],
  )
}

beforeAll(async () => {
  pool = createTestPool()
  await resetAndMigrateTestDatabase(pool)
})

beforeEach(async () => {
  now = new Date('2026-01-10T00:00:00Z')
  await truncatePhase1Tables(pool)
})

afterAll(async () => {
  await pool.end()
})

describe('controlled account status changes', () => {
  it('persists status history and audit events while rejecting illegal transitions', async () => {
    let player = await createPlayer()
    player = await changeStatus(player, 'active')
    player = await changeStatus(player, 'suspended')
    player = await changeStatus(player, 'closed')
    expect(player.accountStatus).toBe('closed')
    expect(player.version).toBe(4)

    await expect(changeStatus(player, 'active')).rejects.toMatchObject({
      code: 'ACCOUNT_STATUS_TRANSITION_INVALID',
      status: 409,
    })

    const history = await pool.query(
      `SELECT from_status, to_status, reason_code
       FROM player_account_status_transitions
       WHERE player_id = $1
       ORDER BY created_at, id`,
      [player.id],
    )
    expect(history.rows).toEqual([
      {
        from_status: 'restricted',
        to_status: 'active',
        reason_code: 'TEST_ACTIVE',
      },
      {
        from_status: 'active',
        to_status: 'suspended',
        reason_code: 'TEST_SUSPENDED',
      },
      {
        from_status: 'suspended',
        to_status: 'closed',
        reason_code: 'TEST_CLOSED',
      },
    ])
    const auditCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM audit_events
       WHERE action = 'player.account_status_changed'`,
    )
    expect(auditCount.rows[0].count).toBe(3)
    await expect(
      pool.query(
        `UPDATE player_account_status_transitions
         SET reason_code = 'MUTATED'
         WHERE player_id = $1`,
        [player.id],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })
})

describe('restriction lifecycle', () => {
  it('supports simultaneous restrictions, manual removal, expiry, and retained history', async () => {
    const player = await createPlayer()
    const service = restrictionService()
    const manual = await service.addRestriction(
      {
        playerId: player.id,
        type: 'wagering_blocked',
        reasonCode: 'MANUAL_REVIEW',
        source: 'test',
      },
      actor('corr-restriction-add-1'),
    )
    await service.addRestriction(
      {
        playerId: player.id,
        type: 'deposits_blocked',
        reasonCode: 'DEPOSIT_REVIEW',
        source: 'test',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-01-09T00:00:00Z'),
        metadata: { caseId: 'case-1', bearerToken: 'must-not-persist' },
      },
      actor('corr-restriction-add-2'),
    )

    await service.removeRestriction(manual.id, 'REVIEW_COMPLETE', actor('corr-remove'))
    const expired = await service.expireDueRestrictions(player.id, actor('corr-expire'))
    expect(expired).toHaveLength(1)
    expect(expired[0].type).toBe('deposits_blocked')

    const history = await service.getRestrictions(player.id)
    expect(history).toHaveLength(2)
    expect(history.map((entry) => entry.status).sort()).toEqual(['expired', 'removed'])
    expect(history.find((entry) => entry.type === 'deposits_blocked')?.metadata).toEqual({
      caseId: 'case-1',
      bearerToken: '[REDACTED]',
    })

    const actions = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE action LIKE 'player.restriction_%'
       ORDER BY created_at, id`,
    )
    expect(actions.rows.map((row) => row.action).sort()).toEqual([
      'player.restriction_created',
      'player.restriction_created',
      'player.restriction_expired',
      'player.restriction_removed',
    ])
  })
})

describe('persisted eligibility decisions', () => {
  it('evaluates restricted, active, suspended, and closed accounts deterministically', async () => {
    let player = await createPlayer()
    await setVerifiedKyc(player.id)
    const service = evaluator()

    const restricted = await service.execute(
      { player, operation: 'deposit' },
      actor('corr-eval-restricted'),
    )
    expect(restricted).toMatchObject({
      allowed: false,
      reasonCodes: ['ACCOUNT_RESTRICTED'],
      policyVersion: ELIGIBILITY_POLICY_VERSION,
    })

    player = await changeStatus(player, 'active')
    const active = await service.execute(
      { player, operation: 'deposit' },
      actor('corr-eval-active'),
    )
    expect(active).toMatchObject({ allowed: true, reasonCodes: [] })

    player = await changeStatus(player, 'suspended')
    const suspended = await service.execute(
      { player, operation: 'withdraw' },
      actor('corr-eval-suspended'),
    )
    expect(suspended).toMatchObject({
      allowed: false,
      reasonCodes: ['ACCOUNT_SUSPENDED'],
    })

    player = await changeStatus(player, 'closed')
    const closed = await service.execute(
      { player, operation: 'view_races' },
      actor('corr-eval-closed'),
    )
    expect(closed).toMatchObject({ allowed: false, reasonCodes: ['ACCOUNT_CLOSED'] })

    const stored = await pool.query<{
      operation: string
      allowed: boolean
      reason_codes: string[]
      policy_version: string
      input_snapshot: Record<string, unknown>
    }>(
      `SELECT operation, allowed, reason_codes, policy_version, input_snapshot
       FROM eligibility_decisions
       WHERE player_id = $1
       ORDER BY created_at, id`,
      [player.id],
    )
    expect(stored.rows).toHaveLength(4)
    expect(
      stored.rows.find((row) => row.reason_codes.includes('ACCOUNT_RESTRICTED')),
    ).toMatchObject({
      operation: 'deposit',
      allowed: false,
      reason_codes: ['ACCOUNT_RESTRICTED'],
      policy_version: ELIGIBILITY_POLICY_VERSION,
      input_snapshot: {
        accountStatus: 'restricted',
        kycStatus: 'verified',
        activeRestrictionTypes: [],
      },
    })
    await expect(
      pool.query(
        `UPDATE eligibility_decisions
         SET allowed = true, reason_codes = '{}'
         WHERE id = $1`,
        [restricted.decisionId],
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })

  it('applies deposit, withdrawal, wagering, self-exclusion, jurisdiction, and security restrictions', async () => {
    let player = await createPlayer()
    player = await changeStatus(player, 'active')
    await setVerifiedKyc(player.id)
    const restrictionManager = restrictionService()
    for (const type of [
      'deposits_blocked',
      'withdrawals_blocked',
      'wagering_blocked',
      'self_exclusion',
      'jurisdiction_blocked',
      'security_review',
    ] as const) {
      await restrictionManager.addRestriction(
        {
          playerId: player.id,
          type,
          reasonCode: `TEST_${type.toUpperCase()}`,
          source: 'test',
        },
        actor(`corr-add-${type}`),
      )
    }

    const service = evaluator()
    await expect(
      service.execute(
        { player, operation: 'deposit' },
        actor('corr-deposit'),
      ),
    ).resolves.toMatchObject({ allowed: false, reasonCodes: ['DEPOSITS_BLOCKED'] })
    await expect(
      service.execute(
        { player, operation: 'withdraw' },
        actor('corr-withdraw'),
      ),
    ).resolves.toMatchObject({ allowed: false, reasonCodes: ['WITHDRAWALS_BLOCKED'] })
    await expect(
      service.execute(
        { player, operation: 'place_wager' },
        actor('corr-wager'),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCodes: [
        'WAGERING_BLOCKED',
        'SELF_EXCLUDED',
        'JURISDICTION_BLOCKED',
        'SECURITY_REVIEW',
      ],
    })

    const auditActions = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE action LIKE 'eligibility.%'
       ORDER BY created_at, id`,
    )
    expect(auditActions.rows.filter((row) => row.action === 'eligibility.evaluated')).toHaveLength(3)
    expect(
      auditActions.rows.filter((row) => row.action === 'eligibility.operation_denied'),
    ).toHaveLength(0)
  })

  it('persists every concurrent evaluation with a unique decision ID', async () => {
    const player = await createPlayer()
    const service = evaluator()
    const decisions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        service.execute(
          { player, operation: 'view_races' },
          actor(`corr-concurrent-eval-${index}`),
        ),
      ),
    )
    expect(new Set(decisions.map((decision) => decision.decisionId)).size).toBe(12)
    expect(decisions.every((decision) => decision.allowed)).toBe(true)
    const count = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM eligibility_decisions WHERE player_id = $1',
      [player.id],
    )
    expect(count.rows[0].count).toBe(12)
  })
})

describe('authorization middleware', () => {
  it('returns persisted denial details and allows an eligible player', async () => {
    const resolvePlayer = resolver()
    const evaluateEligibility = evaluator()
    const initialPlayer = await createPlayer()
    await setVerifiedKyc(initialPlayer.id)
    const app = express()
    app.use(createRequestContextMiddleware(logger))
    const authenticate = requireAuth0Identity(async () => identity, logger)
    app.get(
      '/protected',
      authenticate,
      requireEligibility('deposit', {
        resolvePlayer,
        evaluateEligibility,
      }),
      (req: EligibilityRequest, response) => {
        response.status(200).json({
          decisionId: req.eligibilityDecision?.decisionId,
          playerId: req.player?.id,
        })
      },
    )
    app.use(errorHandler)

    const denied = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer test-token')
      .set('X-Correlation-Id', 'corr-middleware-denied')
    expect(denied.status).toBe(403)
    expect(denied.body.error).toMatchObject({
      code: 'ELIGIBILITY_DENIED',
      correlationId: 'corr-middleware-denied',
      reasonCodes: ['ACCOUNT_RESTRICTED'],
    })
    expect(denied.body.error.decisionId).toMatch(/^[0-9a-f-]{36}$/)

    const player = (await resolver().execute(identity, { correlationId: 'corr-resolve' })).player
    await changeStatus(player, 'active')
    const allowed = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer test-token')
      .set('X-Correlation-Id', 'corr-middleware-allowed')
    expect(allowed.status).toBe(200)
    expect(allowed.body.playerId).toBe(player.id)
    expect(allowed.body.decisionId).toMatch(/^[0-9a-f-]{36}$/)

    const stored = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM eligibility_decisions
       WHERE correlation_id IN ('corr-middleware-denied', 'corr-middleware-allowed')`,
    )
    expect(stored.rows[0].count).toBe(2)
    const deniedAudit = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_events
       WHERE action = 'eligibility.operation_denied'
         AND correlation_id = 'corr-middleware-denied'`,
    )
    expect(deniedAudit.rows[0].count).toBe(1)
  })
})

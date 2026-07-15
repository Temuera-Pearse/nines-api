import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getRaceRepository } from '../db/raceRepository.js'
import { closePool, getPool, initPool } from '../db/pool.js'
import { RaceState } from '../race/raceState.js'
import type { PrecomputedRace } from '../race/raceTypes.js'
import { DefaultBetService } from './betService.js'
import { DefaultUserService } from './userService.js'
import { DefaultWalletService } from './walletService.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeIfDatabase = testDatabaseUrl ? describe : describe.skip

function makeOpenRace(raceId: string): PrecomputedRace {
  return {
    id: raceId,
    config: {
      trackLength: 1000,
      finishRatio: 1,
      durationMs: 20000,
      dtMs: 50,
      seed: `seed-${raceId}`,
    },
    horses: [
      { id: 'horse-1', name: 'Horse 1', baseSpeed: 48, accelVariance: 3, rngSeed: 11 },
      { id: 'horse-2', name: 'Horse 2', baseSpeed: 49, accelVariance: 3, rngSeed: 12 },
      { id: 'horse-3', name: 'Horse 3', baseSpeed: 50, accelVariance: 3, rngSeed: 13 },
    ],
    ticks: [],
    finishLine: 1000,
    winnerId: 'horse-1',
    finishOrder: [],
    finishTimesMs: {},
    finishTickIndex: {},
  }
}

describeIfDatabase('bet placement integration', () => {
  const userService = new DefaultUserService()
  const walletService = new DefaultWalletService()
  const betService = new DefaultBetService()
  const raceRepository = getRaceRepository()

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    initPool()
    const pool = getPool()
    const migrations = [
      '001_alpha_race_metadata.sql',
      '002_alpha_users_wallets.sql',
      '003_alpha_bets.sql',
    ]

    for (const migration of migrations) {
      await pool.query(readFileSync(resolve(`db/migrations/${migration}`), 'utf8'))
    }
  })

  beforeEach(async () => {
    process.env.NINES_ENABLE_LEGACY_ALPHA_FINANCIAL_FALLBACK = 'true'
    const pool = getPool()
    await pool.query(
      'truncate table bets, wallet_ledger_entries, wallets, users, race_artifacts, races restart identity cascade',
    )
    RaceState.setPrecomputedRace(null)
    RaceState.setCurrentRace(null)
  })

  afterAll(async () => {
    delete process.env.NINES_ENABLE_LEGACY_ALPHA_FINANCIAL_FALLBACK
    RaceState.setPrecomputedRace(null)
    RaceState.setCurrentRace(null)
    await closePool()
  })

  it('keeps the explicit legacy alpha fallback for wallet debits', async () => {
    const raceId = 'race-open-1'
    RaceState.setPrecomputedRace(makeOpenRace(raceId))

    await raceRepository.upsertSeededRace({
      raceId,
      seed: `seed-${raceId}`,
      checksum: null,
      config: { trackLength: 1000, finishRatio: 1, durationMs: 20000, dtMs: 50 },
      eventsCount: 0,
    })

    const created = await userService.createUser({
      username: 'bettor-alpha',
      email: 'bettor-alpha@example.com',
      dateOfBirth: '2000-01-01',
      currency: 'USDC',
    })

    await walletService.creditWallet({
      userId: created.user.id,
      amountMinor: 5000n,
      currency: 'USDC',
      entryType: 'admin_credit',
      referenceType: 'admin',
      referenceId: 'seed-balance',
    })

    const placed = await betService.placeBet({
      userId: created.user.id,
      raceId,
      selectionId: 'horse-2',
      stakeMinor: 1200n,
      currency: 'USDC',
      metadata: { source: 'integration-test' },
    })

    expect(placed.bet.status).toBe('placed')
    expect(placed.bet.resultStatus).toBe('pending')
    expect(placed.wallet.balanceMinor).toBe(3800n)
    expect(placed.ledgerEntry).not.toBeNull()
    expect(placed.ledgerEntry?.entryType).toBe('bet_stake')
    expect(placed.ledgerEntry?.referenceId).toBe(placed.bet.id)

    const pool = getPool()
    const betCount = await pool.query<{ count: number }>(
      `select count(*)::int as count from bets where user_id = $1`,
      [created.user.id],
    )
    const ledgerCount = await pool.query<{ count: number }>(
      `select count(*)::int as count from wallet_ledger_entries where wallet_id = $1`,
      [created.wallet.id],
    )

    expect(betCount.rows[0]?.count).toBe(1)
    expect(ledgerCount.rows[0]?.count).toBe(2)
  })

  it('rejects invalid selections without debiting the wallet', async () => {
    const raceId = 'race-open-2'
    RaceState.setPrecomputedRace(makeOpenRace(raceId))

    await raceRepository.upsertSeededRace({
      raceId,
      seed: `seed-${raceId}`,
      checksum: null,
      config: { trackLength: 1000, finishRatio: 1, durationMs: 20000, dtMs: 50 },
      eventsCount: 0,
    })

    const created = await userService.createUser({
      username: 'bettor-beta',
      dateOfBirth: '2000-01-01',
      currency: 'USDC',
    })

    await walletService.creditWallet({
      userId: created.user.id,
      amountMinor: 5000n,
      currency: 'USDC',
      entryType: 'admin_credit',
      referenceType: 'admin',
      referenceId: 'seed-balance',
    })

    await expect(
      betService.placeBet({
        userId: created.user.id,
        raceId,
        selectionId: 'horse-99',
        stakeMinor: 1200n,
      }),
    ).rejects.toThrow('selection is not valid for race')

    const wallet = await walletService.getWalletByUserId(created.user.id, 'USDC')
    expect(wallet.balanceMinor).toBe(5000n)
  })
})

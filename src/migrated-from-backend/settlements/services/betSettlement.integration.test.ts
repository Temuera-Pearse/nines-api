import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPool, initPool, closePool } from '../db/pool.js'
import { getRaceRepository } from '../db/raceRepository.js'
import { DefaultBetService } from './betService.js'
import { DefaultSettlementService } from './settlementService.js'
import { DefaultUserService } from './userService.js'
import { DefaultWalletService } from './walletService.js'
import { RaceState } from '../race/raceState.js'
import type { PrecomputedRace } from '../race/raceTypes.js'

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
    winnerId: 'horse-3',
    finishOrder: ['horse-3', 'horse-2', 'horse-1'],
    finishTimesMs: { 'horse-3': 19850, 'horse-2': 19900, 'horse-1': 20120 },
    finishTickIndex: {},
  }
}

describeIfDatabase('bet settlement integration', () => {
  const userService = new DefaultUserService()
  const walletService = new DefaultWalletService()
  const betService = new DefaultBetService()
  const settlementService = new DefaultSettlementService()
  const raceRepository = getRaceRepository()

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    initPool()
    const pool = getPool()
    const migrations = [
      '001_alpha_race_metadata.sql',
      '002_alpha_users_wallets.sql',
      '003_alpha_bets.sql',
      '004_alpha_bet_settlement.sql',
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

  it('keeps the explicit legacy alpha fallback for wallet settlement credits', async () => {
    const raceId = 'race-finished-1'
    RaceState.setPrecomputedRace(makeOpenRace(raceId))

    await raceRepository.upsertSeededRace({
      raceId,
      seed: `seed-${raceId}`,
      checksum: 'checksum-race-finished-1',
      config: { trackLength: 1000, finishRatio: 1, durationMs: 20000, dtMs: 50 },
      eventsCount: 0,
    })

    const winner = await userService.createUser({
      username: 'winner-bettor',
      dateOfBirth: '2000-01-01',
      currency: 'USDC',
    })
    const loser = await userService.createUser({
      username: 'loser-bettor',
      dateOfBirth: '2000-01-01',
      currency: 'USDC',
    })

    await walletService.creditWallet({
      userId: winner.user.id,
      amountMinor: 5000n,
      currency: 'USDC',
      entryType: 'admin_credit',
      referenceType: 'admin',
      referenceId: 'seed-winner',
    })
    await walletService.creditWallet({
      userId: loser.user.id,
      amountMinor: 5000n,
      currency: 'USDC',
      entryType: 'admin_credit',
      referenceType: 'admin',
      referenceId: 'seed-loser',
    })

    await betService.placeBet({
      userId: winner.user.id,
      raceId,
      selectionId: 'horse-3',
      stakeMinor: 1200n,
      currency: 'USDC',
    })
    await betService.placeBet({
      userId: loser.user.id,
      raceId,
      selectionId: 'horse-1',
      stakeMinor: 1200n,
      currency: 'USDC',
    })

    await raceRepository.markRaceFinished({
      raceId,
      lifecycleStatus: 'results_showing',
      actualEndTime: new Date('2026-03-22T00:02:00.000Z'),
      checksum: 'checksum-race-finished-1',
      winnerId: 'horse-3',
      finishOrder: ['horse-3', 'horse-2', 'horse-1'],
      finishTimesMs: { 'horse-3': 19850, 'horse-2': 19900, 'horse-1': 20120 },
      config: { trackLength: 1000, finishRatio: 1, durationMs: 20000, dtMs: 50 },
      hasTickStream: false,
      hasPrecomputedPaths: false,
      eventsCount: 0,
      persistenceStatus: 'saved',
    })

    const firstSettlement = await settlementService.settleRaceBets(raceId)

    expect(firstSettlement.processedCount).toBe(2)
    expect(firstSettlement.wonCount).toBe(1)
    expect(firstSettlement.lostCount).toBe(1)
    expect(firstSettlement.totalPayoutMinor).toBe(2400n)
    expect(
      firstSettlement.settledBets.find((entry) => entry.bet.resultStatus === 'won')?.ledgerEntry
        ?.entryType,
    ).toBe('settlement_credit')

    const winnerWallet = await walletService.getWalletByUserId(winner.user.id, 'USDC')
    const loserWallet = await walletService.getWalletByUserId(loser.user.id, 'USDC')

    expect(winnerWallet.balanceMinor).toBe(6200n)
    expect(loserWallet.balanceMinor).toBe(3800n)

    const pool = getPool()
    const settlementLedgerCount = await pool.query<{ count: number }>(
      `
        select count(*)::int as count
        from wallet_ledger_entries
        where entry_type = 'settlement_credit'
          and reference_type = 'bet'
          and reference_id in (
            select id from bets where race_id = $1
          )
      `,
      [raceId],
    )
    expect(settlementLedgerCount.rows[0]?.count).toBe(1)

    const secondSettlement = await settlementService.settleRaceBets(raceId)
    expect(secondSettlement.processedCount).toBe(0)
    expect(secondSettlement.totalPayoutMinor).toBe(0n)

    const winnerWalletAfterRerun = await walletService.getWalletByUserId(
      winner.user.id,
      'USDC',
    )
    expect(winnerWalletAfterRerun.balanceMinor).toBe(6200n)
  })
})

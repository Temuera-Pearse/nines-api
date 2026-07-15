import { describe, expect, it, vi } from 'vitest'

import type { BetRepository } from '../db/betRepository.js'
import type { RaceRepository } from '../db/raceRepository.js'
import type { RaceRecord } from '../db/types.js'
import type {
  FinancialBet,
  NinesFinancialClient,
} from '../financial/ninesFinancialClient.js'
import { NinesFinancialCommandError } from '../financial/ninesFinancialClient.js'
import { DefaultFinancialReconciliationService } from './financialReconciliationService.js'
import type { BetRecord } from '../bet/types.js'

function makeRace(overrides: Partial<RaceRecord> = {}): RaceRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')

  return {
    raceId: 'race-1',
    seed: 'seed-race-1',
    lifecycleStatus: 'results_showing',
    scheduledStartTime: null,
    actualStartTime: null,
    actualEndTime: now,
    checksum: null,
    winnerId: 'horse-1',
    finishOrder: ['horse-1'],
    finishTimesMs: { 'horse-1': 1000 },
    config: {},
    hasTickStream: false,
    hasPrecomputedPaths: false,
    eventsCount: 0,
    persistenceStatus: 'saved',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeBet(overrides: Partial<BetRecord> = {}): BetRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')

  return {
    id: 'bet-1',
    userId: 'user-1',
    walletId: 'wallet-1',
    raceId: 'race-1',
    currency: 'USDC',
    betType: 'win',
    selectionId: 'horse-1',
    stakeMinor: 1200n,
    payoutMinor: null,
    status: 'placed',
    resultStatus: 'pending',
    placedAt: now,
    settledAt: null,
    refundedAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeFinancialBet(
  overrides: Partial<FinancialBet> = {},
): FinancialBet {
  return {
    betId: 'bet-1',
    userId: 'user-1',
    raceId: 'race-1',
    selectionId: 'horse-1',
    stakeMinor: '1200',
    currency: 'USDC',
    status: 'accepted',
    rejectionCode: null,
    rejectionReason: null,
    reservationId: 'reservation-1',
    acceptedAt: '2026-03-22T00:00:00.000Z',
    rejectedAt: null,
    createdAt: '2026-03-22T00:00:00.000Z',
    updatedAt: '2026-03-22T00:00:00.000Z',
    ...overrides,
  }
}

function createRaceRepository(
  race: RaceRecord | null = makeRace(),
): RaceRepository {
  return {
    upsertSeededRace: vi.fn(),
    markRaceStarted: vi.fn(),
    markRaceFinished: vi.fn(),
    markRaceArchived: vi.fn(),
    markPersistenceStatus: vi.fn(),
    findCurrentRace: vi.fn(),
    findPreviousRace: vi.fn(),
    listRaceHistory: vi.fn(),
    findRaceById: vi.fn(async () => race),
  }
}

function createBetRepository(localBets: BetRecord[] = []): BetRepository {
  return {
    createBet: vi.fn(),
    findBetById: vi.fn(),
    listBetsByUserId: vi.fn(),
    listBetsByRaceId: vi.fn(async () => localBets),
    listUnsettledBetsByRaceId: vi.fn(),
    markBetSettled: vi.fn(),
    markBetRefunded: vi.fn(),
  }
}

function createFinancialClient(
  financialBets: FinancialBet[] = [],
  poolStatus: 'open' | 'frozen' | 'settled' = 'frozen',
): NinesFinancialClient {
  return {
    createRacePool: vi.fn(),
    registerPoolSelection: vi.fn(),
    freezePool: vi.fn(),
    placeBet: vi.fn(),
    reserveStake: vi.fn(),
    releaseReservation: vi.fn(),
    settleBet: vi.fn(),
    applyHouseTake: vi.fn(),
    applyCarryoversToRace: vi.fn(),
    getRacePool: vi.fn(async (raceId) => ({
      pool: {
        raceId,
        currency: 'USDC' as const,
        status: poolStatus,
        bettingOpensAt: null,
        bettingClosesAt: null,
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        frozenAt:
          poolStatus === 'open' ? null : '2026-03-22T00:00:30.000Z',
      },
      selections: [],
    })),
    listFinancialBetsByRace: vi.fn(async () => financialBets),
    getPlayerBalance: vi.fn(),
    getPlayerAccountSummary: vi.fn(),
  }
}

describe('DefaultFinancialReconciliationService', () => {
  it('detects financial accepted bets missing backend local read models', async () => {
    const service = new DefaultFinancialReconciliationService({
      raceRepository: createRaceRepository(
        makeRace({ lifecycleStatus: 'seeded', winnerId: null }),
      ),
      betRepository: createBetRepository([]),
      financialClient: createFinancialClient([makeFinancialBet()]),
      now: () => new Date('2026-04-22T12:00:00.000Z'),
    })

    const report = await service.detectRaceDrift('race-1')

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: 'FINANCIAL_ACCEPTED_BET_MISSING_BACKEND_READ_MODEL',
        betId: 'bet-1',
      }),
    ])
  })

  it('detects backend local read models missing financial accepted bets', async () => {
    const service = new DefaultFinancialReconciliationService({
      raceRepository: createRaceRepository(
        makeRace({ lifecycleStatus: 'seeded', winnerId: null }),
      ),
      betRepository: createBetRepository([makeBet()]),
      financialClient: createFinancialClient([]),
    })

    const report = await service.detectRaceDrift('race-1')

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: 'BACKEND_LOCAL_BET_MISSING_FINANCIAL_ACCEPTED_BET',
        betId: 'bet-1',
      }),
    ])
  })

  it('detects closed backend races with open financial pools', async () => {
    const service = new DefaultFinancialReconciliationService({
      raceRepository: createRaceRepository(
        makeRace({ lifecycleStatus: 'running', winnerId: null }),
      ),
      betRepository: createBetRepository([]),
      financialClient: createFinancialClient([], 'open'),
    })

    const report = await service.detectRaceDrift('race-1')

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: 'BACKEND_CLOSED_RACE_FINANCIAL_POOL_OPEN',
      }),
    ])
  })

  it('detects backend final results without a settled financial pool', async () => {
    const service = new DefaultFinancialReconciliationService({
      raceRepository: createRaceRepository(makeRace()),
      betRepository: createBetRepository([]),
      financialClient: createFinancialClient([], 'frozen'),
    })

    const report = await service.detectRaceDrift('race-1')

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: 'BACKEND_RACE_SETTLED_FINANCIAL_SETTLEMENT_MISSING',
      }),
    ])
  })

  it('detects backend races without financial pools', async () => {
    const financialClient = createFinancialClient([])
    vi.mocked(financialClient.getRacePool).mockRejectedValueOnce(
      new NinesFinancialCommandError(
        'nines-financial command failed with HTTP 404',
        404,
        {
          error: {
            code: 'RACE_POOL_NOT_FOUND',
            message: 'Race pool was not found',
          },
        },
      ),
    )
    const service = new DefaultFinancialReconciliationService({
      raceRepository: createRaceRepository(makeRace()),
      betRepository: createBetRepository([]),
      financialClient,
    })

    const report = await service.detectRaceDrift('race-1')

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: 'BACKEND_RACE_MISSING_FINANCIAL_POOL',
      }),
    ])
  })
})

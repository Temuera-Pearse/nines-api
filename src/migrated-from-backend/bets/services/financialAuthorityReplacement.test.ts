import type { Pool, PoolClient } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BetRecord, CreateBetInput } from '../bet/types.js'
import type { BetRepository, MarkBetSettledInput } from '../db/betRepository.js'
import type { RaceRepository } from '../db/raceRepository.js'
import type { RaceRecord } from '../db/types.js'
import type { WalletRepository } from '../db/walletRepository.js'
import type {
  FinancialBet,
  NinesFinancialClient,
  PlayerAccountSummary,
  PlayerBalance,
  PlaceBetCommand,
  PlaceBetFinancialResult,
  SettleBetCommand,
  SettleBetResult,
} from '../financial/ninesFinancialClient.js'
import { NinesFinancialCommandError } from '../financial/ninesFinancialClient.js'
import type {
  UserRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from '../user/types.js'
import type { UserService } from './userService.js'

const raceStateMock = vi.hoisted(() => ({
  getPrecomputedRace: vi.fn(),
  getPhaseAndSecond: vi.fn(),
}))

vi.mock('../race/raceState.js', () => ({
  RaceState: {
    getPrecomputedRace: raceStateMock.getPrecomputedRace,
    getStateMachine: () => ({
      getPhaseAndSecond: raceStateMock.getPhaseAndSecond,
    }),
  },
}))

import {
  DefaultBetService,
  type BetServiceDependencies,
} from './betService.js'
import {
  DefaultSettlementService,
  type SettlementServiceDependencies,
} from './settlementService.js'

function makeWallet(overrides: Partial<WalletRecord> = {}): WalletRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')
  return {
    id: 'wallet-1',
    userId: 'user-1',
    currency: 'USDC',
    balanceMinor: 5000n,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeLedgerEntry(
  overrides: Partial<WalletLedgerEntryRecord> = {},
): WalletLedgerEntryRecord {
  return {
    id: 1,
    walletId: 'wallet-1',
    entryType: 'bet_stake',
    deltaMinor: -1200n,
    balanceAfterMinor: 3800n,
    referenceType: 'bet',
    referenceId: 'bet-1',
    metadata: {},
    createdAt: new Date('2026-03-22T00:00:00.000Z'),
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
    selectionId: 'horse-3',
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

function makeRace(overrides: Partial<RaceRecord> = {}): RaceRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')
  return {
    raceId: 'race-1',
    seed: 'seed-race-1',
    lifecycleStatus: 'seeded',
    scheduledStartTime: null,
    actualStartTime: null,
    actualEndTime: null,
    checksum: null,
    winnerId: null,
    finishOrder: [],
    finishTimesMs: {},
    config: {},
    hasTickStream: false,
    hasPrecomputedPaths: false,
    eventsCount: 0,
    persistenceStatus: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeFinancialBet(overrides: Partial<FinancialBet> = {}): FinancialBet {
  return {
    betId: 'bet-1',
    userId: 'user-1',
    raceId: 'race-1',
    selectionId: 'horse-3',
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

function createFakePool() {
  const query = vi.fn(async () => ({
    command: '',
    fields: [],
    oid: 0,
    rowCount: 0,
    rows: [],
  }))
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const connect = vi.fn(async () => client)
  const pool = { connect } as unknown as Pool
  return { pool, connect, query, release }
}

function createBetRepository(
  overrides: Partial<BetRepository> = {},
): BetRepository {
  return {
    createBet: vi.fn(async (input: CreateBetInput) =>
      makeBet({
        id: input.id,
        userId: input.userId,
        walletId: input.walletId,
        raceId: input.raceId,
        currency: input.currency,
        betType: input.betType,
        selectionId: input.selectionId,
        stakeMinor: input.stakeMinor,
        payoutMinor: input.payoutMinor ?? null,
        status: input.status,
        resultStatus: input.resultStatus,
        metadata: input.metadata ?? {},
      }),
    ),
    findBetById: vi.fn(async () => null),
    listBetsByUserId: vi.fn(async () => []),
    listBetsByRaceId: vi.fn(async () => []),
    listUnsettledBetsByRaceId: vi.fn(async () => []),
    markBetSettled: vi.fn(async (input: MarkBetSettledInput) =>
      makeBet({
        id: input.betId,
        payoutMinor: input.payoutMinor,
        status: input.status,
        resultStatus: input.resultStatus,
        settledAt: input.settledAt,
      }),
    ),
    markBetRefunded: vi.fn(async () => null),
    ...overrides,
  }
}

function createWalletRepository(
  overrides: Partial<WalletRepository> = {},
): WalletRepository {
  return {
    createWallet: vi.fn(async () => makeWallet()),
    findWalletByUserId: vi.fn(async () => makeWallet()),
    findWalletById: vi.fn(async () => makeWallet()),
    findWalletByUserIdForUpdate: vi.fn(async () => makeWallet()),
    updateBalanceMinor: vi.fn(async (_walletId: string, balanceMinor: bigint) =>
      makeWallet({ balanceMinor }),
    ),
    ...overrides,
  }
}

function createRaceRepository(
  race: RaceRecord,
  overrides: Partial<RaceRepository> = {},
): RaceRepository {
  return {
    upsertSeededRace: vi.fn(async () => undefined),
    markRaceStarted: vi.fn(async () => undefined),
    markRaceFinished: vi.fn(async () => undefined),
    markRaceArchived: vi.fn(async () => undefined),
    markPersistenceStatus: vi.fn(async () => undefined),
    findCurrentRace: vi.fn(async () => race),
    findPreviousRace: vi.fn(async () => null),
    listRaceHistory: vi.fn(async () => []),
    findRaceById: vi.fn(async () => race),
    ...overrides,
  }
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  const now = new Date('2026-03-22T00:00:00.000Z')
  return {
    id: 'user-1',
    username: 'player',
    email: null,
    accountStatus: 'active',
    dateOfBirth: '2000-01-01',
    ageVerificationStatus: 'self_attested',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function createUserService(overrides: Partial<UserService> = {}): UserService {
  return {
    createUser: vi.fn(async () => ({
      user: makeUser(),
      wallet: makeWallet(),
    })),
    getUserById: vi.fn(async () => makeUser()),
    updateAccountStatus: vi.fn(async () => makeUser()),
    updateAgeVerificationStatus: vi.fn(async () => makeUser()),
    getBetEligibility: vi.fn(async () => ({ allowed: true, reasons: [] })),
    ...overrides,
  }
}

function createFinancialClient(
  overrides: Partial<NinesFinancialClient> = {},
): NinesFinancialClient {
  return {
    createRacePool: vi.fn(async (command) => ({
      raceId: command.raceId,
      currency: command.currency,
      status: 'open' as const,
      bettingOpensAt: command.bettingOpensAt ?? null,
      bettingClosesAt: command.bettingClosesAt ?? null,
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      frozenAt: null,
    })),
    registerPoolSelection: vi.fn(async (command) => ({
      raceId: command.raceId,
      selectionId: command.selectionId,
      currency: command.currency,
      status: command.status ?? 'active',
      displayName: command.displayName ?? null,
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
    })),
    freezePool: vi.fn(async (command) => ({
      raceId: command.raceId,
      currency: command.currency,
      status: 'frozen' as const,
      bettingOpensAt: null,
      bettingClosesAt: null,
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
      frozenAt: '2026-03-22T00:00:00.000Z',
    })),
    placeBet: vi.fn(
      async (command: PlaceBetCommand): Promise<PlaceBetFinancialResult> => ({
        bet: makeFinancialBet({
          betId: command.betId,
          userId: command.userId,
          raceId: command.raceId,
          selectionId: command.selectionId,
          stakeMinor: command.stakeMinor,
          currency: command.currency,
        }),
        reservationId: 'reservation-1',
        accepted: true,
      }),
    ),
    reserveStake: vi.fn(async () => ({
      reservationId: 'reservation-1',
      acceptedAt: '2026-03-22T00:00:00.000Z',
    })),
    releaseReservation: vi.fn(async () => ({
      reservationId: 'reservation-1',
      releasedAt: '2026-03-22T00:00:00.000Z',
    })),
    settleBet: vi.fn(async (command: SettleBetCommand): Promise<SettleBetResult> => ({
      settlementRunId: `settlement_run_${command.raceId}`,
      status: 'completed',
      reasonCode: null,
      raceId: command.raceId,
      winningSelectionId: command.winningSelectionId,
      totalPoolMinor: '0',
      houseTakeMinor: '0',
      netPoolMinor: '0',
      roundingResidualMinor: '0',
      carryoverMinor: '0',
      settledBets: [],
      settledAt: '2026-03-22T00:01:00.000Z',
    })),
    applyHouseTake: vi.fn(async () => ({
      raceId: 'race-1',
      amountMinor: '0',
      appliedAt: '2026-03-22T00:01:00.000Z',
    })),
    applyCarryoversToRace: vi.fn(async (command) => ({
      applicationId: `carryover_application_${command.targetRaceId}`,
      targetRaceId: command.targetRaceId,
      currency: command.currency,
      totalAppliedMinor: '0',
      appliedCarryovers: [],
      appliedAt: '2026-03-22T00:01:00.000Z',
    })),
    getRacePool: vi.fn(async (raceId) => ({
      pool: {
        raceId,
        currency: 'USDC' as const,
        status: 'frozen' as const,
        bettingOpensAt: null,
        bettingClosesAt: null,
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        frozenAt: '2026-03-22T00:00:30.000Z',
      },
      selections: [],
    })),
    listFinancialBetsByRace: vi.fn(async (raceId) => [
      makeFinancialBet({ raceId, betId: 'bet-1' }),
    ]),
    getPlayerBalance: vi.fn(async (): Promise<PlayerBalance> => ({
      playerAccountId: 'player-account-1',
      currency: 'USDC',
      spendableBalanceMinor: '5000',
      lockedBalanceMinor: '0',
      restrictedBalanceMinor: '0',
      displayBalanceMinor: '5000',
      asOf: '2026-03-22T00:00:00.000Z',
    })),
    getPlayerAccountSummary: vi.fn(async (): Promise<PlayerAccountSummary> => ({
      playerAccountId: 'player-account-1',
      userId: 'user-1',
      currency: 'USDC',
      effectiveStatus: 'active',
      displayBalanceMinor: '5000',
      spendableBalanceMinor: '5000',
      asOf: '2026-03-22T00:00:00.000Z',
    })),
    ...overrides,
  }
}

function failWalletDelta(): NonNullable<BetServiceDependencies['applyWalletDelta']> {
  return vi.fn(async () => {
    throw new Error('wallet mutation should not be called')
  }) as NonNullable<BetServiceDependencies['applyWalletDelta']>
}

beforeEach(() => {
  raceStateMock.getPrecomputedRace.mockReturnValue({
    id: 'race-1',
    horses: [{ id: 'horse-1' }, { id: 'horse-3' }],
  })
  raceStateMock.getPhaseAndSecond.mockReturnValue({ phase: 'idle' })
})

describe('financial authority replacement', () => {
  it('places bets through nines-financial place-bet intake', async () => {
    const pool = createFakePool()
    const betRepository = createBetRepository()
    const walletRepository = createWalletRepository()
    const financialClient = createFinancialClient()
    const applyWalletDelta = failWalletDelta()
    const service = new DefaultBetService({
      betRepository,
      walletRepository,
      raceRepository: createRaceRepository(makeRace()),
      userService: createUserService(),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta,
    })

    const result = await service.placeBet({
      userId: 'user-1',
      raceId: 'race-1',
      selectionId: 'horse-3',
      stakeMinor: 1200n,
      currency: 'USDC',
      idempotencyKey: 'reserve-key-1',
      metadata: { source: 'contract-test' },
    })

    expect(financialClient.placeBet).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'reserve-key-1',
        userId: 'user-1',
        raceId: 'race-1',
        selectionId: 'horse-3',
        stakeMinor: '1200',
        currency: 'USDC',
      }),
    )
    expect(financialClient.reserveStake).not.toHaveBeenCalled()
    expect(walletRepository.findWalletByUserId).toHaveBeenCalledWith(
      'user-1',
      'USDC',
    )
    expect(walletRepository.findWalletByUserIdForUpdate).not.toHaveBeenCalled()
    expect(walletRepository.updateBalanceMinor).not.toHaveBeenCalled()
    expect(applyWalletDelta).not.toHaveBeenCalled()
    expect(result.ledgerEntry).toBeNull()
    expect(result.financialReservation?.reservationId).toBe('reservation-1')
    expect(betRepository.createBet).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'USDC',
        metadata: expect.objectContaining({
          financialAuthority: 'nines-financial',
          financialCommand: 'placeBet',
          financialReservationId: 'reservation-1',
        }),
      }),
      expect.any(Object),
    )
  })

  it('does not send bet placement to nines-financial after backend betting close', async () => {
    raceStateMock.getPhaseAndSecond.mockReturnValue({ phase: 'race_running' })
    const pool = createFakePool()
    const betRepository = createBetRepository()
    const financialClient = createFinancialClient()
    const service = new DefaultBetService({
      betRepository,
      walletRepository: createWalletRepository(),
      raceRepository: createRaceRepository(
        makeRace({ lifecycleStatus: 'running' }),
      ),
      userService: createUserService(),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta: failWalletDelta(),
    })

    await expect(
      service.placeBet({
        userId: 'user-1',
        raceId: 'race-1',
        selectionId: 'horse-3',
        stakeMinor: 1200n,
        currency: 'USDC',
      }),
    ).rejects.toThrow('race is closed for betting')

    expect(financialClient.placeBet).not.toHaveBeenCalled()
    expect(betRepository.createBet).not.toHaveBeenCalled()
  })

  it('rejects bet acceptance when nines-financial rejects reservation', async () => {
    const pool = createFakePool()
    const betRepository = createBetRepository()
    const financialClient = createFinancialClient({
      placeBet: vi.fn(async () => {
        throw new Error('reservation denied')
      }),
    })
    const service = new DefaultBetService({
      betRepository,
      walletRepository: createWalletRepository(),
      raceRepository: createRaceRepository(makeRace()),
      userService: createUserService(),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta: failWalletDelta(),
    })

    await expect(
      service.placeBet({
        userId: 'user-1',
        raceId: 'race-1',
        selectionId: 'horse-3',
        stakeMinor: 1200n,
        currency: 'USDC',
      }),
    ).rejects.toThrow('reservation denied')

    expect(betRepository.createBet).not.toHaveBeenCalled()
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('rejects local bet acceptance when nines-financial returns a rejected PlaceBet result', async () => {
    const pool = createFakePool()
    const betRepository = createBetRepository()
    const financialClient = createFinancialClient({
      placeBet: vi.fn(
        async (command: PlaceBetCommand): Promise<PlaceBetFinancialResult> => ({
          accepted: false,
          reservationId: null,
          bet: {
            betId: command.betId,
            userId: command.userId,
            raceId: command.raceId,
            selectionId: command.selectionId,
            stakeMinor: command.stakeMinor,
            currency: command.currency,
            status: 'rejected',
            rejectionCode: 'INSUFFICIENT_FUNDS',
            rejectionReason: 'Account has insufficient spendable balance',
            reservationId: null,
            acceptedAt: null,
            rejectedAt: '2026-03-22T00:00:00.000Z',
            createdAt: '2026-03-22T00:00:00.000Z',
            updatedAt: '2026-03-22T00:00:00.000Z',
          },
        }),
      ),
    })
    const service = new DefaultBetService({
      betRepository,
      walletRepository: createWalletRepository(),
      raceRepository: createRaceRepository(makeRace()),
      userService: createUserService(),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta: failWalletDelta(),
    })

    await expect(
      service.placeBet({
        userId: 'user-1',
        raceId: 'race-1',
        selectionId: 'horse-3',
        stakeMinor: 1200n,
        currency: 'USDC',
      }),
    ).rejects.toThrow('Account has insufficient spendable balance')

    expect(betRepository.createBet).not.toHaveBeenCalled()
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('settles bets by sending settlement instructions to nines-financial', async () => {
    const pool = createFakePool()
    const applyWalletDelta = vi.fn(async () => {
      throw new Error('wallet settlement should not be called')
    }) as NonNullable<SettlementServiceDependencies['applyWalletDelta']>
    const unsettledBets = [
      makeBet({ id: 'bet-win', userId: 'user-win', selectionId: 'horse-3' }),
      makeBet({
        id: 'bet-loss',
        userId: 'user-loss',
        walletId: 'wallet-2',
        selectionId: 'horse-1',
      }),
    ]
    const betRepository = createBetRepository({
      listUnsettledBetsByRaceId: vi.fn(async () => unsettledBets),
    })
    const financialClient = createFinancialClient({
      settleBet: vi.fn(async (command: SettleBetCommand): Promise<SettleBetResult> => ({
        settlementRunId: 'settlement_run_race_1',
        status: 'completed',
        reasonCode: null,
        raceId: command.raceId,
        winningSelectionId: command.winningSelectionId,
        totalPoolMinor: '2400',
        houseTakeMinor: '0',
        netPoolMinor: '2400',
        roundingResidualMinor: '0',
        carryoverMinor: '0',
        settledBets: [
          {
            betId: 'bet-win',
            userId: 'user-win',
            selectionId: 'horse-3',
            resultStatus: 'won',
            stakeMinor: '1200',
            payoutMinor: '2400',
            captureTransactionId: 'txn_capture_bet_win',
            payoutTransactionId: 'txn_payout_bet_win',
          },
          {
            betId: 'bet-loss',
            userId: 'user-loss',
            selectionId: 'horse-1',
            resultStatus: 'lost',
            stakeMinor: '1200',
            payoutMinor: '0',
            captureTransactionId: 'txn_capture_bet_loss',
            payoutTransactionId: null,
          },
        ],
        settledAt: '2026-03-22T00:01:00.000Z',
      })),
    })
    const service = new DefaultSettlementService({
      betRepository,
      raceRepository: createRaceRepository(
        makeRace({
          lifecycleStatus: 'results_showing',
          winnerId: 'horse-3',
        }),
      ),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta,
    })

    const result = await service.settleRaceBets('race-1')

    expect(financialClient.settleBet).toHaveBeenCalledTimes(1)
    expect(financialClient.settleBet).toHaveBeenCalledWith(
      {
        idempotencyKey: 'settle:race-1',
        correlationId: 'settlement:race-1',
        causationId: 'race:race-1:result',
        raceId: 'race-1',
        winningSelectionId: 'horse-3',
        houseTakeBps: 0,
        currency: 'USDC',
      },
    )
    expect(betRepository.markBetSettled).toHaveBeenCalledTimes(2)
    expect(applyWalletDelta).not.toHaveBeenCalled()
    expect(result.processedCount).toBe(2)
    expect(result.wonCount).toBe(1)
    expect(result.lostCount).toBe(1)
    expect(result.totalPayoutMinor).toBe(2400n)
    expect(result.settledBets.every((entry) => entry.ledgerEntry === null)).toBe(
      true,
    )
  })

  it('does not settle when the financial pool is missing', async () => {
    const pool = createFakePool()
    const betRepository = createBetRepository()
    const financialClient = createFinancialClient({
      getRacePool: vi.fn(async () => {
        throw new NinesFinancialCommandError(
          'nines-financial command failed with HTTP 404',
          404,
          {
            error: {
              code: 'RACE_POOL_NOT_FOUND',
              message: 'Race pool was not found',
            },
          },
        )
      }),
    })
    const service = new DefaultSettlementService({
      betRepository,
      raceRepository: createRaceRepository(
        makeRace({
          lifecycleStatus: 'results_showing',
          winnerId: 'horse-3',
        }),
      ),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta: failWalletDelta(),
    })

    await expect(service.settleRaceBets('race-1')).rejects.toThrow(
      'financial race pool must exist before settlement',
    )

    expect(financialClient.settleBet).not.toHaveBeenCalled()
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('does not settle when the financial pool is not frozen', async () => {
    const pool = createFakePool()
    const betRepository = createBetRepository()
    const financialClient = createFinancialClient({
      getRacePool: vi.fn(async (raceId) => ({
        pool: {
          raceId,
          currency: 'USDC' as const,
          status: 'open' as const,
          bettingOpensAt: null,
          bettingClosesAt: null,
          createdAt: '2026-03-22T00:00:00.000Z',
          updatedAt: '2026-03-22T00:00:00.000Z',
          frozenAt: null,
        },
        selections: [],
      })),
    })
    const service = new DefaultSettlementService({
      betRepository,
      raceRepository: createRaceRepository(
        makeRace({
          lifecycleStatus: 'results_showing',
          winnerId: 'horse-3',
        }),
      ),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta: failWalletDelta(),
    })

    await expect(service.settleRaceBets('race-1')).rejects.toThrow(
      'financial race pool must be frozen before settlement',
    )

    expect(financialClient.settleBet).not.toHaveBeenCalled()
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('does not let backend local bet drift define financial settlement truth', async () => {
    const pool = createFakePool()
    const localBet = makeBet({
      id: 'bet-local-only',
      userId: 'user-local',
      selectionId: 'horse-3',
    })
    const betRepository = createBetRepository({
      listUnsettledBetsByRaceId: vi.fn(async () => [localBet]),
    })
    const financialClient = createFinancialClient({
      settleBet: vi.fn(async (command: SettleBetCommand): Promise<SettleBetResult> => ({
        settlementRunId: 'settlement_run_drift',
        status: 'completed',
        reasonCode: null,
        raceId: command.raceId,
        winningSelectionId: command.winningSelectionId,
        totalPoolMinor: '1200',
        houseTakeMinor: '0',
        netPoolMinor: '1200',
        roundingResidualMinor: '0',
        carryoverMinor: '0',
        settledBets: [
          {
          betId: 'bet-financial-only',
          userId: 'user-financial',
          selectionId: 'horse-3',
            resultStatus: 'won',
            stakeMinor: '1200',
            payoutMinor: '1200',
            captureTransactionId: 'txn_capture_financial_only',
            payoutTransactionId: 'txn_payout_financial_only',
          },
        ],
        settledAt: '2026-03-22T00:01:00.000Z',
      })),
    })
    const service = new DefaultSettlementService({
      betRepository,
      raceRepository: createRaceRepository(
        makeRace({
          lifecycleStatus: 'results_showing',
          winnerId: 'horse-3',
        }),
      ),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => false,
      applyWalletDelta: failWalletDelta(),
    })

    const result = await service.settleRaceBets('race-1')

    expect(financialClient.settleBet).toHaveBeenCalledTimes(1)
    expect(betRepository.markBetSettled).not.toHaveBeenCalled()
    expect(result.processedCount).toBe(0)
  })

  it('keeps legacy alpha wallet mutation only behind the explicit fallback', async () => {
    const pool = createFakePool()
    const financialClient = createFinancialClient()
    const applyWalletDelta = vi.fn(async () => ({
      wallet: makeWallet({ balanceMinor: 3800n }),
      ledgerEntry: makeLedgerEntry({ entryType: 'bet_stake' }),
    })) as NonNullable<BetServiceDependencies['applyWalletDelta']>
    const service = new DefaultBetService({
      betRepository: createBetRepository(),
      walletRepository: createWalletRepository(),
      raceRepository: createRaceRepository(makeRace()),
      userService: createUserService(),
      financialClient,
      poolFactory: () => pool.pool,
      legacyAlphaFallbackEnabled: () => true,
      applyWalletDelta,
    })

    const result = await service.placeBet({
      userId: 'user-1',
      raceId: 'race-1',
      selectionId: 'horse-3',
      stakeMinor: 1200n,
      currency: 'USDC',
    })

    expect(financialClient.placeBet).not.toHaveBeenCalled()
    expect(financialClient.reserveStake).not.toHaveBeenCalled()
    expect(applyWalletDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: -1200n,
        currency: 'USDC',
        entryType: 'bet_stake',
      }),
      expect.any(Object),
    )
    expect(result.ledgerEntry?.entryType).toBe('bet_stake')
    expect(result.financialReservation).toBeNull()
  })
})

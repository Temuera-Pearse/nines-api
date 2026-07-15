import { describe, expect, it, vi } from 'vitest'

import type {
  FinancialBet,
  NinesFinancialClient,
  PoolSelection,
  RacePool,
  RacePoolWithSelections,
} from '../financial/ninesFinancialClient.js'
import { DefaultRaceFinancialLifecycleService } from './raceFinancialLifecycleService.js'

function makePool(raceId: string, status: RacePool['status'] = 'open'): RacePool {
  return {
    raceId,
    currency: 'USDC',
    status,
    bettingOpensAt: null,
    bettingClosesAt: null,
    createdAt: '2026-04-22T12:00:00.000Z',
    updatedAt: '2026-04-22T12:00:00.000Z',
    frozenAt: status === 'frozen' ? '2026-04-22T12:00:30.000Z' : null,
  }
}

function makeSelection(
  raceId: string,
  selectionId: string,
): PoolSelection {
  return {
    raceId,
    selectionId,
    currency: 'USDC',
    status: 'active',
    displayName: null,
    createdAt: '2026-04-22T12:00:00.000Z',
    updatedAt: '2026-04-22T12:00:00.000Z',
  }
}

function createFinancialClient(): NinesFinancialClient {
  return {
    createRacePool: vi.fn(async (command) => makePool(command.raceId)),
    registerPoolSelection: vi.fn(async (command) =>
      makeSelection(command.raceId, command.selectionId),
    ),
    freezePool: vi.fn(async (command) => makePool(command.raceId, 'frozen')),
    applyCarryoversToRace: vi.fn(async (command) => ({
      applicationId: `carryover_application_${command.targetRaceId}`,
      targetRaceId: command.targetRaceId,
      currency: command.currency,
      totalAppliedMinor: '0',
      appliedCarryovers: [],
      appliedAt: '2026-04-22T12:00:00.000Z',
    })),
    placeBet: vi.fn(),
    reserveStake: vi.fn(),
    releaseReservation: vi.fn(),
    settleBet: vi.fn(),
    applyHouseTake: vi.fn(),
    getRacePool: vi.fn(
      async (raceId): Promise<RacePoolWithSelections> => ({
        pool: makePool(raceId),
        selections: [],
      }),
    ),
    listFinancialBetsByRace: vi.fn(
      async (): Promise<FinancialBet[]> => [],
    ),
    getPlayerBalance: vi.fn(),
    getPlayerAccountSummary: vi.fn(),
  }
}

describe('DefaultRaceFinancialLifecycleService', () => {
  it('creates a race pool and registers every valid selection exactly once', async () => {
    const financialClient = createFinancialClient()
    const service = new DefaultRaceFinancialLifecycleService({ financialClient })

    await service.ensureRacePoolOpen({
      raceId: 'race-1',
      selections: [
        { selectionId: 'horse-1', displayName: 'Horse 1' },
        { selectionId: 'horse-2', displayName: 'Horse 2' },
      ],
    })
    await service.ensureRacePoolOpen({
      raceId: 'race-1',
      selections: [
        { selectionId: 'horse-1', displayName: 'Horse 1' },
        { selectionId: 'horse-2', displayName: 'Horse 2' },
      ],
    })

    expect(financialClient.createRacePool).toHaveBeenCalledTimes(1)
    expect(financialClient.createRacePool).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'race:race-1:pool:create',
        raceId: 'race-1',
        currency: 'USDC',
      }),
    )
    expect(financialClient.registerPoolSelection).toHaveBeenCalledTimes(2)
    expect(financialClient.registerPoolSelection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: 'race:race-1:selection:horse-1:register',
        raceId: 'race-1',
        selectionId: 'horse-1',
        displayName: 'Horse 1',
      }),
    )
    expect(financialClient.registerPoolSelection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: 'race:race-1:selection:horse-2:register',
        raceId: 'race-1',
        selectionId: 'horse-2',
        displayName: 'Horse 2',
      }),
    )
    expect(financialClient.applyCarryoversToRace).toHaveBeenCalledTimes(1)
    expect(financialClient.applyCarryoversToRace).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'race:race-1:carryovers:apply',
        targetRaceId: 'race-1',
        currency: 'USDC',
      }),
    )
  })

  it('deduplicates concurrent race pool orchestration for one race', async () => {
    const financialClient = createFinancialClient()
    const service = new DefaultRaceFinancialLifecycleService({ financialClient })

    await Promise.all([
      service.ensureRacePoolOpen({
        raceId: 'race-1',
        selections: [{ selectionId: 'horse-1' }],
      }),
      service.ensureRacePoolOpen({
        raceId: 'race-1',
        selections: [{ selectionId: 'horse-1' }],
      }),
    ])

    expect(financialClient.createRacePool).toHaveBeenCalledTimes(1)
    expect(financialClient.registerPoolSelection).toHaveBeenCalledTimes(1)
    expect(financialClient.applyCarryoversToRace).toHaveBeenCalledTimes(1)
  })

  it('freezes a race pool exactly once for duplicate betting-close events', async () => {
    const financialClient = createFinancialClient()
    const service = new DefaultRaceFinancialLifecycleService({ financialClient })

    await service.freezeRacePool('race-1')
    await service.freezeRacePool('race-1')

    expect(financialClient.freezePool).toHaveBeenCalledTimes(1)
    expect(financialClient.freezePool).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'race:race-1:pool:freeze',
        raceId: 'race-1',
        currency: 'USDC',
        reasonCode: 'race_started',
      }),
    )
  })
})

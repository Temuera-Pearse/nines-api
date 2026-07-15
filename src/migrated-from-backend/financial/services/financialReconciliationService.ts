import {
  getBetRepository,
  type BetRepository,
} from '../db/betRepository.js'
import {
  getRaceRepository,
  type RaceRepository,
} from '../db/raceRepository.js'
import type { RaceLifecycleStatus } from '../db/types.js'
import {
  getNinesFinancialClient,
  NinesFinancialCommandError,
  type FinancialBet,
  type NinesFinancialClient,
  type RacePoolWithSelections,
} from '../financial/ninesFinancialClient.js'

export type FinancialReconciliationIssueCode =
  | 'BACKEND_RACE_MISSING_FINANCIAL_POOL'
  | 'BACKEND_CLOSED_RACE_FINANCIAL_POOL_OPEN'
  | 'BACKEND_RACE_SETTLED_FINANCIAL_SETTLEMENT_MISSING'
  | 'FINANCIAL_ACCEPTED_BET_MISSING_BACKEND_READ_MODEL'
  | 'BACKEND_LOCAL_BET_MISSING_FINANCIAL_ACCEPTED_BET'

export interface FinancialReconciliationIssue {
  code: FinancialReconciliationIssueCode
  raceId: string
  betId?: string
  message: string
}

export interface RaceFinancialReconciliationReport {
  raceId: string
  checkedAt: string
  issues: FinancialReconciliationIssue[]
}

export interface FinancialReconciliationService {
  detectRaceDrift(raceId: string): Promise<RaceFinancialReconciliationReport>
}

export interface FinancialReconciliationServiceDependencies {
  raceRepository?: RaceRepository
  betRepository?: BetRepository
  financialClient?: NinesFinancialClient
  now?: () => Date
}

const closedBackendRaceStatuses: RaceLifecycleStatus[] = [
  'running',
  'finished',
  'results_showing',
  'archived',
]

const settledBackendRaceStatuses: RaceLifecycleStatus[] = [
  'finished',
  'results_showing',
  'archived',
]

export class DefaultFinancialReconciliationService
  implements FinancialReconciliationService
{
  private readonly raceRepository: RaceRepository
  private readonly betRepository: BetRepository
  private readonly financialClient: NinesFinancialClient
  private readonly now: () => Date

  constructor(dependencies: FinancialReconciliationServiceDependencies = {}) {
    this.raceRepository = dependencies.raceRepository ?? getRaceRepository()
    this.betRepository = dependencies.betRepository ?? getBetRepository()
    this.financialClient =
      dependencies.financialClient ?? getNinesFinancialClient()
    this.now = dependencies.now ?? (() => new Date())
  }

  async detectRaceDrift(
    raceId: string,
  ): Promise<RaceFinancialReconciliationReport> {
    const issues: FinancialReconciliationIssue[] = []
    const race = await this.raceRepository.findRaceById(raceId)
    const pool = await this.getFinancialRacePoolOrNull(raceId)
    const localBets = await this.betRepository.listBetsByRaceId(raceId)
    const financialBets = await this.financialClient.listFinancialBetsByRace(
      raceId,
    )
    const financialAcceptedBets = financialBets.filter(
      (bet) => bet.status === 'accepted',
    )

    if (race && !pool) {
      issues.push({
        code: 'BACKEND_RACE_MISSING_FINANCIAL_POOL',
        raceId,
        message: 'Backend race exists but no financial race pool exists',
      })
    }

    if (
      race &&
      pool?.pool.status === 'open' &&
      closedBackendRaceStatuses.includes(race.lifecycleStatus)
    ) {
      issues.push({
        code: 'BACKEND_CLOSED_RACE_FINANCIAL_POOL_OPEN',
        raceId,
        message:
          'Backend race is no longer accepting bets but financial pool remains open',
      })
    }

    if (
      race?.winnerId &&
      pool &&
      pool.pool.status !== 'settled' &&
      settledBackendRaceStatuses.includes(race.lifecycleStatus)
    ) {
      issues.push({
        code: 'BACKEND_RACE_SETTLED_FINANCIAL_SETTLEMENT_MISSING',
        raceId,
        message:
          'Backend race has final result state but financial pool is not settled',
      })
    }

    issues.push(
      ...this.detectAcceptedBetReadModelDrift(raceId, financialAcceptedBets, localBets),
    )

    return {
      raceId,
      checkedAt: this.now().toISOString(),
      issues,
    }
  }

  private detectAcceptedBetReadModelDrift(
    raceId: string,
    financialAcceptedBets: FinancialBet[],
    localBets: Awaited<ReturnType<BetRepository['listBetsByRaceId']>>,
  ): FinancialReconciliationIssue[] {
    const issues: FinancialReconciliationIssue[] = []
    const localBetIds = new Set(localBets.map((bet) => bet.id))
    const financialAcceptedBetIds = new Set(
      financialAcceptedBets.map((bet) => bet.betId),
    )

    for (const bet of financialAcceptedBets) {
      if (!localBetIds.has(bet.betId)) {
        issues.push({
          code: 'FINANCIAL_ACCEPTED_BET_MISSING_BACKEND_READ_MODEL',
          raceId,
          betId: bet.betId,
          message:
            'Financial accepted bet exists without a backend local bet read model row',
        })
      }
    }

    for (const bet of localBets) {
      if (
        bet.status === 'placed' &&
        bet.resultStatus === 'pending' &&
        !financialAcceptedBetIds.has(bet.id)
      ) {
        issues.push({
          code: 'BACKEND_LOCAL_BET_MISSING_FINANCIAL_ACCEPTED_BET',
          raceId,
          betId: bet.id,
          message:
            'Backend local bet read model row exists without a matching accepted financial bet',
        })
      }
    }

    return issues
  }

  private async getFinancialRacePoolOrNull(
    raceId: string,
  ): Promise<RacePoolWithSelections | null> {
    try {
      return await this.financialClient.getRacePool(raceId)
    } catch (error) {
      if (error instanceof NinesFinancialCommandError && error.status === 404) {
        return null
      }

      throw error
    }
  }
}

let sharedFinancialReconciliationService:
  | FinancialReconciliationService
  | null = null

export function getFinancialReconciliationService(): FinancialReconciliationService {
  if (!sharedFinancialReconciliationService) {
    sharedFinancialReconciliationService =
      new DefaultFinancialReconciliationService()
  }

  return sharedFinancialReconciliationService
}

import {
  CANONICAL_FRONT_OF_HOUSE_CURRENCY,
} from '../financial/legacyAlphaFinancialAuthority.js'
import {
  getNinesFinancialClient,
  type FinancialCurrency,
  type NinesFinancialClient,
} from '../financial/ninesFinancialClient.js'

export interface RaceFinancialSelection {
  selectionId: string
  displayName?: string | null
}

export interface EnsureRacePoolInput {
  raceId: string
  selections: readonly RaceFinancialSelection[]
  currency?: FinancialCurrency
  bettingOpensAt?: string | null
  bettingClosesAt?: string | null
}

export interface RaceFinancialLifecycleService {
  ensureRacePoolOpen(input: EnsureRacePoolInput): Promise<void>
  freezeRacePool(
    raceId: string,
    reasonCode?: string,
    currency?: FinancialCurrency,
  ): Promise<void>
}

export interface RaceFinancialLifecycleServiceDependencies {
  financialClient?: NinesFinancialClient
}

export class DefaultRaceFinancialLifecycleService
  implements RaceFinancialLifecycleService
{
  private readonly financialClient: NinesFinancialClient
  private readonly poolOpenInFlight = new Map<string, Promise<void>>()
  private readonly poolOpenCompleted = new Set<string>()
  private readonly freezeInFlight = new Map<string, Promise<void>>()
  private readonly freezeCompleted = new Set<string>()

  constructor(dependencies: RaceFinancialLifecycleServiceDependencies = {}) {
    this.financialClient =
      dependencies.financialClient ?? getNinesFinancialClient()
  }

  ensureRacePoolOpen(input: EnsureRacePoolInput): Promise<void> {
    const currency = input.currency ?? CANONICAL_FRONT_OF_HOUSE_CURRENCY
    const key = `${input.raceId}:${currency}`

    if (this.poolOpenCompleted.has(key)) {
      return Promise.resolve()
    }

    const existing = this.poolOpenInFlight.get(key)
    if (existing) {
      return existing
    }

    const work = this.openRacePool(input, currency)
      .then(() => {
        this.poolOpenCompleted.add(key)
      })
      .finally(() => {
        this.poolOpenInFlight.delete(key)
      })

    this.poolOpenInFlight.set(key, work)
    return work
  }

  freezeRacePool(
    raceId: string,
    reasonCode = 'race_started',
    currency: FinancialCurrency = CANONICAL_FRONT_OF_HOUSE_CURRENCY,
  ): Promise<void> {
    const key = `${raceId}:${currency}`

    if (this.freezeCompleted.has(key)) {
      return Promise.resolve()
    }

    const existing = this.freezeInFlight.get(key)
    if (existing) {
      return existing
    }

    const work = this.financialClient
      .freezePool({
        idempotencyKey: `race:${raceId}:pool:freeze`,
        correlationId: `race:${raceId}:pool:freeze`,
        causationId: `race:${raceId}:betting-close`,
        raceId,
        currency,
        reasonCode,
      })
      .then(() => {
        this.freezeCompleted.add(key)
      })
      .finally(() => {
        this.freezeInFlight.delete(key)
      })

    this.freezeInFlight.set(key, work)
    return work
  }

  private async openRacePool(
    input: EnsureRacePoolInput,
    currency: FinancialCurrency,
  ): Promise<void> {
    const selections = this.uniqueSelections(input.selections)

    if (selections.length === 0) {
      throw new Error(`race ${input.raceId} has no financial pool selections`)
    }

    await this.financialClient.createRacePool({
      idempotencyKey: `race:${input.raceId}:pool:create`,
      correlationId: `race:${input.raceId}:pool:create`,
      causationId: `race:${input.raceId}:seeded`,
      raceId: input.raceId,
      currency,
      bettingOpensAt: input.bettingOpensAt ?? null,
      bettingClosesAt: input.bettingClosesAt ?? null,
    })

    for (const selection of selections) {
      await this.financialClient.registerPoolSelection({
        idempotencyKey: `race:${input.raceId}:selection:${selection.selectionId}:register`,
        correlationId: `race:${input.raceId}:selection:${selection.selectionId}:register`,
        causationId: `race:${input.raceId}:pool:create`,
        raceId: input.raceId,
        selectionId: selection.selectionId,
        currency,
        status: 'active',
        displayName: selection.displayName ?? null,
      })
    }

    await this.financialClient.applyCarryoversToRace({
      idempotencyKey: `race:${input.raceId}:carryovers:apply`,
      correlationId: `race:${input.raceId}:carryovers:apply`,
      causationId: `race:${input.raceId}:pool:create`,
      targetRaceId: input.raceId,
      currency,
    })
  }

  private uniqueSelections(
    selections: readonly RaceFinancialSelection[],
  ): RaceFinancialSelection[] {
    const seen = new Set<string>()
    const result: RaceFinancialSelection[] = []

    for (const selection of selections) {
      const selectionId = selection.selectionId.trim()

      if (!selectionId || seen.has(selectionId)) {
        continue
      }

      seen.add(selectionId)
      result.push({
        selectionId,
        displayName: selection.displayName?.trim() || null,
      })
    }

    return result
  }
}

let sharedRaceFinancialLifecycleService:
  | RaceFinancialLifecycleService
  | null = null

export function getRaceFinancialLifecycleService(): RaceFinancialLifecycleService {
  if (!sharedRaceFinancialLifecycleService) {
    sharedRaceFinancialLifecycleService =
      new DefaultRaceFinancialLifecycleService()
  }

  return sharedRaceFinancialLifecycleService
}

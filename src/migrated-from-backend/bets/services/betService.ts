import { randomUUID } from 'crypto'
import type { Pool } from 'pg'
import { getPool } from '../db/pool.js'
import {
  getBetRepository,
  type BetRepository,
} from '../db/betRepository.js'
import {
  getRaceRepository,
  type RaceRepository,
} from '../db/raceRepository.js'
import {
  getWalletRepository,
  type WalletRepository,
} from '../db/walletRepository.js'
import { RaceState } from '../race/raceState.js'
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../user/errors.js'
import type { WalletLedgerEntryRecord, WalletRecord } from '../user/types.js'
import type { BetRecord, PlaceBetInput } from '../bet/types.js'
import {
  assertLegacyAlphaFinancialMutationPath,
  CANONICAL_FRONT_OF_HOUSE_CURRENCY,
  isLegacyAlphaFinancialFallbackEnabled,
  LEGACY_ALPHA_FINANCIAL_AUTHORITY_WARNING,
  normalizeFinancialCurrency,
} from '../financial/legacyAlphaFinancialAuthority.js'
import {
  getNinesFinancialClient,
  type FinancialCurrency,
  type NinesFinancialClient,
  type PlaceBetFinancialResult,
  type ReserveStakeResult,
} from '../financial/ninesFinancialClient.js'
import { getUserService, type UserService } from './userService.js'
import { applyWalletDeltaInTransaction } from './walletService.js'

export interface PlaceBetResult {
  bet: BetRecord
  wallet: WalletRecord
  ledgerEntry: WalletLedgerEntryRecord | null
  financialReservation: ReserveStakeResult | null
  financialBet: PlaceBetFinancialResult | null
}

export interface BetService {
  placeBet(input: PlaceBetInput): Promise<PlaceBetResult>
  getBetById(betId: string): Promise<BetRecord>
  listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]>
}

function normalizeCurrency(currency?: string): string {
  return normalizeFinancialCurrency(currency)
}

function requireCanonicalFinancialCurrency(currency: string): FinancialCurrency {
  if (currency !== CANONICAL_FRONT_OF_HOUSE_CURRENCY) {
    throw new ValidationError('currency must be USDC for financial authority flows')
  }

  return CANONICAL_FRONT_OF_HOUSE_CURRENCY
}

function ensurePositiveStake(stakeMinor: bigint): void {
  if (stakeMinor <= 0n) {
    throw new ValidationError('stakeMinor must be greater than zero')
  }
}

function normalizeBetType(): 'win' {
  return 'win'
}

function assertRaceOpenAndSelectionValid(
  raceId: string,
  selectionId: string,
): void {
  const precomputed = RaceState.getPrecomputedRace()
  const phase = RaceState.getStateMachine().getPhaseAndSecond().phase

  if (!precomputed || precomputed.id !== raceId) {
    throw new ValidationError('race is not open for betting')
  }

  if (!['idle', 'countdown'].includes(phase)) {
    throw new ValidationError('race is closed for betting')
  }

  const validSelection = precomputed.horses.some((horse) => horse.id === selectionId)
  if (!validSelection) {
    throw new ValidationError('selection is not valid for race')
  }
}

export interface BetServiceDependencies {
  betRepository?: BetRepository
  walletRepository?: WalletRepository
  raceRepository?: RaceRepository
  userService?: UserService
  financialClient?: NinesFinancialClient
  poolFactory?: () => Pool
  legacyAlphaFallbackEnabled?: () => boolean
  applyWalletDelta?: typeof applyWalletDeltaInTransaction
}

export class DefaultBetService implements BetService {
  private readonly betRepository: BetRepository
  private readonly walletRepository: WalletRepository
  private readonly raceRepository: RaceRepository
  private readonly userService: UserService
  private readonly financialClient: NinesFinancialClient
  private readonly poolFactory: () => Pool
  private readonly legacyAlphaFallbackEnabled: () => boolean
  private readonly applyWalletDelta: typeof applyWalletDeltaInTransaction

  constructor(dependencies: BetServiceDependencies = {}) {
    this.betRepository = dependencies.betRepository ?? getBetRepository()
    this.walletRepository = dependencies.walletRepository ?? getWalletRepository()
    this.raceRepository = dependencies.raceRepository ?? getRaceRepository()
    this.userService = dependencies.userService ?? getUserService()
    this.financialClient =
      dependencies.financialClient ?? getNinesFinancialClient()
    this.poolFactory = dependencies.poolFactory ?? getPool
    this.legacyAlphaFallbackEnabled =
      dependencies.legacyAlphaFallbackEnabled ??
      isLegacyAlphaFinancialFallbackEnabled
    this.applyWalletDelta =
      dependencies.applyWalletDelta ?? applyWalletDeltaInTransaction
  }

  async placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
    ensurePositiveStake(input.stakeMinor)

    const eligibility = await this.userService.getBetEligibility(input.userId)
    if (!eligibility.allowed) {
      throw new ForbiddenError(
        `user is not eligible to bet: ${eligibility.reasons.join(', ')}`,
      )
    }

    assertRaceOpenAndSelectionValid(input.raceId, input.selectionId)

    const raceRecord = await this.raceRepository.findRaceById(input.raceId)
    if (!raceRecord || raceRecord.lifecycleStatus !== 'seeded') {
      throw new ValidationError('race is not open for betting')
    }

    const currency = normalizeCurrency(input.currency)
    const financialCurrency = requireCanonicalFinancialCurrency(currency)

    if (this.legacyAlphaFallbackEnabled()) {
      return this.placeBetViaLegacyAlphaMutation(input, financialCurrency)
    }

    const betId = randomUUID()
    const idempotencyKey =
      input.idempotencyKey?.trim() || `bet:${betId}:place-bet`
    const wallet = await this.walletRepository.findWalletByUserId(
      input.userId,
      financialCurrency,
    )

    if (!wallet) {
      throw new NotFoundError('wallet not found')
    }

    const financialBet = await this.financialClient.placeBet({
      idempotencyKey,
      correlationId: `bet:${betId}`,
      causationId: `race:${input.raceId}`,
      userId: input.userId,
      betId,
      raceId: input.raceId,
      selectionId: input.selectionId,
      stakeMinor: input.stakeMinor.toString(),
      currency: financialCurrency,
    })

    if (!financialBet.accepted || !financialBet.reservationId) {
      throw new ValidationError(
        financialBet.bet.rejectionReason ??
          financialBet.bet.rejectionCode ??
          'bet was rejected by nines-financial',
      )
    }

    const financialReservation: ReserveStakeResult = {
      reservationId: financialBet.reservationId,
      acceptedAt:
        financialBet.bet.acceptedAt ?? new Date().toISOString(),
    }
    const pool = this.poolFactory()
    const client = await pool.connect()

    try {
      await client.query('begin')

      const bet = await this.betRepository.createBet(
        {
          id: betId,
          userId: input.userId,
          walletId: wallet.id,
          raceId: input.raceId,
          currency: financialCurrency,
          betType: normalizeBetType(),
          selectionId: input.selectionId,
          stakeMinor: input.stakeMinor,
          payoutMinor: null,
          status: 'placed',
          resultStatus: 'pending',
          metadata: {
            ...(input.metadata ?? {}),
            financialAuthority: 'nines-financial',
            financialCommand: 'placeBet',
            financialBetStatus: financialBet.bet.status,
            financialReservationId: financialReservation.reservationId,
          },
        },
        client,
      )

      await client.query('commit')
      return {
        bet,
        wallet,
        ledgerEntry: null,
        financialReservation,
        financialBet,
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  private async placeBetViaLegacyAlphaMutation(
    input: PlaceBetInput,
    currency: FinancialCurrency,
  ): Promise<PlaceBetResult> {
    assertLegacyAlphaFinancialMutationPath('DefaultBetService.placeBet')
    void LEGACY_ALPHA_FINANCIAL_AUTHORITY_WARNING

    const pool = this.poolFactory()
    const client = await pool.connect()

    try {
      await client.query('begin')

      const wallet = await this.walletRepository.findWalletByUserIdForUpdate(
        input.userId,
        currency,
        client,
      )
      if (!wallet) {
        throw new NotFoundError('wallet not found')
      }

      if (wallet.balanceMinor < input.stakeMinor) {
        throw new ValidationError('insufficient balance')
      }

      const bet = await this.betRepository.createBet(
        {
          id: randomUUID(),
          userId: input.userId,
          walletId: wallet.id,
          raceId: input.raceId,
          currency,
          betType: normalizeBetType(),
          selectionId: input.selectionId,
          stakeMinor: input.stakeMinor,
          payoutMinor: null,
          status: 'placed',
          resultStatus: 'pending',
          metadata: input.metadata ?? {},
        },
        client,
      )

      const adjusted = await this.applyWalletDelta(
        {
          userId: input.userId,
          amountMinor: -input.stakeMinor,
          currency,
          entryType: 'bet_stake',
          referenceType: 'bet',
          referenceId: bet.id,
          metadata: {
            raceId: bet.raceId,
            selectionId: bet.selectionId,
            betType: bet.betType,
            ...bet.metadata,
          },
        },
        client,
      )

      await client.query('commit')
      return {
        bet,
        wallet: adjusted.wallet,
        ledgerEntry: adjusted.ledgerEntry,
        financialReservation: null,
        financialBet: null,
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async getBetById(betId: string): Promise<BetRecord> {
    const bet = await this.betRepository.findBetById(betId)
    if (!bet) {
      throw new NotFoundError('bet not found')
    }
    return bet
  }

  async listBetsByUserId(userId: string, limit?: number): Promise<BetRecord[]> {
    return this.betRepository.listBetsByUserId(userId, limit)
  }
}

let sharedBetService: BetService | null = null

export function getBetService(): BetService {
  if (!sharedBetService) {
    sharedBetService = new DefaultBetService()
  }
  return sharedBetService
}

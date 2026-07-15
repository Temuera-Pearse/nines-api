import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HttpNinesFinancialClient,
  NinesFinancialCommandError,
  NinesFinancialClientConfigurationError,
} from './ninesFinancialClient.js'

const baseUrl = 'http://nines-financial.test'

const contractReserveStakeCommand = {
  idempotencyKey: 'phase-2-8-reserve-stake',
  correlationId: 'corr_phase_2_8_reserve_stake',
  causationId: 'cause_phase_2_8_reserve_stake',
  userId: 'player-contract-1',
  betId: 'bet-contract-1',
  raceId: 'race-contract-1',
  selectionId: 'horse-1',
  stakeMinor: '1200',
  currency: 'USDC',
} as const

const contractPlaceBetCommand = {
  idempotencyKey: 'phase-3-0-place-bet',
  correlationId: 'corr_phase_3_0_place_bet',
  causationId: 'cause_phase_3_0_place_bet',
  userId: 'player-contract-1',
  betId: 'bet-contract-1',
  raceId: 'race-contract-1',
  selectionId: 'horse-1',
  stakeMinor: '1200',
  currency: 'USDC',
} as const

const contractCreateRacePoolCommand = {
  idempotencyKey: 'phase-3-1-create-race-pool',
  correlationId: 'corr_phase_3_1_create_race_pool',
  causationId: 'cause_phase_3_1_create_race_pool',
  raceId: 'race-contract-1',
  currency: 'USDC',
  bettingOpensAt: null,
  bettingClosesAt: null,
} as const

const contractRegisterPoolSelectionCommand = {
  idempotencyKey: 'phase-3-1-register-pool-selection',
  correlationId: 'corr_phase_3_1_register_pool_selection',
  causationId: 'cause_phase_3_1_register_pool_selection',
  raceId: 'race-contract-1',
  selectionId: 'horse-1',
  currency: 'USDC',
  status: 'active',
  displayName: 'Horse 1',
} as const

const contractFreezePoolCommand = {
  idempotencyKey: 'phase-3-1-freeze-pool',
  correlationId: 'corr_phase_3_1_freeze_pool',
  causationId: 'cause_phase_3_1_freeze_pool',
  raceId: 'race-contract-1',
  currency: 'USDC',
  reasonCode: 'race_started',
} as const

const contractApplyCarryoversToRaceCommand = {
  idempotencyKey: 'phase-3-4-apply-carryovers',
  correlationId: 'corr_phase_3_4_apply_carryovers',
  causationId: 'cause_phase_3_4_apply_carryovers',
  targetRaceId: 'race-contract-1',
  currency: 'USDC',
} as const

const contractReleaseReservationCommand = {
  idempotencyKey: 'phase-2-8-release-reservation',
  correlationId: 'corr_phase_2_8_release_reservation',
  causationId: 'cause_phase_2_8_release_reservation',
  reservationId: 'txn_reservation_contract_1',
  reasonCode: 'bet_cancelled',
} as const

const contractSettleBetCommand = {
  idempotencyKey: 'phase-2-8-settle-bet',
  correlationId: 'corr_phase_2_8_settle_bet',
  causationId: 'cause_phase_2_8_settle_bet',
  raceId: 'race-contract-1',
  winningSelectionId: 'horse-1',
  houseTakeBps: 0,
  currency: 'USDC',
} as const

const contractApplyHouseTakeCommand = {
  idempotencyKey: 'phase-2-8-apply-house-take',
  correlationId: 'corr_phase_2_8_apply_house_take',
  causationId: 'cause_phase_2_8_apply_house_take',
  raceId: 'race-contract-1',
  amountMinor: '300',
  currency: 'USDC',
} as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function readPostedJson(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

function expectCommandRequest(
  fetchMock: ReturnType<typeof vi.fn>,
  expected: {
    path: string
    body: Record<string, unknown>
  },
) {
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
  const headers = init.headers as Record<string, string>

  expect(url.toString()).toBe(`${baseUrl}${expected.path}`)
  expect(init.method).toBe('POST')
  expect(headers['content-type']).toBe('application/json')
  expect(headers['idempotency-key']).toBe(expected.body.idempotencyKey)
  expect(headers['x-correlation-id']).toBe(expected.body.correlationId)
  expect(headers['x-causation-id']).toBe(expected.body.causationId)
  expect(readPostedJson(init)).toEqual(expected.body)
}

describe('HttpNinesFinancialClient contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let client: HttpNinesFinancialClient

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    client = new HttpNinesFinancialClient(baseUrl)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends createRacePool to the financial pool lifecycle command contract', async () => {
    const responseBody = {
      raceId: 'race-contract-1',
      currency: 'USDC',
      status: 'open',
      bettingOpensAt: null,
      bettingClosesAt: null,
      createdAt: '2026-04-22T12:00:00.000Z',
      updatedAt: '2026-04-22T12:00:00.000Z',
      frozenAt: null,
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody, 201))

    await expect(
      client.createRacePool(contractCreateRacePoolCommand),
    ).resolves.toEqual(responseBody)

    expectCommandRequest(fetchMock, {
      path: '/commands/create-race-pool',
      body: contractCreateRacePoolCommand,
    })
  })

  it('sends registerPoolSelection to the financial pool lifecycle command contract', async () => {
    const responseBody = {
      raceId: 'race-contract-1',
      selectionId: 'horse-1',
      currency: 'USDC',
      status: 'active',
      displayName: 'Horse 1',
      createdAt: '2026-04-22T12:00:00.000Z',
      updatedAt: '2026-04-22T12:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody, 201))

    await expect(
      client.registerPoolSelection(contractRegisterPoolSelectionCommand),
    ).resolves.toEqual(responseBody)

    expectCommandRequest(fetchMock, {
      path: '/commands/register-pool-selection',
      body: contractRegisterPoolSelectionCommand,
    })
  })

  it('sends freezePool to the financial pool lifecycle command contract', async () => {
    const responseBody = {
      raceId: 'race-contract-1',
      currency: 'USDC',
      status: 'frozen',
      bettingOpensAt: null,
      bettingClosesAt: null,
      createdAt: '2026-04-22T12:00:00.000Z',
      updatedAt: '2026-04-22T12:00:30.000Z',
      frozenAt: '2026-04-22T12:00:30.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(client.freezePool(contractFreezePoolCommand)).resolves.toEqual(
      responseBody,
    )

    expectCommandRequest(fetchMock, {
      path: '/commands/freeze-pool',
      body: contractFreezePoolCommand,
    })
  })

  it('sends applyCarryoversToRace to the financial carryover command contract', async () => {
    const responseBody = {
      applicationId: 'carryover_application_contract_1',
      targetRaceId: 'race-contract-1',
      currency: 'USDC',
      totalAppliedMinor: '900',
      appliedCarryovers: [
        {
          carryoverId: 'settlement_carryover_contract_1',
          sourceRaceId: 'race-contract-0',
          targetRaceId: 'race-contract-1',
          currency: 'USDC',
          amountMinor: '900',
          status: 'applied',
          reasonCode: 'NO_WINNING_STAKE_ROLLOVER',
          applicationId: 'carryover_application_contract_1',
          applicationTransactionId: 'txn_carryover_apply_contract_1',
          appliedAt: '2026-04-22T12:00:00.000Z',
          createdAt: '2026-04-22T11:00:00.000Z',
          updatedAt: '2026-04-22T12:00:00.000Z',
        },
      ],
      appliedAt: '2026-04-22T12:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(
      client.applyCarryoversToRace(contractApplyCarryoversToRaceCommand),
    ).resolves.toEqual(responseBody)

    expectCommandRequest(fetchMock, {
      path: '/commands/apply-carryovers-to-race',
      body: contractApplyCarryoversToRaceCommand,
    })
  })

  it('sends placeBet to the financial betting intake command contract', async () => {
    const responseBody = {
      accepted: true,
      reservationId: 'txn_reservation_contract_1',
      bet: {
        betId: 'bet-contract-1',
        userId: 'player-contract-1',
        raceId: 'race-contract-1',
        selectionId: 'horse-1',
        stakeMinor: '1200',
        currency: 'USDC',
        status: 'accepted',
        rejectionCode: null,
        rejectionReason: null,
        reservationId: 'txn_reservation_contract_1',
        acceptedAt: '2026-04-22T12:00:00.000Z',
        rejectedAt: null,
        createdAt: '2026-04-22T12:00:00.000Z',
        updatedAt: '2026-04-22T12:00:00.000Z',
      },
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody, 201))

    await expect(client.placeBet(contractPlaceBetCommand)).resolves.toEqual(
      responseBody,
    )

    expectCommandRequest(fetchMock, {
      path: '/commands/place-bet',
      body: contractPlaceBetCommand,
    })
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1]).stakeMinor).toBe('1200')
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1]).currency).toBe('USDC')
  })

  it('sends reserveStake to the financial reserve command contract', async () => {
    const responseBody = {
      reservationId: 'txn_reservation_contract_1',
      acceptedAt: '2026-04-22T12:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody, 201))

    await expect(client.reserveStake(contractReserveStakeCommand)).resolves.toEqual(
      responseBody,
    )

    expectCommandRequest(fetchMock, {
      path: '/commands/reserve-stake',
      body: contractReserveStakeCommand,
    })
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1]).stakeMinor).toBe('1200')
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1]).currency).toBe('USDC')
  })

  it('sends releaseReservation to the financial release command contract', async () => {
    const responseBody = {
      reservationId: 'txn_reservation_contract_1',
      releasedAt: '2026-04-22T12:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(
      client.releaseReservation(contractReleaseReservationCommand),
    ).resolves.toEqual(responseBody)

    expectCommandRequest(fetchMock, {
      path: '/commands/release-reservation',
      body: contractReleaseReservationCommand,
    })
  })

  it('sends settleBet to the financial settlement command contract', async () => {
    const responseBody = {
      settlementRunId: 'settlement_run_contract_1',
      status: 'completed',
      reasonCode: null,
      raceId: 'race-contract-1',
      winningSelectionId: 'horse-1',
      totalPoolMinor: '2000',
      houseTakeMinor: '0',
      netPoolMinor: '2000',
      roundingResidualMinor: '0',
      carryoverMinor: '0',
      settledBets: [
        {
          betId: 'bet-contract-1',
          userId: 'player-contract-1',
          selectionId: 'horse-1',
          resultStatus: 'won',
          stakeMinor: '1200',
          payoutMinor: '2000',
          captureTransactionId: 'txn_capture_contract_1',
          payoutTransactionId: 'txn_payout_contract_1',
        },
        {
          betId: 'bet-contract-2',
          userId: 'player-contract-2',
          selectionId: 'horse-2',
          resultStatus: 'lost',
          stakeMinor: '800',
          payoutMinor: '0',
          captureTransactionId: 'txn_capture_contract_2',
          payoutTransactionId: null,
        },
      ],
      settledAt: '2026-04-22T12:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(client.settleBet(contractSettleBetCommand)).resolves.toEqual(
      responseBody,
    )

    expectCommandRequest(fetchMock, {
      path: '/commands/settle-bet',
      body: contractSettleBetCommand,
    })
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1])).not.toHaveProperty(
      'acceptedBets',
    )
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1])).not.toHaveProperty(
      'totalPoolMinor',
    )
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1]).houseTakeBps).toBe(0)
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1]).currency).toBe('USDC')
  })

  it('sends applyHouseTake to the financial house-take command contract', async () => {
    const responseBody = {
      raceId: 'race-contract-1',
      amountMinor: '300',
      appliedAt: '2026-04-22T12:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(
      client.applyHouseTake(contractApplyHouseTakeCommand),
    ).resolves.toEqual(responseBody)

    expectCommandRequest(fetchMock, {
      path: '/commands/apply-house-take',
      body: contractApplyHouseTakeCommand,
    })
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1]).amountMinor).toBe('300')
    expect(readPostedJson(fetchMock.mock.calls[0]?.[1]).currency).toBe('USDC')
  })

  it('reads race pool lifecycle state using the backend-compatible financial route', async () => {
    const responseBody = {
      pool: {
        raceId: 'race-contract-1',
        currency: 'USDC',
        status: 'frozen',
        bettingOpensAt: null,
        bettingClosesAt: null,
        createdAt: '2026-04-22T12:00:00.000Z',
        updatedAt: '2026-04-22T12:00:30.000Z',
        frozenAt: '2026-04-22T12:00:30.000Z',
      },
      selections: [
        {
          raceId: 'race-contract-1',
          selectionId: 'horse-1',
          currency: 'USDC',
          status: 'active',
          displayName: 'Horse 1',
          createdAt: '2026-04-22T12:00:00.000Z',
          updatedAt: '2026-04-22T12:00:00.000Z',
        },
      ],
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(client.getRacePool('race-contract-1')).resolves.toEqual(
      responseBody,
    )

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toBe(`${baseUrl}/races/race-contract-1/pool`)
    expect(init.method).toBe('GET')
  })

  it('lists financial bets by race using the backend settlement read contract', async () => {
    const responseBody = {
      bets: [
        {
          betId: 'bet-contract-1',
          userId: 'player-contract-1',
          raceId: 'race-contract-1',
          selectionId: 'horse-1',
          stakeMinor: '1200',
          currency: 'USDC',
          status: 'accepted',
          rejectionCode: null,
          rejectionReason: null,
          reservationId: 'txn_reservation_contract_1',
          acceptedAt: '2026-04-22T12:00:00.000Z',
          rejectedAt: null,
          createdAt: '2026-04-22T12:00:00.000Z',
          updatedAt: '2026-04-22T12:00:00.000Z',
        },
      ],
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(
      client.listFinancialBetsByRace('race-contract-1'),
    ).resolves.toEqual(responseBody.bets)

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toBe(`${baseUrl}/races/race-contract-1/bets`)
    expect(init.method).toBe('GET')
  })

  it('reads player account summary using the backend-compatible financial route', async () => {
    const responseBody = {
      playerAccountId: 'pa_contract_1',
      userId: 'player-contract-1',
      currency: 'USDC',
      effectiveStatus: 'active',
      displayBalanceMinor: '5000',
      spendableBalanceMinor: '3800',
      asOf: '2026-04-22T12:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(
      client.getPlayerAccountSummary('player-contract-1'),
    ).resolves.toEqual(responseBody)

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toBe(
      `${baseUrl}/player/accounts/player-contract-1/USDC`,
    )
    expect(init.method).toBe('GET')
  })

  it('reads player balance using the backend-compatible financial route', async () => {
    const responseBody = {
      playerAccountId: 'pa_contract_1',
      currency: 'USDC',
      spendableBalanceMinor: '3800',
      lockedBalanceMinor: '1200',
      restrictedBalanceMinor: '0',
      displayBalanceMinor: '5000',
      asOf: '2026-04-22T12:00:00.000Z',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody))

    await expect(client.getPlayerBalance('player-contract-1')).resolves.toEqual(
      responseBody,
    )

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toBe(
      `${baseUrl}/player/accounts/player-contract-1/USDC/balance`,
    )
    expect(init.method).toBe('GET')
  })

  it('maps nines-financial command errors without losing response details', async () => {
    const responseBody = {
      error: {
        category: 'conflict',
        code: 'INSUFFICIENT_FUNDS',
        message: 'Account does not have sufficient funds for the requested debit',
        retryable: false,
        details: {
          accountId: 'acct_available_contract_1',
          currentBalanceMinor: '0',
          requestedDebitMinor: '1200',
        },
      },
      correlationId: 'corr_phase_2_8_reserve_stake',
      causationId: 'cause_phase_2_8_reserve_stake',
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody, 409))

    try {
      await client.reserveStake(contractReserveStakeCommand)
      throw new Error('Expected reserveStake to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(NinesFinancialCommandError)
      expect(error).toMatchObject({
        name: 'NinesFinancialCommandError',
        status: 409,
        responseBody,
      })
    }
  })

  it('requires an explicit financial service base URL', async () => {
    await expect(
      new HttpNinesFinancialClient(undefined).getPlayerBalance(
        'player-contract-1',
      ),
    ).rejects.toBeInstanceOf(NinesFinancialClientConfigurationError)
  })
})

import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { betServiceMock } = vi.hoisted(() => ({
  betServiceMock: {
    placeBet: vi.fn(async () => ({
      bet: {
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
        placedAt: new Date('2026-03-22T00:00:00.000Z'),
        settledAt: null,
        refundedAt: null,
        metadata: { source: 'route-test' },
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      },
      wallet: {
        id: 'wallet-1',
        userId: 'user-1',
        currency: 'USDC',
        balanceMinor: 5000n,
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      },
      ledgerEntry: null,
      financialReservation: {
        reservationId: 'reservation-1',
        acceptedAt: '2026-03-22T00:00:00.000Z',
      },
      financialBet: {
        accepted: true,
        reservationId: 'reservation-1',
        bet: {
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
        },
      },
    })),
    getBetById: vi.fn(async () => ({
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
      placedAt: new Date('2026-03-22T00:00:00.000Z'),
      settledAt: null,
      refundedAt: null,
      metadata: {},
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    })),
    listBetsByUserId: vi.fn(async () => [
      {
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
        placedAt: new Date('2026-03-22T00:00:00.000Z'),
        settledAt: null,
        refundedAt: null,
        metadata: {},
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      },
    ]),
  },
}))

vi.mock('../services/betService.js', () => ({
  getBetService: () => betServiceMock,
}))

import betRoutes from './betRoutes.js'

type EnvSnapshot = NodeJS.ProcessEnv

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/bets', betRoutes)
  return app
}

let savedEnv: EnvSnapshot

beforeEach(() => {
  savedEnv = { ...process.env }
  process.env.REQUIRE_API_TOKEN = '0'
  delete process.env.API_TOKEN
})

afterEach(() => {
  process.env = savedEnv
  vi.restoreAllMocks()
})

describe('betRoutes', () => {
  it('places a bet', async () => {
    const res = await request(makeApp()).post('/bets').send({
      userId: 'user-1',
      raceId: 'race-1',
      selectionId: 'horse-3',
      stakeMinor: '1200',
      currency: 'USDC',
    })

    expect(res.status).toBe(201)
    expect(res.body.bet.id).toBe('bet-1')
    expect(res.body.wallet.balanceMinor).toBe('5000')
    expect(res.body.ledgerEntry).toBeNull()
    expect(res.body.financialReservation.reservationId).toBe('reservation-1')
    expect(res.body.financialBet.bet.status).toBe('accepted')
  })

  it('returns a bet by id', async () => {
    const res = await request(makeApp()).get('/bets/bet-1')

    expect(res.status).toBe(200)
    expect(res.body.bet.selectionId).toBe('horse-3')
  })

  it('lists bets for a user', async () => {
    const res = await request(makeApp()).get('/bets').query({ userId: 'user-1' })

    expect(res.status).toBe(200)
    expect(res.body.bets).toHaveLength(1)
    expect(res.body.bets[0].stakeMinor).toBe('1200')
  })

  it('requires api token when configured', async () => {
    process.env.REQUIRE_API_TOKEN = '1'
    process.env.API_TOKEN = 'alpha-token'

    const res = await request(makeApp()).post('/bets').send({
      userId: 'user-1',
      raceId: 'race-1',
      selectionId: 'horse-3',
      stakeMinor: '1200',
    })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })
})

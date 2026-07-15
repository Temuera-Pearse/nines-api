import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { userServiceMock, walletServiceMock } = vi.hoisted(() => ({
  userServiceMock: {
    createUser: vi.fn(async () => ({
      user: {
        id: 'user-1',
        username: 'alpha-user',
        email: 'alpha@example.com',
        accountStatus: 'active',
        dateOfBirth: '2000-01-01',
        ageVerificationStatus: 'self_attested',
        createdAt: new Date('2026-03-21T00:00:00.000Z'),
        updatedAt: new Date('2026-03-21T00:00:00.000Z'),
      },
      wallet: {
        id: 'wallet-1',
        userId: 'user-1',
        currency: 'USDC',
        balanceMinor: 0n,
        createdAt: new Date('2026-03-21T00:00:00.000Z'),
        updatedAt: new Date('2026-03-21T00:00:00.000Z'),
      },
    })),
    getUserById: vi.fn(async () => ({
      id: 'user-1',
      username: 'alpha-user',
      email: 'alpha@example.com',
      accountStatus: 'active',
      dateOfBirth: '2000-01-01',
      ageVerificationStatus: 'self_attested',
      createdAt: new Date('2026-03-21T00:00:00.000Z'),
      updatedAt: new Date('2026-03-21T00:00:00.000Z'),
    })),
    updateAccountStatus: vi.fn(async () => ({
      id: 'user-1',
      username: 'alpha-user',
      email: 'alpha@example.com',
      accountStatus: 'restricted',
      dateOfBirth: '2000-01-01',
      ageVerificationStatus: 'self_attested',
      createdAt: new Date('2026-03-21T00:00:00.000Z'),
      updatedAt: new Date('2026-03-21T00:00:00.000Z'),
    })),
    updateAgeVerificationStatus: vi.fn(async () => ({
      id: 'user-1',
      username: 'alpha-user',
      email: 'alpha@example.com',
      accountStatus: 'active',
      dateOfBirth: '2000-01-01',
      ageVerificationStatus: 'verified',
      createdAt: new Date('2026-03-21T00:00:00.000Z'),
      updatedAt: new Date('2026-03-21T00:00:00.000Z'),
    })),
    getBetEligibility: vi.fn(async () => ({ allowed: true, reasons: [] })),
  },
  walletServiceMock: {
    getWalletByUserId: vi.fn(async () => ({
      id: 'wallet-1',
      userId: 'user-1',
      currency: 'USDC',
      balanceMinor: 5000n,
      createdAt: new Date('2026-03-21T00:00:00.000Z'),
      updatedAt: new Date('2026-03-21T00:00:00.000Z'),
    })),
    creditWallet: vi.fn(async () => ({
      wallet: {
        id: 'wallet-1',
        userId: 'user-1',
        currency: 'USDC',
        balanceMinor: 7500n,
        createdAt: new Date('2026-03-21T00:00:00.000Z'),
        updatedAt: new Date('2026-03-21T00:00:00.000Z'),
      },
      ledgerEntry: {
        id: 1,
        walletId: 'wallet-1',
        entryType: 'admin_credit',
        deltaMinor: 2500n,
        balanceAfterMinor: 7500n,
        referenceType: 'admin',
        referenceId: 'seed-1',
        metadata: { note: 'seed funds' },
        createdAt: new Date('2026-03-21T00:00:00.000Z'),
      },
    })),
  },
}))

vi.mock('../services/userService.js', () => ({
  getUserService: () => userServiceMock,
}))

vi.mock('../services/walletService.js', () => ({
  getWalletService: () => walletServiceMock,
}))

import userRoutes from './userRoutes.js'

type EnvSnapshot = NodeJS.ProcessEnv

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/users', userRoutes)
  return app
}

let savedEnv: EnvSnapshot

beforeEach(() => {
  savedEnv = { ...process.env }
  process.env.REQUIRE_API_TOKEN = '0'
  delete process.env.API_TOKEN
  delete process.env.ADMIN_API_TOKEN
})

afterEach(() => {
  process.env = savedEnv
  vi.restoreAllMocks()
})

describe('userRoutes', () => {
  it('creates a user and wallet', async () => {
    const res = await request(makeApp()).post('/users').send({
      username: 'alpha-user',
      email: 'alpha@example.com',
      dateOfBirth: '2000-01-01',
      currency: 'USDC',
    })

    expect(res.status).toBe(201)
    expect(res.body.user.id).toBe('user-1')
    expect(res.body.wallet.balanceMinor).toBe('0')
  })

  it('returns a user and bet eligibility', async () => {
    const res = await request(makeApp()).get('/users/user-1')

    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe('alpha-user')
    expect(res.body.betEligibility).toEqual({ allowed: true, reasons: [] })
  })

  it('returns a wallet by user id', async () => {
    const res = await request(makeApp()).get('/users/user-1/wallet')

    expect(res.status).toBe(200)
    expect(res.body.wallet.balanceMinor).toBe('5000')
  })

  it('requires admin token for wallet credits when configured', async () => {
    process.env.ADMIN_API_TOKEN = 'admin-secret'

    const res = await request(makeApp())
      .post('/users/user-1/wallet/credits')
      .send({ amountMinor: '2500' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('credits wallet through admin route', async () => {
    process.env.ADMIN_API_TOKEN = 'admin-secret'

    const res = await request(makeApp())
      .post('/users/user-1/wallet/credits')
      .set('x-api-token', 'admin-secret')
      .send({
        amountMinor: '2500',
        referenceType: 'admin',
        referenceId: 'seed-1',
        metadata: { note: 'seed funds' },
      })

    expect(res.status).toBe(201)
    expect(res.body.wallet.balanceMinor).toBe('7500')
    expect(res.body.ledgerEntry.deltaMinor).toBe('2500')
  })

  it('updates account status', async () => {
    process.env.ADMIN_API_TOKEN = 'admin-secret'

    const res = await request(makeApp())
      .patch('/users/user-1/status')
      .set('x-api-token', 'admin-secret')
      .send({ accountStatus: 'restricted' })

    expect(res.status).toBe(200)
    expect(res.body.user.accountStatus).toBe('restricted')
  })
})

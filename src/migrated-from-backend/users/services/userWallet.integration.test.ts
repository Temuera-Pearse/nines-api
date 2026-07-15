import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { initPool, closePool, getPool } from '../db/pool.js'
import { DefaultUserService } from './userService.js'
import { DefaultWalletService } from './walletService.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const describeIfDatabase = testDatabaseUrl ? describe : describe.skip

describeIfDatabase('user and wallet integration', () => {
  const userService = new DefaultUserService()
  const walletService = new DefaultWalletService()

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    initPool()
    const pool = getPool()
    const raceMigration = readFileSync(
      resolve('db/migrations/001_alpha_race_metadata.sql'),
      'utf8',
    )
    const userMigration = readFileSync(
      resolve('db/migrations/002_alpha_users_wallets.sql'),
      'utf8',
    )
    await pool.query(raceMigration)
    await pool.query(userMigration)
  })

  beforeEach(async () => {
    const pool = getPool()
    await pool.query(
      'truncate table wallet_ledger_entries restart identity cascade',
    )
    await pool.query('truncate table wallets cascade')
    await pool.query('truncate table users cascade')
  })

  afterAll(async () => {
    await closePool()
  })

  it('creates a user, creates a wallet, credits balance, and exposes eligibility', async () => {
    const created = await userService.createUser({
      username: 'alpha-integration',
      email: 'alpha-integration@example.com',
      dateOfBirth: '2000-02-01',
      currency: 'USDC',
    })

    expect(created.user.accountStatus).toBe('active')
    expect(created.user.ageVerificationStatus).toBe('self_attested')
    expect(created.wallet.balanceMinor).toBe(0n)

    const credited = await walletService.creditWallet({
      userId: created.user.id,
      amountMinor: 2500n,
      currency: 'USDC',
      entryType: 'admin_credit',
      referenceType: 'admin',
      referenceId: 'seed-1',
      metadata: { source: 'integration-test' },
    })

    expect(credited.wallet.balanceMinor).toBe(2500n)
    expect(credited.ledgerEntry.balanceAfterMinor).toBe(2500n)

    const eligibility = await userService.getBetEligibility(created.user.id)
    expect(eligibility).toEqual({ allowed: true, reasons: [] })
  })

  it('marks underage users as restricted and ineligible', async () => {
    const created = await userService.createUser({
      username: 'underage-user',
      dateOfBirth: '2012-01-01',
      currency: 'USDC',
    })

    expect(created.user.accountStatus).toBe('restricted')
    expect(created.user.ageVerificationStatus).toBe('underage')

    const eligibility = await userService.getBetEligibility(created.user.id)
    expect(eligibility.allowed).toBe(false)
    expect(eligibility.reasons).toContain('account_status:restricted')
    expect(eligibility.reasons).toContain('under_minimum_age')
    expect(eligibility.reasons).toContain('age_verification_status:underage')
  })
})

import { randomUUID } from 'crypto'
import { getPool } from '../db/pool.js'
import { getUserRepository } from '../db/userRepository.js'
import { getWalletRepository } from '../db/walletRepository.js'
import { normalizeFinancialCurrency } from '../financial/legacyAlphaFinancialAuthority.js'
import { deriveInitialAgeVerificationStatus } from '../user/ageGate.js'
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../user/errors.js'
import { getBetEligibility } from '../user/eligibility.js'
import type {
  BetEligibilityResult,
  CreateUserInput,
  UpdateAgeVerificationStatusInput,
  UpdateUserAccountStatusInput,
  UserRecord,
  WalletRecord,
} from '../user/types.js'

export interface UserService {
  createUser(
    input: CreateUserInput,
  ): Promise<{ user: UserRecord; wallet: WalletRecord }>
  getUserById(userId: string): Promise<UserRecord>
  updateAccountStatus(input: UpdateUserAccountStatusInput): Promise<UserRecord>
  updateAgeVerificationStatus(
    input: UpdateAgeVerificationStatusInput,
  ): Promise<UserRecord>
  getBetEligibility(userId: string): Promise<BetEligibilityResult>
}

function normalizeUsername(username: string): string {
  return username.trim()
}

function normalizeEmail(email?: string | null): string | null {
  const normalized = email?.trim().toLowerCase() ?? null
  return normalized ? normalized : null
}

function normalizeCurrency(currency?: string): string {
  return normalizeFinancialCurrency(currency)
}

function validateDateOfBirth(dateOfBirth: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    throw new ValidationError('dateOfBirth must be YYYY-MM-DD')
  }
}

export class DefaultUserService implements UserService {
  private userRepository = getUserRepository()
  private walletRepository = getWalletRepository()

  async createUser(
    input: CreateUserInput,
  ): Promise<{ user: UserRecord; wallet: WalletRecord }> {
    const username = normalizeUsername(input.username)
    const email = normalizeEmail(input.email)
    const currency = normalizeCurrency(input.currency)

    if (username.length < 3) {
      throw new ValidationError('username must be at least 3 characters')
    }

    validateDateOfBirth(input.dateOfBirth)

    if (await this.userRepository.findUserByUsername(username)) {
      throw new ConflictError('username already exists')
    }

    if (email && (await this.userRepository.findUserByEmail(email))) {
      throw new ConflictError('email already exists')
    }

    const ageVerificationStatus = deriveInitialAgeVerificationStatus(
      input.dateOfBirth,
    )
    const accountStatus =
      ageVerificationStatus === 'underage' ? 'restricted' : 'active'

    const pool = getPool()
    const client = await pool.connect()
    try {
      await client.query('begin')
      const user = await this.userRepository.createUser(
        {
          id: randomUUID(),
          username,
          email,
          dateOfBirth: input.dateOfBirth,
          accountStatus,
          ageVerificationStatus,
          currency,
        },
        client,
      )
      const wallet = await this.walletRepository.createWallet(
        {
          id: randomUUID(),
          userId: user.id,
          currency,
          balanceMinor: 0n,
        },
        client,
      )
      await client.query('commit')
      return { user, wallet }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async getUserById(userId: string): Promise<UserRecord> {
    const user = await this.userRepository.findUserById(userId)
    if (!user) {
      throw new NotFoundError('user not found')
    }
    return user
  }

  async updateAccountStatus(
    input: UpdateUserAccountStatusInput,
  ): Promise<UserRecord> {
    const user = await this.userRepository.updateAccountStatus(input)
    if (!user) {
      throw new NotFoundError('user not found')
    }
    return user
  }

  async updateAgeVerificationStatus(
    input: UpdateAgeVerificationStatusInput,
  ): Promise<UserRecord> {
    const user = await this.userRepository.updateAgeVerificationStatus(input)
    if (!user) {
      throw new NotFoundError('user not found')
    }
    return user
  }

  async getBetEligibility(userId: string): Promise<BetEligibilityResult> {
    const user = await this.getUserById(userId)
    return getBetEligibility(user)
  }
}

let sharedUserService: UserService | null = null

export function getUserService(): UserService {
  if (!sharedUserService) {
    sharedUserService = new DefaultUserService()
  }
  return sharedUserService
}

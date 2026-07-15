import type { PoolClient } from 'pg'
import { getPool } from '../db/pool.js'
import { getWalletLedgerRepository } from '../db/walletLedgerRepository.js'
import { getWalletRepository } from '../db/walletRepository.js'
import { NotFoundError, ValidationError } from '../user/errors.js'
import {
  assertLegacyAlphaFinancialMutationPath,
  LEGACY_ALPHA_FINANCIAL_AUTHORITY_WARNING,
  normalizeFinancialCurrency,
} from '../financial/legacyAlphaFinancialAuthority.js'
import type {
  WalletAdjustmentInput,
  WalletLedgerEntryRecord,
  WalletRecord,
} from '../user/types.js'

export interface WalletService {
  getWalletByUserId(userId: string, currency?: string): Promise<WalletRecord>
  creditWallet(input: WalletAdjustmentInput): Promise<{
    wallet: WalletRecord
    ledgerEntry: WalletLedgerEntryRecord
  }>
  debitWallet(input: WalletAdjustmentInput): Promise<{
    wallet: WalletRecord
    ledgerEntry: WalletLedgerEntryRecord
  }>
}

function normalizeCurrency(currency?: string): string {
  return normalizeFinancialCurrency(currency)
}

function ensurePositiveAmount(amountMinor: bigint): void {
  if (amountMinor <= 0n) {
    throw new ValidationError('amountMinor must be greater than zero')
  }
}

export async function applyWalletDeltaInTransaction(
  input: WalletAdjustmentInput,
  client: PoolClient,
): Promise<{
  wallet: WalletRecord
  ledgerEntry: WalletLedgerEntryRecord
}> {
  assertLegacyAlphaFinancialMutationPath('applyWalletDeltaInTransaction')
  // TODO(phase-2.5): Replace this alpha wallet mutation with a nines-financial
  // command client. This path is not financial truth.
  void LEGACY_ALPHA_FINANCIAL_AUTHORITY_WARNING

  const walletRepository = getWalletRepository()
  const walletLedgerRepository = getWalletLedgerRepository()
  const currency = normalizeCurrency(input.currency)

  const wallet = await walletRepository.findWalletByUserIdForUpdate(
    input.userId,
    currency,
    client,
  )
  if (!wallet) {
    throw new NotFoundError('wallet not found')
  }

  const nextBalance = wallet.balanceMinor + input.amountMinor
  if (nextBalance < 0n) {
    throw new ValidationError('insufficient balance')
  }

  const updatedWallet = await walletRepository.updateBalanceMinor(
    wallet.id,
    nextBalance,
    client,
  )

  const ledgerEntry = await walletLedgerRepository.createEntry(
    {
      walletId: wallet.id,
      entryType: input.entryType,
      deltaMinor: input.amountMinor,
      balanceAfterMinor: nextBalance,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      metadata: input.metadata ?? {},
    },
    client,
  )

  return { wallet: updatedWallet, ledgerEntry }
}

export class DefaultWalletService implements WalletService {
  private walletRepository = getWalletRepository()
  private walletLedgerRepository = getWalletLedgerRepository()

  async getWalletByUserId(
    userId: string,
    currency?: string,
  ): Promise<WalletRecord> {
    const wallet = await this.walletRepository.findWalletByUserId(
      userId,
      normalizeCurrency(currency),
    )
    if (!wallet) {
      throw new NotFoundError('wallet not found')
    }
    return wallet
  }

  async creditWallet(input: WalletAdjustmentInput): Promise<{
    wallet: WalletRecord
    ledgerEntry: WalletLedgerEntryRecord
  }> {
    ensurePositiveAmount(input.amountMinor)
    return this.applyDelta({ ...input, amountMinor: input.amountMinor })
  }

  async debitWallet(input: WalletAdjustmentInput): Promise<{
    wallet: WalletRecord
    ledgerEntry: WalletLedgerEntryRecord
  }> {
    ensurePositiveAmount(input.amountMinor)
    return this.applyDelta({ ...input, amountMinor: -input.amountMinor })
  }

  private async applyDelta(input: WalletAdjustmentInput): Promise<{
    wallet: WalletRecord
    ledgerEntry: WalletLedgerEntryRecord
  }> {
    assertLegacyAlphaFinancialMutationPath('DefaultWalletService.applyDelta')
    // TODO(phase-2.5): Keep only for alpha demos until nines-back-end calls
    // nines-financial for funding, debits, reservations, and balances.
    const pool = getPool()
    const client = await pool.connect()

    try {
      await client.query('begin')
      const adjusted = await applyWalletDeltaInTransaction(input, client)

      await client.query('commit')
      return adjusted
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}

let sharedWalletService: WalletService | null = null

export function getWalletService(): WalletService {
  if (!sharedWalletService) {
    sharedWalletService = new DefaultWalletService()
  }
  return sharedWalletService
}

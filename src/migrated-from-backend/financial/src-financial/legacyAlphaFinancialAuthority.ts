export const LEGACY_ALPHA_FINANCIAL_AUTHORITY_WARNING =
  'ALPHA_ONLY: nines-back-end wallet, bet, and settlement money mutations are deprecated. nines-financial is the sole financial authority for real balances, reservations, funding, withdrawals, and settlement.'

export const CANONICAL_FRONT_OF_HOUSE_CURRENCY = 'USDC'

export function normalizeFinancialCurrency(currency?: string): string {
  return (currency || CANONICAL_FRONT_OF_HOUSE_CURRENCY).trim().toUpperCase()
}

export function assertLegacyAlphaFinancialMutationPath(pathName: string): void {
  if (process.env.NINES_DISABLE_LEGACY_ALPHA_FINANCIAL_MUTATIONS === 'true') {
    throw new Error(
      `${pathName} is a deprecated alpha-only financial mutation path. Route this command through nines-financial.`,
    )
  }
}

export function isLegacyAlphaFinancialFallbackEnabled(): boolean {
  return process.env.NINES_ENABLE_LEGACY_ALPHA_FINANCIAL_FALLBACK === 'true'
}

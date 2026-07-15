import { afterEach, describe, expect, it } from 'vitest'

import {
  assertLegacyAlphaFinancialMutationPath,
  normalizeFinancialCurrency,
} from './legacyAlphaFinancialAuthority.js'

describe('legacy alpha financial authority guard', () => {
  const originalSetting = process.env.NINES_DISABLE_LEGACY_ALPHA_FINANCIAL_MUTATIONS

  afterEach(() => {
    if (originalSetting === undefined) {
      delete process.env.NINES_DISABLE_LEGACY_ALPHA_FINANCIAL_MUTATIONS
    } else {
      process.env.NINES_DISABLE_LEGACY_ALPHA_FINANCIAL_MUTATIONS = originalSetting
    }
  })

  it('defaults financial currency to USDC', () => {
    expect(normalizeFinancialCurrency()).toBe('USDC')
    expect(normalizeFinancialCurrency('usd')).toBe('USD')
  })

  it('can quarantine deprecated backend money mutation paths', () => {
    process.env.NINES_DISABLE_LEGACY_ALPHA_FINANCIAL_MUTATIONS = 'true'

    expect(() =>
      assertLegacyAlphaFinancialMutationPath('DefaultBetService.placeBet'),
    ).toThrow(/deprecated alpha-only financial mutation path/)
  })
})

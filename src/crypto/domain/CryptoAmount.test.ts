import { describe, expect, it } from 'vitest'
import { compareCryptoAmounts, normalizeCryptoAsset, parseCryptoAmount } from './CryptoAmount.js'

describe('crypto amount validation', () => {
  it('canonicalizes exact decimal strings without floating point', () => {
    expect(parseCryptoAmount('100.00', 6)).toEqual({ canonical: '100', units: 100000000n, scale: 6 })
    expect(compareCryptoAmounts(parseCryptoAmount('0.100001', 6), parseCryptoAmount('0.1', 6))).toBe(1)
  })
  it.each(['0', '-1', '1e3', '.5', '1.0000001'])('rejects unsafe amount %s', (amount) => {
    expect(() => parseCryptoAmount(amount, 6)).toThrow()
  })
  it('normalizes bounded asset symbols', () => {
    expect(normalizeCryptoAsset(' usdc ')).toBe('USDC')
    expect(() => normalizeCryptoAsset('not/an/asset')).toThrow()
  })
})

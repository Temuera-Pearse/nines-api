import { describe, expect, it } from 'vitest'
import { canTransitionCryptoFunding } from './CryptoFunding.js'

describe('crypto funding lifecycle', () => {
  it('supports detection before final confirmation', () => {
    expect(canTransitionCryptoFunding('awaiting_payment', 'detected')).toBe(true)
    expect(canTransitionCryptoFunding('detected', 'confirming')).toBe(true)
    expect(canTransitionCryptoFunding('confirming', 'confirmed')).toBe(true)
  })
  it('never permits a confirmed intent to move backwards', () => {
    expect(canTransitionCryptoFunding('confirmed', 'confirming')).toBe(false)
    expect(canTransitionCryptoFunding('confirmed', 'failed')).toBe(false)
    expect(canTransitionCryptoFunding('confirmed', 'expired')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { isKycStatus, KYC_STATUSES } from './KycStatus.js'

describe('KYC status model', () => {
  it('contains only the required explicit states', () => {
    expect(KYC_STATUSES).toEqual([
      'not_started',
      'pending',
      'verified',
      'failed',
      'manual_review',
      'expired',
    ])
  })

  it('rejects unknown and legacy placeholder states', () => {
    expect(isKycStatus('verified')).toBe(true)
    expect(isKycStatus('rejected')).toBe(false)
    expect(isKycStatus('unknown')).toBe(false)
    expect(isKycStatus(null)).toBe(false)
  })
})

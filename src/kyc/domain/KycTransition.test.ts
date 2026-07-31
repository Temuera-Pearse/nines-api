import { describe, expect, it } from 'vitest'
import { canTransitionKycStatus } from './KycTransition.js'

describe('KYC transition matrix', () => {
  it('permits required forward and retry transitions', () => {
    expect(canTransitionKycStatus('not_started', 'pending')).toBe(true)
    expect(canTransitionKycStatus('pending', 'verified')).toBe(true)
    expect(canTransitionKycStatus('pending', 'failed')).toBe(true)
    expect(canTransitionKycStatus('pending', 'manual_review')).toBe(true)
    expect(canTransitionKycStatus('manual_review', 'verified')).toBe(true)
    expect(canTransitionKycStatus('verified', 'expired')).toBe(true)
    expect(canTransitionKycStatus('failed', 'pending')).toBe(true)
    expect(canTransitionKycStatus('expired', 'pending')).toBe(true)
  })

  it('rejects backwards, direct, and no-op transitions', () => {
    expect(canTransitionKycStatus('not_started', 'verified')).toBe(false)
    expect(canTransitionKycStatus('verified', 'pending')).toBe(false)
    expect(canTransitionKycStatus('failed', 'verified')).toBe(false)
    expect(canTransitionKycStatus('expired', 'verified')).toBe(false)
    expect(canTransitionKycStatus('pending', 'pending')).toBe(false)
  })
})

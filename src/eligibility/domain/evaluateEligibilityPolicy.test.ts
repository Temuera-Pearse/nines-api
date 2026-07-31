import { describe, expect, it } from 'vitest'
import { ELIGIBILITY_POLICY_VERSION } from './EligibilityDecision.js'
import { evaluateEligibilityPolicy } from './evaluateEligibilityPolicy.js'

function evaluate(
  operation: string,
  overrides: Partial<{
    accountStatus: string
    kycStatus: string
    activeRestrictionTypes: string[]
  }> = {},
) {
  return evaluateEligibilityPolicy({
    operation,
    accountStatus: overrides.accountStatus ?? 'active',
    kycStatus: overrides.kycStatus ?? 'verified',
    activeRestrictionTypes: overrides.activeRestrictionTypes ?? [],
  })
}

describe('eligibility policy v1', () => {
  it('has the stable Phase 2 policy version', () => {
    expect(ELIGIBILITY_POLICY_VERSION).toBe('eligibility-policy-v1')
  })

  it('allows race viewing unless the account is closed', () => {
    expect(evaluate('view_races', { accountStatus: 'restricted' })).toEqual({
      allowed: true,
      reasonCodes: [],
    })
    expect(evaluate('view_races', { accountStatus: 'closed' })).toEqual({
      allowed: false,
      reasonCodes: ['ACCOUNT_CLOSED'],
    })
  })

  it('requires an active account and verified KYC for regulated operations', () => {
    expect(
      evaluate('deposit', { accountStatus: 'restricted', kycStatus: 'not_started' }),
    ).toEqual({
      allowed: false,
      reasonCodes: ['ACCOUNT_RESTRICTED', 'KYC_NOT_VERIFIED'],
    })
    expect(evaluate('withdraw', { accountStatus: 'suspended', kycStatus: 'pending' })).toEqual({
      allowed: false,
      reasonCodes: ['ACCOUNT_SUSPENDED', 'KYC_PENDING'],
    })
    for (const kycStatus of ['failed', 'manual_review', 'expired']) {
      expect(evaluate('place_wager', { kycStatus })).toEqual({
        allowed: false,
        reasonCodes: ['KYC_NOT_VERIFIED'],
      })
    }
  })

  it('applies operation-specific restrictions with stable reason codes', () => {
    expect(evaluate('deposit', { activeRestrictionTypes: ['deposits_blocked'] })).toEqual({
      allowed: false,
      reasonCodes: ['DEPOSITS_BLOCKED'],
    })
    expect(evaluate('withdraw', { activeRestrictionTypes: ['withdrawals_blocked'] })).toEqual({
      allowed: false,
      reasonCodes: ['WITHDRAWALS_BLOCKED'],
    })
    expect(evaluate('deposit', { activeRestrictionTypes: ['kyc_required'] })).toEqual({
      allowed: false,
      reasonCodes: ['KYC_NOT_VERIFIED'],
    })
    expect(
      evaluate('place_wager', {
        activeRestrictionTypes: [
          'wagering_blocked',
          'self_exclusion',
          'jurisdiction_blocked',
          'security_review',
        ],
      }),
    ).toEqual({
      allowed: false,
      reasonCodes: [
        'WAGERING_BLOCKED',
        'SELF_EXCLUDED',
        'JURISDICTION_BLOCKED',
        'SECURITY_REVIEW',
      ],
    })
  })

  it('allows profile management for every authenticated account state', () => {
    expect(evaluate('manage_profile', { accountStatus: 'closed' })).toEqual({
      allowed: true,
      reasonCodes: [],
    })
  })

  it('denies unknown or incomplete policy data', () => {
    expect(evaluate('unknown')).toEqual({
      allowed: false,
      reasonCodes: ['POLICY_DATA_INCOMPLETE'],
    })
    expect(evaluate('deposit', { kycStatus: 'unknown' })).toEqual({
      allowed: false,
      reasonCodes: ['POLICY_DATA_INCOMPLETE'],
    })
    expect(evaluate('deposit', { activeRestrictionTypes: ['unknown'] })).toEqual({
      allowed: false,
      reasonCodes: ['POLICY_DATA_INCOMPLETE'],
    })
  })
})

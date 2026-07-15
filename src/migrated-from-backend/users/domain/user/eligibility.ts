import { isOfBettingAge } from './ageGate.js'
import type { BetEligibilityResult, UserRecord } from './types.js'

export function getBetEligibility(user: UserRecord): BetEligibilityResult {
  const reasons: string[] = []

  if (user.accountStatus !== 'active') {
    reasons.push(`account_status:${user.accountStatus}`)
  }

  if (!isOfBettingAge(user.dateOfBirth)) {
    reasons.push('under_minimum_age')
  }

  if (
    user.ageVerificationStatus === 'underage' ||
    user.ageVerificationStatus === 'rejected' ||
    user.ageVerificationStatus === 'unverified'
  ) {
    reasons.push(`age_verification_status:${user.ageVerificationStatus}`)
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  }
}

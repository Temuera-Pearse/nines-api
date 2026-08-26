import { ACCOUNT_STATUSES, type AccountStatus } from '../../players/domain/AccountStatus.js'
import type {
  EligibilityPolicyInput,
  EligibilityPolicyResult,
} from './EligibilityDecision.js'
import type { EligibilityReasonCode } from './EligibilityReasonCode.js'
import { isKycStatus, type KycStatus } from '../../kyc/domain/KycStatus.js'
import { isPlayerOperation, type PlayerOperation } from './PlayerOperation.js'
import { RESTRICTION_TYPES, type RestrictionType } from './Restriction.js'

const ACCOUNT_REASON: Partial<Record<AccountStatus, EligibilityReasonCode>> = {
  restricted: 'ACCOUNT_RESTRICTED',
  suspended: 'ACCOUNT_SUSPENDED',
  closed: 'ACCOUNT_CLOSED',
}

const RESTRICTION_REASON: Partial<Record<RestrictionType, EligibilityReasonCode>> = {
  security_review: 'SECURITY_REVIEW',
  self_exclusion: 'SELF_EXCLUDED',
  jurisdiction_blocked: 'JURISDICTION_BLOCKED',
  wagering_blocked: 'WAGERING_BLOCKED',
  deposits_blocked: 'DEPOSITS_BLOCKED',
  withdrawals_blocked: 'WITHDRAWALS_BLOCKED',
  kyc_required: 'KYC_NOT_VERIFIED',
}

const OPERATION_RESTRICTIONS: Record<PlayerOperation, readonly RestrictionType[]> = {
  view_races: [],
  deposit: ['deposits_blocked', 'jurisdiction_blocked', 'kyc_required'],
  withdraw: ['withdrawals_blocked', 'kyc_required'],
  place_wager: [
    'wagering_blocked',
    'self_exclusion',
    'jurisdiction_blocked',
    'security_review',
    'kyc_required',
  ],
  start_kyc: [],
  manage_profile: [],
}

function requiresActiveAccount(operation: PlayerOperation): boolean {
  return operation === 'deposit' || operation === 'withdraw' || operation === 'place_wager'
}

function requiresVerifiedKyc(operation: PlayerOperation): boolean {
  return operation === 'deposit' || operation === 'withdraw' || operation === 'place_wager'
}

function uniqueReasons(reasons: EligibilityReasonCode[]): EligibilityReasonCode[] {
  return [...new Set(reasons)]
}

export function evaluateEligibilityPolicy(input: EligibilityPolicyInput): EligibilityPolicyResult {
  if (
    !isPlayerOperation(input.operation) ||
    typeof input.accountStatus !== 'string' ||
    !ACCOUNT_STATUSES.includes(input.accountStatus as AccountStatus) ||
    !isKycStatus(input.kycStatus) ||
    !Array.isArray(input.activeRestrictionTypes) ||
    input.activeRestrictionTypes.some(
      (value) =>
        typeof value !== 'string' ||
        !RESTRICTION_TYPES.includes(value as RestrictionType),
    )
  ) {
    return { allowed: false, reasonCodes: ['POLICY_DATA_INCOMPLETE'] }
  }

  const operation = input.operation
  const accountStatus = input.accountStatus as AccountStatus
  const kycStatus = input.kycStatus as KycStatus
  const restrictionTypes = new Set(input.activeRestrictionTypes as RestrictionType[])
  const reasons: EligibilityReasonCode[] = []

  if (operation === 'manage_profile') return { allowed: true, reasonCodes: [] }

  if (accountStatus === 'closed') reasons.push('ACCOUNT_CLOSED')

  if (operation === 'view_races' || operation === 'start_kyc') {
    return { allowed: reasons.length === 0, reasonCodes: uniqueReasons(reasons) }
  }

  if (requiresActiveAccount(operation) && accountStatus !== 'active') {
    reasons.push(ACCOUNT_REASON[accountStatus] ?? 'POLICY_DATA_INCOMPLETE')
  }

  if (requiresVerifiedKyc(operation) && kycStatus !== 'verified') {
    reasons.push(kycStatus === 'pending' ? 'KYC_PENDING' : 'KYC_NOT_VERIFIED')
  }

  for (const restrictionType of OPERATION_RESTRICTIONS[operation]) {
    if (restrictionTypes.has(restrictionType)) {
      reasons.push(RESTRICTION_REASON[restrictionType]!)
    }
  }

  return { allowed: reasons.length === 0, reasonCodes: uniqueReasons(reasons) }
}

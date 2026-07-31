import type { EligibilityReasonCode } from './EligibilityReasonCode.js'
import type { KycStatus } from '../../kyc/domain/KycStatus.js'
import type { PlayerOperation } from './PlayerOperation.js'
import type { RestrictionType } from './Restriction.js'

export const ELIGIBILITY_POLICY_VERSION = 'eligibility-policy-v1' as const

export interface EligibilityInputSnapshot {
  accountStatus: string
  kycStatus: string
  activeRestrictionTypes: RestrictionType[]
}

export interface EligibilityDecision {
  decisionId: string
  playerId: string
  operation: PlayerOperation
  allowed: boolean
  reasonCodes: EligibilityReasonCode[]
  policyVersion: typeof ELIGIBILITY_POLICY_VERSION
  evaluatedAt: Date
  inputSnapshot: EligibilityInputSnapshot
}

export interface EligibilityPolicyInput {
  operation: unknown
  accountStatus: unknown
  kycStatus: unknown
  activeRestrictionTypes: readonly unknown[]
}

export interface EligibilityPolicyResult {
  allowed: boolean
  reasonCodes: EligibilityReasonCode[]
}

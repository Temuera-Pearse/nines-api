export const RESTRICTION_TYPES = [
  'wagering_blocked',
  'deposits_blocked',
  'withdrawals_blocked',
  'security_review',
  'manual_review',
  'self_exclusion',
  'jurisdiction_blocked',
  'kyc_required',
] as const

export type RestrictionType = (typeof RESTRICTION_TYPES)[number]

export const RESTRICTION_STATUSES = ['active', 'removed', 'expired'] as const
export type RestrictionStatus = (typeof RESTRICTION_STATUSES)[number]

export interface PlayerRestriction {
  id: string
  playerId: string
  type: RestrictionType
  status: RestrictionStatus
  reasonCode: string
  source: string
  startsAt: Date
  endsAt: Date | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export function isRestrictionActive(restriction: PlayerRestriction, at: Date): boolean {
  return (
    restriction.status === 'active' &&
    restriction.startsAt.getTime() <= at.getTime() &&
    (restriction.endsAt === null || restriction.endsAt.getTime() > at.getTime())
  )
}

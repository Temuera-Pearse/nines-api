import type { AccountStatus } from './AccountStatus.js'

export interface AccountStatusTransition {
  id: string
  playerId: string
  fromStatus: AccountStatus
  toStatus: AccountStatus
  reasonCode: string
  actorType: string
  actorId: string | null
  correlationId: string
  createdAt: Date
}

const ALLOWED_TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  restricted: ['active', 'suspended', 'closed'],
  active: ['restricted', 'suspended', 'closed'],
  suspended: ['restricted', 'active', 'closed'],
  closed: [],
}

export function canChangeAccountStatus(from: AccountStatus, to: AccountStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export const ACCOUNT_STATUSES = ['restricted', 'active', 'suspended', 'closed'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

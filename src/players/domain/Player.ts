import type { AccountStatus } from './AccountStatus.js'

export interface Player {
  id: string
  email: string | null
  displayName: string | null
  accountStatus: AccountStatus
  createdAt: Date
  updatedAt: Date
  version: number
}

import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycProfile } from '../domain/KycProfile.js'
import type { KycStatus } from '../domain/KycStatus.js'

export interface GetOrCreateKycProfileResult {
  profile: KycProfile
  created: boolean
}

export interface UpdateKycProfileStatusInput {
  profileId: string
  expectedVersion: number
  status: KycStatus
  provider: string | null
  currentSessionId: string | null
  verifiedAt: Date | null
  expiresAt: Date | null
  failureReasonCode: string | null
}

export interface KycProfileRepository {
  findForPlayer(
    playerId: string,
    executor: QueryExecutor,
  ): Promise<KycProfile | null>
  getOrCreateForPlayer(
    profileId: string,
    playerId: string,
    executor: QueryExecutor,
  ): Promise<GetOrCreateKycProfileResult>
  getForUpdate(playerId: string, executor: QueryExecutor): Promise<KycProfile | null>
  updateStatus(
    input: UpdateKycProfileStatusInput,
    executor: QueryExecutor,
  ): Promise<KycProfile | null>
  findExpiredVerified(
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycProfile[]>
}

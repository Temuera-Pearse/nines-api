import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycActorContext } from '../application/KycContext.js'
import type { KycManualReview } from '../domain/KycManualReview.js'
import type { KycStatus } from '../domain/KycStatus.js'

export interface CreateKycManualReviewInput {
  id: string
  actionId: string
  playerId: string
  kycProfileId: string
  sessionId: string | null
  previousStatus: KycStatus
  actor: KycActorContext
  reasonCodes: string[]
  notes: string | null
  at: Date
}

export interface CompleteKycManualReviewInput {
  reviewId: string | null
  actionId: string
  kycProfileId: string
  previousStatus: KycStatus
  newStatus: KycStatus
  action: string
  actor: KycActorContext
  reasonCodes: string[]
  notes: string | null
  at: Date
}

export interface KycManualReviewRepository {
  findById(reviewId: string, executor: QueryExecutor): Promise<KycManualReview | null>
  findByIdForUpdate(reviewId: string, executor: QueryExecutor): Promise<KycManualReview | null>
  findActiveForProfileForUpdate(
    kycProfileId: string,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null>
  createRequested(
    input: CreateKycManualReviewInput,
    executor: QueryExecutor,
  ): Promise<KycManualReview>
  open(
    reviewId: string,
    actionId: string,
    actor: KycActorContext,
    reasonCodes: string[],
    notes: string | null,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null>
  assign(
    reviewId: string,
    actionId: string,
    assigneeActorId: string,
    actor: KycActorContext,
    reasonCodes: string[],
    notes: string | null,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null>
  complete(
    input: CompleteKycManualReviewInput,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null>
}

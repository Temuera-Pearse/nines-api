import type { QueryResultRow } from 'pg'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycActorContext } from '../application/KycContext.js'
import type { KycManualReview, KycManualReviewStatus } from '../domain/KycManualReview.js'
import type {
  CompleteKycManualReviewInput,
  CreateKycManualReviewInput,
  KycManualReviewRepository,
} from './KycManualReviewRepository.js'

interface ReviewRow extends QueryResultRow {
  id: string
  player_id: string
  kyc_profile_id: string
  session_id: string | null
  status: KycManualReviewStatus
  assigned_actor_id: string | null
  requested_at: Date
  opened_at: Date | null
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

const REVIEW_COLUMNS = `
  id, player_id, kyc_profile_id, session_id, status, assigned_actor_id,
  requested_at, opened_at, completed_at, created_at, updated_at
`

function mapReview(row: ReviewRow): KycManualReview {
  return {
    id: row.id,
    playerId: row.player_id,
    kycProfileId: row.kyc_profile_id,
    sessionId: row.session_id,
    status: row.status,
    assignedActorId: row.assigned_actor_id,
    requestedAt: row.requested_at,
    openedAt: row.opened_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function appendAction(
  input: {
    id: string
    review: KycManualReview
    previousStatus: string
    newStatus: string
    action: string
    actor: KycActorContext
    reasonCodes: string[]
    notes: string | null
    at: Date
  },
  executor: QueryExecutor,
): Promise<void> {
  await executor.query(
    `INSERT INTO kyc_manual_review_actions
      (id, review_id, player_id, kyc_profile_id, previous_status, new_status,
       action, actor_type, actor_id, reason_codes, notes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.id,
      input.review.id,
      input.review.playerId,
      input.review.kycProfileId,
      input.previousStatus,
      input.newStatus,
      input.action,
      input.actor.actorType,
      input.actor.actorId,
      input.reasonCodes,
      input.notes,
      input.at,
    ],
  )
}

export class PostgresKycManualReviewRepository implements KycManualReviewRepository {
  async findById(
    reviewId: string,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null> {
    const result = await executor.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM kyc_manual_reviews WHERE id = $1`,
      [reviewId],
    )
    return result.rows[0] ? mapReview(result.rows[0]) : null
  }

  async findByIdForUpdate(
    reviewId: string,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null> {
    const result = await executor.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM kyc_manual_reviews WHERE id = $1 FOR UPDATE`,
      [reviewId],
    )
    return result.rows[0] ? mapReview(result.rows[0]) : null
  }

  async findActiveForProfileForUpdate(
    kycProfileId: string,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null> {
    const result = await executor.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS}
       FROM kyc_manual_reviews
       WHERE kyc_profile_id = $1 AND status <> 'completed'
       FOR UPDATE`,
      [kycProfileId],
    )
    return result.rows[0] ? mapReview(result.rows[0]) : null
  }

  async createRequested(
    input: CreateKycManualReviewInput,
    executor: QueryExecutor,
  ): Promise<KycManualReview> {
    const result = await executor.query<ReviewRow>(
      `INSERT INTO kyc_manual_reviews
        (id, player_id, kyc_profile_id, session_id, status, requested_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'requested', $5, $5, $5)
       RETURNING ${REVIEW_COLUMNS}`,
      [input.id, input.playerId, input.kycProfileId, input.sessionId, input.at],
    )
    const review = mapReview(result.rows[0])
    await appendAction(
      {
        id: input.actionId,
        review,
        previousStatus: input.previousStatus,
        newStatus: 'manual_review',
        action: 'review_requested',
        actor: input.actor,
        reasonCodes: input.reasonCodes,
        notes: input.notes,
        at: input.at,
      },
      executor,
    )
    return review
  }

  async open(
    reviewId: string,
    actionId: string,
    actor: KycActorContext,
    reasonCodes: string[],
    notes: string | null,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null> {
    const locked = await this.findByIdForUpdate(reviewId, executor)
    if (!locked || locked.status === 'completed') return null
    const result = await executor.query<ReviewRow>(
      `UPDATE kyc_manual_reviews
       SET status = CASE WHEN assigned_actor_id IS NULL THEN 'open' ELSE 'assigned' END,
           opened_at = COALESCE(opened_at, $2), updated_at = $2
       WHERE id = $1
       RETURNING ${REVIEW_COLUMNS}`,
      [reviewId, at],
    )
    const review = mapReview(result.rows[0])
    await appendAction(
      {
        id: actionId,
        review,
        previousStatus: 'manual_review',
        newStatus: 'manual_review',
        action: 'review_opened',
        actor,
        reasonCodes,
        notes,
        at,
      },
      executor,
    )
    return review
  }

  async assign(
    reviewId: string,
    actionId: string,
    assigneeActorId: string,
    actor: KycActorContext,
    reasonCodes: string[],
    notes: string | null,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null> {
    const locked = await this.findByIdForUpdate(reviewId, executor)
    if (!locked || locked.status === 'completed') return null
    const result = await executor.query<ReviewRow>(
      `UPDATE kyc_manual_reviews
       SET status = 'assigned', assigned_actor_id = $2,
           opened_at = COALESCE(opened_at, $3), updated_at = $3
       WHERE id = $1
       RETURNING ${REVIEW_COLUMNS}`,
      [reviewId, assigneeActorId, at],
    )
    const review = mapReview(result.rows[0])
    await appendAction(
      {
        id: actionId,
        review,
        previousStatus: 'manual_review',
        newStatus: 'manual_review',
        action: 'review_assigned',
        actor,
        reasonCodes,
        notes,
        at,
      },
      executor,
    )
    return review
  }

  async complete(
    input: CompleteKycManualReviewInput,
    executor: QueryExecutor,
  ): Promise<KycManualReview | null> {
    const active = await this.findActiveForProfileForUpdate(input.kycProfileId, executor)
    if (!active || (input.reviewId && active.id !== input.reviewId)) return null
    const result = await executor.query<ReviewRow>(
      `UPDATE kyc_manual_reviews
       SET status = 'completed', completed_at = $2, updated_at = $2
       WHERE id = $1 AND status <> 'completed'
       RETURNING ${REVIEW_COLUMNS}`,
      [active.id, input.at],
    )
    if (!result.rows[0]) return null
    const review = mapReview(result.rows[0])
    await appendAction(
      {
        id: input.actionId,
        review,
        previousStatus: input.previousStatus,
        newStatus: input.newStatus,
        action: input.action,
        actor: input.actor,
        reasonCodes: input.reasonCodes,
        notes: input.notes,
        at: input.at,
      },
      executor,
    )
    return review
  }
}

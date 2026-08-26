import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import { withTransaction } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import type { KycManualReview } from '../domain/KycManualReview.js'
import type { KycManualReviewRepository } from '../infrastructure/KycManualReviewRepository.js'
import type { KycSessionRepository } from '../infrastructure/KycSessionRepository.js'
import type { KycActorContext } from './KycContext.js'
import type { TransitionKycStatusService } from './TransitionKycStatusService.js'

export interface KycManualReviewActionInput {
  reviewId: string
  reasonCodes: string[]
  notes?: string | null
}

function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes === undefined || notes === null) return null
  const normalized = notes.trim()
  if (!normalized) return null
  if (normalized.length > 2000) {
    throw new AppError({
      status: 400,
      code: 'KYC_REVIEW_NOTES_INVALID',
      message: 'KYC review notes exceed the maximum length',
    })
  }
  return normalized
}

function normalizeReasons(reasonCodes: readonly string[], fallback: string): string[] {
  const normalized = [...new Set(reasonCodes.map((code) => code.trim()).filter(Boolean))]
  return normalized.length > 0 ? normalized.slice(0, 20) : [fallback]
}

export class KycManualReviewService {
  constructor(
    private readonly pool: Pool,
    private readonly reviews: KycManualReviewRepository,
    private readonly sessions: KycSessionRepository,
    private readonly transitions: TransitionKycStatusService,
    private readonly audit: AuditRepository,
    private readonly verificationTtlMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async open(
    input: KycManualReviewActionInput,
    actor: KycActorContext,
  ): Promise<KycManualReview> {
    this.assertAdmin(actor)
    return withTransaction(this.pool, async (client) => {
      const reasons = normalizeReasons(input.reasonCodes, 'KYC_MANUAL_REVIEW_OPENED')
      const review = await this.reviews.open(
        input.reviewId,
        randomUUID(),
        actor,
        reasons,
        normalizeNotes(input.notes),
        this.clock(),
        client,
      )
      if (!review) throw this.reviewNotFound()
      await this.appendAudit('kyc.manual_review_opened', review, actor, reasons, client)
      return review
    })
  }

  async assign(
    input: KycManualReviewActionInput & { assigneeActorId: string },
    actor: KycActorContext,
  ): Promise<KycManualReview> {
    this.assertAdmin(actor)
    const assignee = input.assigneeActorId.trim()
    if (!assignee) {
      throw new AppError({
        status: 400,
        code: 'KYC_REVIEW_ASSIGNEE_INVALID',
        message: 'KYC review assignee is invalid',
      })
    }
    return withTransaction(this.pool, async (client) => {
      const reasons = normalizeReasons(input.reasonCodes, 'KYC_MANUAL_REVIEW_ASSIGNED')
      const review = await this.reviews.assign(
        input.reviewId,
        randomUUID(),
        assignee,
        actor,
        reasons,
        normalizeNotes(input.notes),
        this.clock(),
        client,
      )
      if (!review) throw this.reviewNotFound()
      await this.appendAudit('kyc.manual_review_assigned', review, actor, reasons, client)
      return review
    })
  }

  async approve(
    input: KycManualReviewActionInput,
    actor: KycActorContext,
  ): Promise<KycManualReview> {
    return this.decide(input, actor, 'verified')
  }

  async reject(
    input: KycManualReviewActionInput,
    actor: KycActorContext,
  ): Promise<KycManualReview> {
    return this.decide(input, actor, 'failed')
  }

  async resume(
    input: KycManualReviewActionInput,
    actor: KycActorContext,
  ): Promise<KycManualReview> {
    return this.decide(input, actor, 'pending')
  }

  private async decide(
    input: KycManualReviewActionInput,
    actor: KycActorContext,
    outcome: 'verified' | 'failed' | 'pending',
  ): Promise<KycManualReview> {
    this.assertAdmin(actor)
    return withTransaction(this.pool, async (client) => {
      const review = await this.reviews.findById(input.reviewId, client)
      if (!review || review.status === 'completed' || !review.sessionId) {
        throw this.reviewNotFound()
      }
      const session = await this.sessions.findByIdForUpdate(review.sessionId, client)
      if (!session || !['manual_review', 'verified'].includes(session.status)) {
        throw new AppError({
          status: 409,
          code: 'KYC_INVALID_STATE_TRANSITION',
          message: 'KYC review session cannot be decided in its current state',
        })
      }
      const now = this.clock()
      const primary =
        outcome === 'verified'
          ? 'KYC_MANUAL_REVIEW_APPROVED'
          : outcome === 'failed'
            ? 'KYC_MANUAL_REVIEW_REJECTED'
            : 'KYC_MANUAL_REVIEW_RESUMED'
      const reasons = normalizeReasons(input.reasonCodes, primary)
      const updatedSession = await this.sessions.updateFromEvent(
        {
          sessionId: session.id,
          status: outcome,
          eventAt: now,
          completedAt: outcome === 'pending' ? null : now,
        },
        client,
      )
      if (!updatedSession) throw new Error('KYC review session update failed')
      await this.transitions.execute(
        {
          playerId: review.playerId,
          toStatus: outcome,
          trigger: 'MANUAL_REVIEW_DECISION',
          reasonCode: primary,
          reasonCodes: reasons,
          sessionId: session.id,
          provider: session.provider,
          verifiedAt: outcome === 'verified' ? now : undefined,
          expiresAt:
            outcome === 'verified'
              ? new Date(now.getTime() + this.verificationTtlMs)
              : null,
          failureReasonCode: outcome === 'failed' ? primary : null,
          reviewId: review.id,
          notes: normalizeNotes(input.notes),
        },
        actor,
        client,
      )
      const completed = await this.reviews.findById(review.id, client)
      if (!completed) throw this.reviewNotFound()
      return completed
    })
  }

  private assertAdmin(actor: KycActorContext): void {
    if (actor.actorType !== 'ADMIN' || !actor.actorId?.trim()) {
      throw new AppError({
        status: 403,
        code: 'KYC_ADMIN_IDENTITY_REQUIRED',
        message: 'Authenticated admin identity is required for KYC review actions',
      })
    }
  }

  private reviewNotFound(): AppError {
    return new AppError({
      status: 404,
      code: 'KYC_REVIEW_NOT_FOUND',
      message: 'KYC manual review was not found',
    })
  }

  private async appendAudit(
    action: string,
    review: KycManualReview,
    actor: KycActorContext,
    reasonCodes: string[],
    executor: Parameters<AuditRepository['append']>[1],
  ): Promise<void> {
    await this.audit.append(
      {
        id: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        playerId: review.playerId,
        action,
        outcome: 'success',
        reasonCode: reasonCodes[0] ?? null,
        correlationId: actor.correlationId,
        metadata: {
          reviewId: review.id,
          kycProfileId: review.kycProfileId,
          status: review.status,
          assignedActorId: review.assignedActorId,
          reasonCodes,
        },
      },
      executor,
    )
  }
}

import { randomUUID } from 'node:crypto'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import { ELIGIBILITY_POLICY_VERSION } from '../../eligibility/domain/EligibilityDecision.js'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import type { KycReasonCode } from '../domain/KycReasonCode.js'
import type { KycProfile } from '../domain/KycProfile.js'
import type { KycStatus } from '../domain/KycStatus.js'
import { canTransitionKycStatus } from '../domain/KycTransition.js'
import type { KycManualReviewRepository } from '../infrastructure/KycManualReviewRepository.js'
import type { KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycStatusTransitionRepository } from '../infrastructure/KycStatusTransitionRepository.js'
import type { KycActorContext } from './KycContext.js'

export const KYC_TRANSITION_TRIGGERS = [
  'SESSION_STARTED',
  'PROVIDER_EVENT',
  'MANUAL_REVIEW_DECISION',
  'SESSION_EXPIRY',
  'VERIFICATION_EXPIRY',
  'REQUEST_TIME_EXPIRY',
] as const

export type KycTransitionTrigger = (typeof KYC_TRANSITION_TRIGGERS)[number]

export interface TransitionKycStatusInput {
  playerId: string
  toStatus: KycStatus
  trigger: KycTransitionTrigger
  reasonCode: KycReasonCode
  reasonCodes?: readonly string[]
  sessionId?: string | null
  provider?: string | null
  providerEventRecordId?: string | null
  providerEventId?: string | null
  verifiedAt?: Date | null
  expiresAt?: Date | null
  failureReasonCode?: string | null
  reviewId?: string | null
  notes?: string | null
  metadata?: Record<string, unknown>
}

function normalizedReasonCodes(
  primary: KycReasonCode,
  additional: readonly string[] = [],
): string[] {
  const values = [primary, ...additional]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 20)
  return [...new Set(values)]
}

function manualReviewCompletionAction(toStatus: KycStatus): string {
  if (toStatus === 'verified') return 'review_approved'
  if (toStatus === 'failed') return 'review_rejected'
  if (toStatus === 'pending') return 'review_resumed'
  return 'review_expired'
}

export class TransitionKycStatusService {
  constructor(
    private readonly profiles: KycProfileRepository,
    private readonly transitions: KycStatusTransitionRepository,
    private readonly reviews: KycManualReviewRepository,
    private readonly audit: AuditRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    input: TransitionKycStatusInput,
    actor: KycActorContext,
    executor: QueryExecutor,
  ): Promise<KycProfile> {
    this.assertActor(actor)
    const before = await this.profiles.getForUpdate(input.playerId, executor)
    if (!before) {
      throw new AppError({
        status: 404,
        code: 'KYC_PROFILE_NOT_FOUND',
        message: 'KYC profile was not found',
      })
    }
    if (!canTransitionKycStatus(before.status, input.toStatus)) {
      throw new AppError({
        status: 409,
        code: 'KYC_INVALID_STATE_TRANSITION',
        message: `Cannot transition KYC from ${before.status} to ${input.toStatus}`,
        publicMessage: 'KYC state cannot be changed in its current state',
      })
    }

    const at = this.clock()
    const reasonCodes = normalizedReasonCodes(input.reasonCode, input.reasonCodes)
    const updated = await this.profiles.updateStatus(
      {
        profileId: before.id,
        expectedVersion: before.version,
        status: input.toStatus,
        provider: input.provider === undefined ? before.provider : input.provider,
        currentSessionId:
          input.sessionId === undefined ? before.currentSessionId : input.sessionId,
        verifiedAt:
          input.verifiedAt === undefined ? before.verifiedAt : input.verifiedAt,
        expiresAt: input.expiresAt === undefined ? before.expiresAt : input.expiresAt,
        failureReasonCode:
          input.failureReasonCode === undefined
            ? before.failureReasonCode
            : input.failureReasonCode,
      },
      executor,
    )
    if (!updated) {
      throw new AppError({
        status: 409,
        code: 'KYC_STATE_CONFLICT',
        message: 'KYC profile version conflict',
      })
    }

    await this.transitions.append(
      {
        id: randomUUID(),
        kycProfileId: before.id,
        playerId: before.playerId,
        sessionId: input.sessionId === undefined ? before.currentSessionId : input.sessionId,
        fromStatus: before.status,
        toStatus: updated.status,
        reasonCode: input.reasonCode,
        reasonCodes,
        trigger: input.trigger,
        actorType: actor.actorType,
        actorId: actor.actorId,
        providerEventId: input.providerEventRecordId ?? null,
        correlationId: actor.correlationId,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        profileVersion: updated.version,
        metadata: {
          provider: input.provider === undefined ? before.provider : input.provider,
          providerEventId: input.providerEventId ?? null,
          ...(input.metadata ?? {}),
        },
      },
      executor,
    )

    if (before.status !== 'manual_review' && updated.status === 'manual_review') {
      await this.reviews.createRequested(
        {
          id: randomUUID(),
          actionId: randomUUID(),
          playerId: before.playerId,
          kycProfileId: before.id,
          sessionId: updated.currentSessionId,
          previousStatus: before.status,
          actor,
          reasonCodes,
          notes: input.notes ?? null,
          at,
        },
        executor,
      )
    } else if (before.status === 'manual_review' && updated.status !== 'manual_review') {
      const completed = await this.reviews.complete(
        {
          reviewId: input.reviewId ?? null,
          actionId: randomUUID(),
          kycProfileId: before.id,
          previousStatus: before.status,
          newStatus: updated.status,
          action: manualReviewCompletionAction(updated.status),
          actor,
          reasonCodes,
          notes: input.notes ?? null,
          at,
        },
        executor,
      )
      if (!completed) {
        throw new AppError({
          status: 404,
          code: 'KYC_REVIEW_NOT_FOUND',
          message: 'Active KYC manual review was not found',
        })
      }
    }

    await this.audit.append(
      {
        id: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        playerId: before.playerId,
        action: 'kyc.status_changed',
        outcome: 'success',
        reasonCode: input.reasonCode,
        correlationId: actor.correlationId,
        metadata: {
          kycProfileId: before.id,
          sessionId: updated.currentSessionId,
          previousStatus: before.status,
          newStatus: updated.status,
          trigger: input.trigger,
          provider: updated.provider,
          providerEventId: input.providerEventId ?? null,
          reasonCodes,
          policyVersion: ELIGIBILITY_POLICY_VERSION,
          profileVersion: updated.version,
        },
      },
      executor,
    )
    return updated
  }

  async expireIfDue(
    playerId: string,
    actor: KycActorContext,
    executor: QueryExecutor,
  ): Promise<KycProfile | null> {
    const profile = await this.profiles.getForUpdate(playerId, executor)
    if (!profile) return null
    const now = this.clock()
    if (
      profile.status !== 'verified' ||
      profile.expiresAt === null ||
      profile.expiresAt.getTime() > now.getTime()
    ) {
      return profile
    }
    return this.execute(
      {
        playerId,
        toStatus: 'expired',
        trigger: 'REQUEST_TIME_EXPIRY',
        reasonCode: 'KYC_VERIFICATION_EXPIRED',
        reasonCodes: ['KYC_VERIFICATION_EXPIRED'],
        expiresAt: profile.expiresAt,
        failureReasonCode: null,
        metadata: { expiredAt: profile.expiresAt.toISOString() },
      },
      actor,
      executor,
    )
  }

  private assertActor(actor: KycActorContext): void {
    if (!actor.correlationId.trim() || (actor.actorId !== null && !actor.actorId.trim())) {
      throw new AppError({
        status: 400,
        code: 'KYC_ACTOR_INVALID',
        message: 'KYC transition actor context is invalid',
      })
    }
    if (actor.actorType === 'ADMIN' && !actor.actorId) {
      throw new AppError({
        status: 403,
        code: 'KYC_ADMIN_IDENTITY_REQUIRED',
        message: 'Authenticated admin identity is required',
      })
    }
  }
}

import { randomUUID } from 'node:crypto'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import { AppError } from '../../shared/http/AppError.js'
import {
  canTransitionCryptoFunding,
  type CryptoFundingActorContext,
  type CryptoFundingIntent,
  type CryptoFundingStatus,
} from '../domain/CryptoFunding.js'
import type { CryptoFundingRepository } from '../infrastructure/CryptoFundingRepository.js'

export interface TransitionCryptoFundingInput {
  intentId: string
  toStatus: CryptoFundingStatus
  trigger: string
  reasonCode: string
  providerEventRecordId?: string | null
  providerReference?: string | null
  paymentUrl?: string | null
  confirmedAt?: Date | null
  failedAt?: Date | null
  providerEventAt?: Date | null
}

export class TransitionCryptoFundingService {
  constructor(
    private readonly repository: CryptoFundingRepository,
    private readonly audit: AuditRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    input: TransitionCryptoFundingInput,
    actor: CryptoFundingActorContext,
    executor: QueryExecutor,
    lockedIntent?: CryptoFundingIntent,
  ): Promise<CryptoFundingIntent> {
    const before = lockedIntent ?? (await this.repository.findByIdForUpdate(input.intentId, executor))
    if (!before) {
      throw new AppError({ status: 404, code: 'CRYPTO_FUNDING_INTENT_NOT_FOUND', message: 'Crypto funding intent was not found' })
    }
    if (!canTransitionCryptoFunding(before.status, input.toStatus)) {
      throw new AppError({
        status: 409,
        code: 'CRYPTO_FUNDING_STATE_CONFLICT',
        message: `Cannot transition crypto funding from ${before.status} to ${input.toStatus}`,
        publicMessage: 'Crypto funding state cannot be changed in its current state',
      })
    }
    const at = this.clock()
    const updated = await this.repository.updateStatus(
      {
        intentId: before.id,
        expectedVersion: before.version,
        status: input.toStatus,
        providerReference: input.providerReference,
        paymentUrl: input.paymentUrl,
        confirmedAt: input.confirmedAt,
        failedAt: input.failedAt,
        providerEventAt: input.providerEventAt,
      },
      executor,
    )
    if (!updated) throw new AppError({ status: 409, code: 'CRYPTO_FUNDING_STATE_CONFLICT', message: 'Crypto funding version conflict' })
    await this.repository.appendTransition(
      {
        id: randomUUID(),
        intent: before,
        newStatus: updated.status,
        trigger: input.trigger,
        reasonCode: input.reasonCode,
        actorType: actor.actorType,
        actorId: actor.actorId,
        providerEventRecordId: input.providerEventRecordId ?? null,
        correlationId: actor.correlationId,
        createdAt: at,
      },
      executor,
    )
    await this.audit.append(
      {
        id: randomUUID(), actorType: actor.actorType, actorId: actor.actorId,
        playerId: before.playerId, action: 'crypto.funding_status_changed', outcome: 'success',
        reasonCode: input.reasonCode, correlationId: actor.correlationId,
        metadata: { fundingIntentId: before.id, previousStatus: before.status,
          newStatus: updated.status, trigger: input.trigger, provider: before.provider,
          providerEventRecordId: input.providerEventRecordId ?? null, intentVersion: updated.version },
      },
      executor,
    )
    return updated
  }
}

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import { withTransaction } from '../../shared/db/transaction.js'
import type { CryptoFundingActorContext } from '../domain/CryptoFunding.js'
import type { CryptoFundingRepository } from '../infrastructure/CryptoFundingRepository.js'
import type { TransitionCryptoFundingService } from './TransitionCryptoFundingService.js'

export interface ExpireCryptoFundingResult { examined: number; expired: number; reconciliations: number }

export class ExpireCryptoFundingIntentsService {
  constructor(private readonly pool: Pool, private readonly repository: CryptoFundingRepository,
    private readonly transitions: TransitionCryptoFundingService, private readonly audit: AuditRepository,
    private readonly batchSize = 100) {}

  async execute(now: Date, actor: CryptoFundingActorContext): Promise<ExpireCryptoFundingResult> {
    return withTransaction(this.pool, async (client) => {
      const due = await this.repository.findExpired(now, this.batchSize, client)
      let reconciliations = 0
      for (const intent of due) {
        if (intent.status === 'detected' || intent.status === 'confirming') {
          await this.repository.createReconciliation({ id: randomUUID(), fundingIntentId: intent.id,
            providerEventRecordId: null, type: 'INTENT_EXPIRED_AFTER_PAYMENT_DETECTED',
            expectedAsset: intent.asset, actualAsset: intent.asset,
            expectedAmount: intent.requestedAmount, actualAmount: null,
            correlationId: actor.correlationId, createdAt: now }, client)
          reconciliations += 1
        }
        await this.transitions.execute({ intentId: intent.id, toStatus: 'expired', trigger: 'EXPIRY_WORKER',
          reasonCode: 'CRYPTO_FUNDING_INTENT_EXPIRED' }, actor, client, intent)
        await this.audit.append({ id: randomUUID(), actorType: actor.actorType, actorId: actor.actorId,
          playerId: intent.playerId, action: 'crypto.funding_expired', outcome: 'success',
          reasonCode: 'CRYPTO_FUNDING_INTENT_EXPIRED', correlationId: actor.correlationId,
          metadata: { fundingIntentId: intent.id } }, client)
      }
      return { examined: due.length, expired: due.length, reconciliations }
    })
  }
}

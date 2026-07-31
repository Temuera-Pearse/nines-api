import { sanitizeAuditMetadata } from '../../audit/metadata.js'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycStatusTransition } from '../domain/KycTransition.js'
import type { KycStatusTransitionRepository } from './KycStatusTransitionRepository.js'

export class PostgresKycStatusTransitionRepository
  implements KycStatusTransitionRepository
{
  async append(
    transition: Omit<KycStatusTransition, 'createdAt'>,
    executor: QueryExecutor,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO kyc_status_transitions
        (id, player_id, session_id, from_status, to_status, reason_code,
         actor_type, actor_id, provider_event_id, correlation_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        transition.id,
        transition.playerId,
        transition.sessionId,
        transition.fromStatus,
        transition.toStatus,
        transition.reasonCode,
        transition.actorType,
        transition.actorId,
        transition.providerEventId,
        transition.correlationId,
        JSON.stringify(sanitizeAuditMetadata(transition.metadata)),
      ],
    )
  }
}

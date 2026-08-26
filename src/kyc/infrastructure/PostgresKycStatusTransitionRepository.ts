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
        (id, kyc_profile_id, player_id, session_id, from_status, to_status,
         reason_code, reason_codes, transition_trigger, actor_type, actor_id,
         provider_event_id, correlation_id, policy_version, profile_version, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
      [
        transition.id,
        transition.kycProfileId,
        transition.playerId,
        transition.sessionId,
        transition.fromStatus,
        transition.toStatus,
        transition.reasonCode,
        transition.reasonCodes,
        transition.trigger,
        transition.actorType,
        transition.actorId,
        transition.providerEventId,
        transition.correlationId,
        transition.policyVersion,
        transition.profileVersion,
        JSON.stringify(sanitizeAuditMetadata(transition.metadata)),
      ],
    )
  }
}

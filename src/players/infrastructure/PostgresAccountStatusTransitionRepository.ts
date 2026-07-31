import type { QueryExecutor } from '../../shared/db/transaction.js'
import type {
  AccountStatusTransitionRepository,
  AppendAccountStatusTransitionInput,
} from './AccountStatusTransitionRepository.js'

export class PostgresAccountStatusTransitionRepository
  implements AccountStatusTransitionRepository
{
  async append(
    transition: AppendAccountStatusTransitionInput,
    executor: QueryExecutor,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO player_account_status_transitions
        (id, player_id, from_status, to_status, reason_code, actor_type, actor_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        transition.id,
        transition.playerId,
        transition.fromStatus,
        transition.toStatus,
        transition.reasonCode,
        transition.actorType,
        transition.actorId,
        transition.correlationId,
      ],
    )
  }
}

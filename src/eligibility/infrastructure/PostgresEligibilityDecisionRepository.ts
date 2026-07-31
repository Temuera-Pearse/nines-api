import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { EligibilityDecision } from '../domain/EligibilityDecision.js'
import type { EligibilityDecisionRepository } from './EligibilityDecisionRepository.js'

export class PostgresEligibilityDecisionRepository
  implements EligibilityDecisionRepository
{
  async append(
    decision: EligibilityDecision,
    correlationId: string,
    executor: QueryExecutor,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO eligibility_decisions
        (id, player_id, operation, allowed, reason_codes, policy_version,
         input_snapshot, correlation_id, created_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7::jsonb, $8, $9)`,
      [
        decision.decisionId,
        decision.playerId,
        decision.operation,
        decision.allowed,
        decision.reasonCodes,
        decision.policyVersion,
        JSON.stringify(decision.inputSnapshot),
        correlationId,
        decision.evaluatedAt,
      ],
    )
  }
}

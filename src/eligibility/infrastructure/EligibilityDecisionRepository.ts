import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { EligibilityDecision } from '../domain/EligibilityDecision.js'

export interface EligibilityDecisionRepository {
  append(
    decision: EligibilityDecision,
    correlationId: string,
    executor: QueryExecutor,
  ): Promise<void>
}

import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycStatusTransition } from '../domain/KycTransition.js'

export interface KycStatusTransitionRepository {
  append(
    transition: Omit<KycStatusTransition, 'createdAt'>,
    executor: QueryExecutor,
  ): Promise<void>
}

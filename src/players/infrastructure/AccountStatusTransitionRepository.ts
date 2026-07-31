import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { AccountStatusTransition } from '../domain/AccountStatusTransition.js'

export type AppendAccountStatusTransitionInput = Omit<AccountStatusTransition, 'createdAt'>

export interface AccountStatusTransitionRepository {
  append(
    transition: AppendAccountStatusTransitionInput,
    executor: QueryExecutor,
  ): Promise<void>
}

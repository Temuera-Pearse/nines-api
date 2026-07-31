import type { QueryExecutor } from '../shared/db/transaction.js'
import type { AppendAuditEventInput } from './AuditEvent.js'

export interface AuditRepository {
  append(event: AppendAuditEventInput, executor: QueryExecutor): Promise<void>
}

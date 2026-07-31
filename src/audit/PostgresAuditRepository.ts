import type { QueryExecutor } from '../shared/db/transaction.js'
import type { AuditRepository } from './AuditRepository.js'
import type { AppendAuditEventInput } from './AuditEvent.js'
import { sanitizeAuditMetadata } from './metadata.js'

export class PostgresAuditRepository implements AuditRepository {
  async append(event: AppendAuditEventInput, executor: QueryExecutor): Promise<void> {
    await executor.query(
      `INSERT INTO audit_events
        (id, actor_type, actor_id, player_id, action, outcome, reason_code, correlation_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        event.id,
        event.actorType,
        event.actorId,
        event.playerId,
        event.action,
        event.outcome,
        event.reasonCode,
        event.correlationId,
        JSON.stringify(sanitizeAuditMetadata(event.metadata)),
      ],
    )
  }
}

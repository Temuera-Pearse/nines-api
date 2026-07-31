import type { QueryResultRow } from 'pg'
import { sanitizeAuditMetadata } from '../../audit/metadata.js'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type {
  KycEventProcessingStatus,
  KycEventResultStatus,
  NormalizedKycProviderEvent,
  StoredKycProviderEvent,
} from '../domain/KycProviderEvent.js'
import type {
  InsertKycProviderEventResult,
  KycProviderEventRepository,
} from './KycProviderEventRepository.js'

interface KycProviderEventRow extends QueryResultRow {
  id: string
  provider: string
  provider_event_id: string
  provider_session_reference: string
  event_type: string
  normalized_status: KycEventResultStatus
  event_timestamp: Date
  payload_hash: string
  processing_status: KycEventProcessingStatus
  processing_reason_code: string | null
  correlation_id: string
  received_at: Date
  processed_at: Date | null
  metadata: Record<string, unknown>
}

const EVENT_COLUMNS = `
  id, provider, provider_event_id, provider_session_reference, event_type,
  normalized_status, event_timestamp, payload_hash, processing_status,
  processing_reason_code, correlation_id, received_at, processed_at, metadata
`

function mapEvent(row: KycProviderEventRow): StoredKycProviderEvent {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    providerSessionReference: row.provider_session_reference,
    eventType: row.event_type,
    resultingStatus: row.normalized_status,
    occurredAt: row.event_timestamp,
    payloadHash: row.payload_hash,
    processingStatus: row.processing_status,
    processingReasonCode: row.processing_reason_code,
    correlationId: row.correlation_id,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    reasonCode: null,
    metadata: row.metadata,
  }
}

export class PostgresKycProviderEventRepository
  implements KycProviderEventRepository
{
  async find(
    provider: string,
    providerEventId: string,
    executor: QueryExecutor,
  ): Promise<StoredKycProviderEvent | null> {
    const result = await executor.query<KycProviderEventRow>(
      `SELECT ${EVENT_COLUMNS}
       FROM kyc_provider_events
       WHERE provider = $1 AND provider_event_id = $2`,
      [provider, providerEventId],
    )
    return result.rows[0] ? mapEvent(result.rows[0]) : null
  }

  async insert(
    id: string,
    event: NormalizedKycProviderEvent,
    correlationId: string,
    receivedAt: Date,
    executor: QueryExecutor,
  ): Promise<InsertKycProviderEventResult> {
    const inserted = await executor.query<KycProviderEventRow>(
      `INSERT INTO kyc_provider_events
        (id, provider, provider_event_id, provider_session_reference, event_type,
         normalized_status, event_timestamp, payload_hash, correlation_id,
         received_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING ${EVENT_COLUMNS}`,
      [
        id,
        event.provider,
        event.providerEventId,
        event.providerSessionReference,
        event.eventType,
        event.resultingStatus,
        event.occurredAt,
        event.payloadHash,
        correlationId,
        receivedAt,
        JSON.stringify(sanitizeAuditMetadata(event.metadata)),
      ],
    )
    if (inserted.rows[0]) return { event: mapEvent(inserted.rows[0]), created: true }
    const existing = await this.find(event.provider, event.providerEventId, executor)
    if (!existing) throw new Error('KYC provider event conflict did not resolve to a row')
    return { event: existing, created: false }
  }

  async markProcessed(
    eventId: string,
    status: Exclude<KycEventProcessingStatus, 'received'>,
    reasonCode: string | null,
    processedAt: Date,
    executor: QueryExecutor,
  ): Promise<StoredKycProviderEvent> {
    const result = await executor.query<KycProviderEventRow>(
      `UPDATE kyc_provider_events
       SET processing_status = $2,
           processing_reason_code = $3,
           processed_at = $4
       WHERE id = $1
       RETURNING ${EVENT_COLUMNS}`,
      [eventId, status, reasonCode, processedAt],
    )
    if (!result.rows[0]) throw new Error('KYC provider event was not found')
    return mapEvent(result.rows[0])
  }
}

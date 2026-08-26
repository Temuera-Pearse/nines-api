import type { QueryExecutor } from '../../shared/db/transaction.js'
import type {
  KycEventProcessingStatus,
  NormalizedKycProviderEvent,
  StoredKycProviderEvent,
} from '../domain/KycProviderEvent.js'

export interface InsertKycProviderEventResult {
  event: StoredKycProviderEvent
  created: boolean
}

export interface KycProviderEventRepository {
  find(
    provider: string,
    providerEventId: string,
    executor: QueryExecutor,
  ): Promise<StoredKycProviderEvent | null>
  insert(
    id: string,
    event: NormalizedKycProviderEvent,
    correlationId: string,
    receivedAt: Date,
    executor: QueryExecutor,
  ): Promise<InsertKycProviderEventResult>
  markProcessed(
    eventId: string,
    status: Exclude<KycEventProcessingStatus, 'received'>,
    reasonCode: string | null,
    processedAt: Date,
    acceptedAt: Date | null,
    executor: QueryExecutor,
  ): Promise<StoredKycProviderEvent>
}

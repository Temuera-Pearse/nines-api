import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { CryptoFundingIntent, CryptoFundingStatus } from '../domain/CryptoFunding.js'
import type {
  CryptoEventProcessingStatus,
  NormalizedCryptoProviderEvent,
  StoredCryptoProviderEvent,
} from '../domain/CryptoProviderEvent.js'
import type { CryptoReconciliationType } from '../domain/CryptoReconciliation.js'

export interface CreateCryptoFundingIntentInput {
  id: string
  providerSessionId: string
  playerId: string
  asset: string
  requestedAmount: string
  provider: string
  idempotencyKey: string
  requestHash: string
  expiresAt: Date
  createdAt: Date
}

export interface UpdateCryptoFundingStatusInput {
  intentId: string
  expectedVersion: number
  status: CryptoFundingStatus
  providerReference?: string | null
  paymentUrl?: string | null
  confirmedAt?: Date | null
  failedAt?: Date | null
  providerEventAt?: Date | null
}

export interface InsertCryptoProviderEventResult {
  event: StoredCryptoProviderEvent
  created: boolean
}

export interface CryptoFundingRepository {
  createIntent(input: CreateCryptoFundingIntentInput, executor: QueryExecutor): Promise<CryptoFundingIntent | null>
  findById(intentId: string, executor: QueryExecutor): Promise<CryptoFundingIntent | null>
  findByIdForUpdate(intentId: string, executor: QueryExecutor): Promise<CryptoFundingIntent | null>
  findByPlayerIdempotencyKey(playerId: string, key: string, executor: QueryExecutor): Promise<CryptoFundingIntent | null>
  findByProviderReferenceForUpdate(provider: string, reference: string, executor: QueryExecutor): Promise<CryptoFundingIntent | null>
  listForPlayer(playerId: string, limit: number, executor: QueryExecutor): Promise<CryptoFundingIntent[]>
  updateStatus(input: UpdateCryptoFundingStatusInput, executor: QueryExecutor): Promise<CryptoFundingIntent | null>
  activateProviderSession(intentId: string, reference: string, paymentUrl: string | null, executor: QueryExecutor): Promise<void>
  failProviderSession(intentId: string, executor: QueryExecutor): Promise<void>
  findExpired(at: Date, limit: number, executor: QueryExecutor): Promise<CryptoFundingIntent[]>
  appendTransition(input: {
    id: string
    intent: CryptoFundingIntent
    newStatus: CryptoFundingStatus
    trigger: string
    reasonCode: string
    actorType: string
    actorId: string | null
    providerEventRecordId: string | null
    correlationId: string
    createdAt: Date
  }, executor: QueryExecutor): Promise<void>
  findEvent(provider: string, providerEventId: string, executor: QueryExecutor): Promise<StoredCryptoProviderEvent | null>
  insertEvent(id: string, event: NormalizedCryptoProviderEvent, correlationId: string, receivedAt: Date, executor: QueryExecutor): Promise<InsertCryptoProviderEventResult>
  markEvent(input: {
    eventId: string
    fundingIntentId: string | null
    status: Exclude<CryptoEventProcessingStatus, 'received'>
    reasonCode: string | null
    processedAt: Date
    acceptedAt: Date | null
  }, executor: QueryExecutor): Promise<StoredCryptoProviderEvent>
  createReconciliation(input: {
    id: string
    fundingIntentId: string | null
    providerEventRecordId: string | null
    type: CryptoReconciliationType
    expectedAsset: string | null
    actualAsset: string | null
    expectedAmount: string | null
    actualAmount: string | null
    correlationId: string
    createdAt: Date
  }, executor: QueryExecutor): Promise<void>
  createFinancialInstruction(input: {
    id: string
    intent: CryptoFundingIntent
    confirmedAt: Date
    createdAt: Date
  }, executor: QueryExecutor): Promise<boolean>
}

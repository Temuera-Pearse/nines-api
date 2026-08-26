import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycSession, KycSessionStatus } from '../domain/KycSession.js'

export interface CreateKycSessionIntentInput {
  id: string
  playerId: string
  provider: string
  idempotencyKey: string | null
  attemptNumber: number
  startedAt: Date
}

export interface ActivateKycSessionInput {
  sessionId: string
  providerSessionReference: string
  verificationUrl: string | null
  expiresAt: Date
}

export interface UpdateKycSessionFromEventInput {
  sessionId: string
  status: KycSessionStatus
  eventAt: Date
  completedAt: Date | null
}

export interface KycSessionRepository {
  getCurrentEffective(
    playerId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  findById(sessionId: string, executor: QueryExecutor): Promise<KycSession | null>
  findByIdForUpdate(
    sessionId: string,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  findByIdempotencyKey(
    playerId: string,
    idempotencyKey: string,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  nextAttemptNumber(playerId: string, executor: QueryExecutor): Promise<number>
  createIntent(
    input: CreateKycSessionIntentInput,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  activate(
    input: ActivateKycSessionInput,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  markCreationFailed(
    sessionId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  expireIfDue(
    sessionId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  findByProviderReferenceForUpdate(
    provider: string,
    providerSessionReference: string,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  updateFromEvent(
    input: UpdateKycSessionFromEventInput,
    executor: QueryExecutor,
  ): Promise<KycSession | null>
  findExpiredPending(
    at: Date,
    limit: number,
    executor: QueryExecutor,
  ): Promise<KycSession[]>
}

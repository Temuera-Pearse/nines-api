import type { QueryResultRow } from 'pg'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import { hashCanonicalJson } from '../../shared/contracts/canonicalJson.js'
import type { CryptoFundingIntent, CryptoFundingStatus } from '../domain/CryptoFunding.js'
import type {
  CryptoEventProcessingStatus,
  CryptoProviderEventMetadata,
  CryptoProviderEventStatus,
  NormalizedCryptoProviderEvent,
  StoredCryptoProviderEvent,
} from '../domain/CryptoProviderEvent.js'
import type {
  CreateCryptoFundingIntentInput,
  CryptoFundingRepository,
  InsertCryptoProviderEventResult,
  UpdateCryptoFundingStatusInput,
} from './CryptoFundingRepository.js'

interface IntentRow extends QueryResultRow {
  id: string
  player_id: string
  asset: string
  requested_amount: string
  status: CryptoFundingStatus
  provider: string
  idempotency_key: string
  request_hash: string
  eligibility_decision_id: string | null
  eligibility_policy_version: string | null
  eligibility_evaluated_at: Date | null
  provider_reference: string | null
  payment_url: string | null
  expires_at: Date
  confirmed_at: Date | null
  failed_at: Date | null
  last_provider_event_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

interface EventRow extends QueryResultRow {
  id: string
  funding_intent_id: string | null
  provider: string
  provider_event_id: string
  provider_reference: string
  claimed_funding_intent_id: string | null
  claimed_player_id: string | null
  event_type: string
  normalized_status: CryptoProviderEventStatus
  provider_occurred_at: Date
  received_at: Date
  accepted_at: Date | null
  processed_at: Date | null
  asset: string | null
  amount: string | null
  payload_hash: string
  processing_status: CryptoEventProcessingStatus
  processing_reason_code: string | null
  correlation_id: string
  metadata: CryptoProviderEventMetadata
}

const INTENT_COLUMNS = `id, player_id, asset, requested_amount, status, provider,
  idempotency_key, request_hash, eligibility_decision_id, eligibility_policy_version,
  eligibility_evaluated_at, provider_reference, payment_url, expires_at,
  confirmed_at, failed_at, last_provider_event_at, version, created_at, updated_at`

const EVENT_COLUMNS = `id, funding_intent_id, provider, provider_event_id,
  provider_reference, claimed_funding_intent_id, claimed_player_id, event_type,
  normalized_status, provider_occurred_at, received_at, accepted_at, processed_at,
  asset, amount, payload_hash, processing_status, processing_reason_code,
  correlation_id, metadata`

function mapIntent(row: IntentRow): CryptoFundingIntent {
  return {
    id: row.id,
    playerId: row.player_id,
    asset: row.asset,
    requestedAmount: row.requested_amount,
    status: row.status,
    provider: row.provider,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    eligibilityDecisionId: row.eligibility_decision_id,
    eligibilityPolicyVersion: row.eligibility_policy_version,
    eligibilityEvaluatedAt: row.eligibility_evaluated_at,
    providerReference: row.provider_reference,
    paymentUrl: row.payment_url,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    failedAt: row.failed_at,
    lastProviderEventAt: row.last_provider_event_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapEvent(row: EventRow): StoredCryptoProviderEvent {
  return {
    id: row.id,
    fundingIntentId: row.funding_intent_id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    providerReference: row.provider_reference,
    claimedFundingIntentId: row.claimed_funding_intent_id,
    claimedPlayerId: row.claimed_player_id,
    eventType: row.event_type,
    status: row.normalized_status,
    providerOccurredAt: row.provider_occurred_at,
    receivedAt: row.received_at,
    acceptedAt: row.accepted_at,
    processedAt: row.processed_at,
    asset: row.asset,
    amount: row.amount,
    payloadHash: row.payload_hash,
    processingStatus: row.processing_status,
    processingReasonCode: row.processing_reason_code,
    correlationId: row.correlation_id,
    metadata: row.metadata,
  }
}

function assertMetadata(metadata: CryptoProviderEventMetadata): void {
  const allowed = new Set(['providerTransactionId', 'confirmationStage', 'sequence'])
  if (Object.keys(metadata).some((key) => !allowed.has(key))) {
    throw new Error('Crypto provider metadata contains non-allowlisted fields')
  }
}

export class PostgresCryptoFundingRepository implements CryptoFundingRepository {
  async createIntent(input: CreateCryptoFundingIntentInput, executor: QueryExecutor): Promise<CryptoFundingIntent | null> {
    const result = await executor.query<IntentRow>(
      `WITH created AS (
         INSERT INTO crypto_funding_intents
           (id, player_id, asset, requested_amount, status, provider,
            idempotency_key, request_hash, eligibility_decision_id,
            eligibility_policy_version, eligibility_evaluated_at, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'provider_pending', $5, $6, $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT (player_id, idempotency_key) DO NOTHING
         RETURNING id
       ), session AS (
         INSERT INTO crypto_funding_provider_sessions
           (id, funding_intent_id, provider, provider_idempotency_key, status, created_at, updated_at)
         SELECT $13, id, $5, id, 'creating', $12, $12 FROM created
       )
       SELECT ${INTENT_COLUMNS} FROM crypto_funding_intents
       WHERE id IN (SELECT id FROM created)`,
      [input.id, input.playerId, input.asset, input.requestedAmount, input.provider,
        input.idempotencyKey, input.requestHash, input.eligibilityDecisionId,
        input.eligibilityPolicyVersion, input.eligibilityEvaluatedAt, input.expiresAt,
        input.createdAt, input.providerSessionId],
    )
    return result.rows[0] ? mapIntent(result.rows[0]) : null
  }

  async findById(intentId: string, executor: QueryExecutor): Promise<CryptoFundingIntent | null> {
    const result = await executor.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM crypto_funding_intents WHERE id = $1`, [intentId],
    )
    return result.rows[0] ? mapIntent(result.rows[0]) : null
  }

  async findByIdForUpdate(intentId: string, executor: QueryExecutor): Promise<CryptoFundingIntent | null> {
    const result = await executor.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM crypto_funding_intents WHERE id = $1 FOR UPDATE`, [intentId],
    )
    return result.rows[0] ? mapIntent(result.rows[0]) : null
  }

  async findByPlayerIdempotencyKey(playerId: string, key: string, executor: QueryExecutor): Promise<CryptoFundingIntent | null> {
    const result = await executor.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM crypto_funding_intents
       WHERE player_id = $1 AND idempotency_key = $2`, [playerId, key],
    )
    return result.rows[0] ? mapIntent(result.rows[0]) : null
  }

  async findByProviderReferenceForUpdate(provider: string, reference: string, executor: QueryExecutor): Promise<CryptoFundingIntent | null> {
    const result = await executor.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM crypto_funding_intents
       WHERE provider = $1 AND provider_reference = $2 FOR UPDATE`, [provider, reference],
    )
    return result.rows[0] ? mapIntent(result.rows[0]) : null
  }

  async listForPlayer(playerId: string, limit: number, executor: QueryExecutor): Promise<CryptoFundingIntent[]> {
    const result = await executor.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM crypto_funding_intents
       WHERE player_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [playerId, limit],
    )
    return result.rows.map(mapIntent)
  }

  async updateStatus(input: UpdateCryptoFundingStatusInput, executor: QueryExecutor): Promise<CryptoFundingIntent | null> {
    const result = await executor.query<IntentRow>(
      `UPDATE crypto_funding_intents SET
         status = $3,
         provider_reference = CASE WHEN $4::boolean THEN $5 ELSE provider_reference END,
         payment_url = CASE WHEN $6::boolean THEN $7 ELSE payment_url END,
         confirmed_at = CASE WHEN $8::boolean THEN $9 ELSE confirmed_at END,
         failed_at = CASE WHEN $10::boolean THEN $11 ELSE failed_at END,
         last_provider_event_at = CASE WHEN $12::boolean THEN $13 ELSE last_provider_event_at END,
         version = version + 1, updated_at = NOW()
       WHERE id = $1 AND version = $2 RETURNING ${INTENT_COLUMNS}`,
      [input.intentId, input.expectedVersion, input.status,
        input.providerReference !== undefined, input.providerReference ?? null,
        input.paymentUrl !== undefined, input.paymentUrl ?? null,
        input.confirmedAt !== undefined, input.confirmedAt ?? null,
        input.failedAt !== undefined, input.failedAt ?? null,
        input.providerEventAt !== undefined, input.providerEventAt ?? null],
    )
    return result.rows[0] ? mapIntent(result.rows[0]) : null
  }

  async activateProviderSession(intentId: string, reference: string, paymentUrl: string | null, executor: QueryExecutor): Promise<void> {
    await executor.query(
      `UPDATE crypto_funding_provider_sessions SET provider_reference = $2,
         status = 'active', updated_at = NOW()
       WHERE funding_intent_id = $1`, [intentId, reference],
    )
    await executor.query(
      `UPDATE crypto_funding_intents SET provider_reference = $2, payment_url = $3,
         updated_at = NOW() WHERE id = $1`, [intentId, reference, paymentUrl],
    )
  }

  async failProviderSession(intentId: string, executor: QueryExecutor): Promise<void> {
    await executor.query(
      `UPDATE crypto_funding_provider_sessions SET status = 'creation_failed', updated_at = NOW()
       WHERE funding_intent_id = $1 AND status = 'creating'`, [intentId],
    )
  }

  async findExpired(at: Date, limit: number, executor: QueryExecutor): Promise<CryptoFundingIntent[]> {
    const result = await executor.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM crypto_funding_intents
       WHERE status IN ('provider_pending', 'awaiting_payment', 'detected', 'confirming')
         AND expires_at <= $1 ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [at, limit],
    )
    return result.rows.map(mapIntent)
  }

  async appendTransition(input: Parameters<CryptoFundingRepository['appendTransition']>[0], executor: QueryExecutor): Promise<void> {
    await executor.query(
      `INSERT INTO crypto_funding_transitions
        (id, funding_intent_id, player_id, from_status, to_status, trigger,
         reason_code, actor_type, actor_id, provider_event_id, correlation_id,
         intent_version, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [input.id, input.intent.id, input.intent.playerId, input.intent.status,
        input.newStatus, input.trigger, input.reasonCode, input.actorType, input.actorId,
        input.providerEventRecordId, input.correlationId, input.intent.version + 1, input.createdAt],
    )
  }

  async findEvent(provider: string, providerEventId: string, executor: QueryExecutor): Promise<StoredCryptoProviderEvent | null> {
    const result = await executor.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM crypto_provider_events
       WHERE provider = $1 AND provider_event_id = $2`, [provider, providerEventId],
    )
    return result.rows[0] ? mapEvent(result.rows[0]) : null
  }

  async insertEvent(id: string, event: NormalizedCryptoProviderEvent, correlationId: string, receivedAt: Date, executor: QueryExecutor): Promise<InsertCryptoProviderEventResult> {
    assertMetadata(event.metadata)
    const result = await executor.query<EventRow>(
      `INSERT INTO crypto_provider_events
        (id, provider, provider_event_id, provider_reference, claimed_funding_intent_id,
         claimed_player_id, event_type, normalized_status, provider_occurred_at,
         received_at, asset, amount, payload_hash, correlation_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING ${EVENT_COLUMNS}`,
      [id, event.provider, event.providerEventId, event.providerReference,
        event.claimedFundingIntentId, event.claimedPlayerId, event.eventType, event.status,
        event.providerOccurredAt, receivedAt, event.asset, event.amount, event.payloadHash,
        correlationId, JSON.stringify(event.metadata)],
    )
    if (result.rows[0]) return { event: mapEvent(result.rows[0]), created: true }
    const existing = await this.findEvent(event.provider, event.providerEventId, executor)
    if (!existing) throw new Error('Crypto provider event conflict did not resolve')
    return { event: existing, created: false }
  }

  async markEvent(input: Parameters<CryptoFundingRepository['markEvent']>[0], executor: QueryExecutor): Promise<StoredCryptoProviderEvent> {
    const result = await executor.query<EventRow>(
      `UPDATE crypto_provider_events SET funding_intent_id = $2,
         processing_status = $3, processing_reason_code = $4,
         processed_at = $5, accepted_at = $6 WHERE id = $1 RETURNING ${EVENT_COLUMNS}`,
      [input.eventId, input.fundingIntentId, input.status, input.reasonCode,
        input.processedAt, input.acceptedAt],
    )
    if (!result.rows[0]) throw new Error('Crypto provider event was not found')
    return mapEvent(result.rows[0])
  }

  async createReconciliation(input: Parameters<CryptoFundingRepository['createReconciliation']>[0], executor: QueryExecutor): Promise<void> {
    await executor.query(
      `INSERT INTO crypto_funding_reconciliations
        (id, funding_intent_id, provider_event_id, discrepancy_type,
         expected_asset, actual_asset, expected_amount, actual_amount,
         correlation_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [input.id, input.fundingIntentId, input.providerEventRecordId, input.type,
        input.expectedAsset, input.actualAsset, input.expectedAmount, input.actualAmount,
        input.correlationId, input.createdAt],
    )
  }

  async createFundingAttestation(input: Parameters<CryptoFundingRepository['createFundingAttestation']>[0], executor: QueryExecutor): Promise<boolean> {
    if (!input.intent.providerReference) throw new Error('Confirmed funding requires a provider reference')
    const { attestation } = input
    const result = await executor.query(
      `INSERT INTO financial_funding_instructions
        (id, funding_intent_id, player_id, asset, external_amount, provider,
         provider_reference, confirmed_at, created_at, schema_version, event_type,
         confirmation_event_id, provider_confirmation_event_id, external_atomic_units,
         external_scale, eligibility_decision_id, eligibility_policy_version,
         eligibility_evaluated_at, issued_at, automatic_processing_until,
         correlation_id, causation_id, payload_hash, attestation_payload,
         next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24::jsonb,$19)
       ON CONFLICT (funding_intent_id) DO NOTHING RETURNING id`,
      [attestation.fundingAttestationId, input.intent.id, input.intent.playerId, input.intent.asset,
        input.intent.requestedAmount, input.intent.provider, input.intent.providerReference,
        new Date(attestation.confirmedAt), input.createdAt, attestation.schemaVersion,
        attestation.eventType, input.confirmationEventRecordId,
        attestation.provider.confirmationEventId, attestation.externalPayment.atomicUnits,
        attestation.externalPayment.scale, attestation.purchaseEligibility.decisionId,
        attestation.purchaseEligibility.policyVersion,
        new Date(attestation.purchaseEligibility.evaluatedAt), new Date(attestation.issuedAt),
        new Date(attestation.automaticProcessingUntil), attestation.correlationId,
        attestation.causationId, input.payloadHash, JSON.stringify(attestation)],
    )
    if (!result.rows[0]) return false
    const evidencePayload = {
      schemaVersion: 1,
      eventId: attestation.fundingAttestationId,
      eventType: 'api.external_funding_confirmed.v1',
      sourceService: 'nines-api',
      environment: attestation.environment,
      fundingAttestationId: attestation.fundingAttestationId,
      occurredAt: attestation.issuedAt,
      correlationId: attestation.correlationId,
      causationId: attestation.causationId,
      attestation,
    }
    await executor.query(
      `INSERT INTO security_evidence_outbox
        (id, source_event_id, event_type, funding_attestation_id, payload,
         payload_hash, created_at, next_attempt_at)
       VALUES ($1,$1,$2,$3,$4::jsonb,$5,$6,$6)`,
      [attestation.fundingAttestationId, evidencePayload.eventType,
        attestation.fundingAttestationId, JSON.stringify(evidencePayload),
        hashCanonicalJson(evidencePayload as never), input.createdAt],
    )
    return true
  }
}

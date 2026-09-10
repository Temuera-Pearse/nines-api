import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

import type { CanonicalJson } from '../../shared/contracts/canonicalJson.js'
import { hashCanonicalJson } from '../../shared/contracts/canonicalJson.js'
import type { AppLogger } from '../../shared/observability/logger.js'
import { HmacServiceAuthenticator } from '../../shared/security/ServiceMessageAuthentication.js'

interface DeliveryRow extends QueryResultRow {
  id: string
  attestation_payload: CanonicalJson | null
  attempt_count: number
  lease_token: string
}
type ActiveDeliveryRow = DeliveryRow & { attestation_payload: CanonicalJson }

interface FinancialResponse {
  fundingAttestationId: string
  outcome: 'accepted' | 'duplicate' | 'review_required'
  financialConsumptionId: string
  ledgerTransactionId: string | null
}

const PATH = '/internal/v1/funding-attestations'

export class FundingAttestationDeliveryWorker {
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private readonly authenticator: HmacServiceAuthenticator

  constructor(private readonly pool: Pool, private readonly baseUrl: string,
    environment: string, secret: string, keyId: string, private readonly logger: AppLogger,
    private readonly pollIntervalMs = 1000, private readonly fetcher: typeof fetch = fetch) {
    this.authenticator = new HmacServiceAuthenticator({ serviceId: 'nines-api', keyId,
      secret, environment })
  }

  start(): void {
    if (this.timer) return
    this.runOnce()
    this.timer = setInterval(() => this.runOnce(), this.pollIntervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.inFlight
  }

  private runOnce(): void {
    if (this.inFlight) return
    this.inFlight = this.deliverOne().catch((error: unknown) =>
      this.logger.error({ event: 'funding_attestation_delivery_failed', err: error }))
      .finally(() => { this.inFlight = null })
  }

  private async claim(): Promise<DeliveryRow | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const leaseToken = randomUUID()
      const result = await client.query<DeliveryRow>(`WITH candidate AS (
        SELECT id FROM financial_funding_instructions
        WHERE schema_version=1 AND attestation_payload IS NOT NULL AND (
          (delivery_status IN ('pending','retry_wait') AND COALESCE(next_attempt_at, NOW()) <= NOW())
           OR (delivery_status = 'leased' AND lease_expires_at <= NOW()))
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE financial_funding_instructions f SET delivery_status='leased',
        attempt_count=f.attempt_count+1, lease_expires_at=NOW()+INTERVAL '60 seconds',lease_token=$1
      FROM candidate WHERE f.id=candidate.id
      RETURNING f.id,f.attestation_payload,f.attempt_count,f.lease_token`, [leaseToken])
      await client.query('COMMIT')
      return result.rows[0] ?? null
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async deliverOne(): Promise<void> {
    await this.quarantineLegacyRows()
    const row = await this.claim()
    if (!row) return
    if (row.attestation_payload === null) {
      await this.quarantineClaimedLegacyRow(row)
      return
    }
    const activeRow: ActiveDeliveryRow = { ...row, attestation_payload: row.attestation_payload }
    const startedAt = new Date()
    const headers = this.authenticator.sign('POST', PATH, activeRow.attestation_payload)
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}${PATH}`, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(activeRow.attestation_payload), signal: AbortSignal.timeout(10_000) })
    } catch (error) {
      await this.recordFailure(activeRow, headers['x-nines-request-id'], startedAt, null,
        'NETWORK_ERROR', error instanceof Error ? error.message : 'network failure')
      return
    }
    const text = await response.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { /* handled as invalid response */ }
    if ((response.status === 200 || response.status === 201) && this.isResponse(body, activeRow.id)) {
      await this.recordSuccess(activeRow, headers['x-nines-request-id'], startedAt, response.status, body)
      return
    }
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    await this.recordFailure(activeRow, headers['x-nines-request-id'], startedAt, response.status,
      retryable ? 'FINANCIAL_RETRYABLE_RESPONSE' : 'FINANCIAL_PERMANENT_RESPONSE', text.slice(0, 500))
  }

  private isResponse(value: unknown, id: string): value is FinancialResponse {
    if (!value || typeof value !== 'object') return false
    const item = value as Partial<FinancialResponse>
    return item.fundingAttestationId === id && ['accepted','duplicate','review_required'].includes(item.outcome ?? '') &&
      typeof item.financialConsumptionId === 'string' &&
      (typeof item.ledgerTransactionId === 'string' || item.ledgerTransactionId === null)
  }

  private async recordSuccess(row: ActiveDeliveryRow, requestId: string, startedAt: Date,
    status: number, body: FinancialResponse): Promise<void> {
    const client = await this.pool.connect()
    try { await client.query('BEGIN')
      const reviewRequired = body.outcome === 'review_required' ||
        (body.outcome === 'duplicate' && body.ledgerTransactionId === null)
      const claimed = await client.query(`UPDATE financial_funding_instructions SET delivery_status=$3,
        delivered_at=NOW(),lease_expires_at=NULL,lease_token=NULL,financial_consumption_id=$4,
        ledger_transaction_id=$5,last_error_code=NULL
        WHERE id=$1 AND lease_token=$2 AND delivery_status='leased' RETURNING id`,
      [row.id, row.lease_token, reviewRequired ? 'review_required' : 'acknowledged',
        body.financialConsumptionId, body.ledgerTransactionId])
      if (!claimed.rowCount) { await client.query('ROLLBACK'); return }
      await this.insertAttempt(client, row, requestId, startedAt,
        reviewRequired ? 'review_required' : 'acknowledged', status, null,
        hashCanonicalJson(body as unknown as CanonicalJson))
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async recordFailure(row: ActiveDeliveryRow, requestId: string, startedAt: Date,
    status: number | null, code: string, detail: string): Promise<void> {
    const permanent = code === 'FINANCIAL_PERMANENT_RESPONSE' || row.attempt_count >= 12
    const client = await this.pool.connect()
    try { await client.query('BEGIN')
      const claimed = await client.query(`UPDATE financial_funding_instructions SET delivery_status=$3,
        lease_expires_at=NULL,lease_token=NULL,next_attempt_at=NOW()+($4::text||' seconds')::interval,
        last_error_code=$5 WHERE id=$1 AND lease_token=$2 AND delivery_status='leased' RETURNING id`,
      [row.id, row.lease_token, permanent ? 'dead_letter' : 'retry_wait',
        Math.min(3600, 2 ** Math.min(row.attempt_count, 11)), code])
      if (!claimed.rowCount) { await client.query('ROLLBACK'); return }
      await this.insertAttempt(client, row, requestId, startedAt,
        permanent ? 'permanent_failure' : 'retryable_failure', status, code, null)
      if (permanent) {
        const payload: CanonicalJson = { schemaVersion: 1, eventId: randomUUID(),
          eventType: 'api.funding_delivery_failed.v1', sourceService: 'nines-api',
          environment: String((row.attestation_payload as Record<string, CanonicalJson>).environment),
          fundingAttestationId: row.id, occurredAt: new Date().toISOString(), errorCode: code,
          correlationId: String((row.attestation_payload as Record<string, CanonicalJson>).correlationId),
          causationId: String((row.attestation_payload as Record<string, CanonicalJson>).causationId) }
        await client.query(`INSERT INTO security_evidence_outbox
          (id,source_event_id,event_type,funding_attestation_id,payload,payload_hash,created_at,next_attempt_at)
          VALUES ($1,$1,$2,$3,$4::jsonb,$5,NOW(),NOW()) ON CONFLICT DO NOTHING`,
        [payload.eventId, payload.eventType, row.id, JSON.stringify(payload), hashCanonicalJson(payload)])
      }
      await client.query('COMMIT')
      this.logger.warn({ event: 'funding_attestation_delivery_attempt_failed',
        fundingAttestationId: row.id, attempt: row.attempt_count, code, detail })
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async insertAttempt(client: PoolClient, row: DeliveryRow, requestId: string,
    startedAt: Date, outcome: string, status: number | null, code: string | null,
    responseHash: string | null): Promise<void> {
    await client.query(`INSERT INTO financial_funding_delivery_attempts
      (id,funding_attestation_id,request_id,attempt_number,outcome,response_status,
       error_code,response_payload_hash,started_at,completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [randomUUID(), row.id, requestId, row.attempt_count, outcome, status, code,
      responseHash, startedAt])
  }

  private async quarantineLegacyRows(): Promise<void> {
    await this.pool.query(`UPDATE financial_funding_instructions SET
      delivery_status='legacy_reconciliation_required',next_attempt_at=NULL,
      lease_expires_at=NULL,lease_token=NULL,last_error_code='LEGACY_ATTESTATION_RECONCILIATION_REQUIRED'
      WHERE schema_version IS NULL AND delivery_status IN ('pending','retry_wait','leased')`)
  }

  private async quarantineClaimedLegacyRow(row: DeliveryRow): Promise<void> {
    await this.pool.query(`UPDATE financial_funding_instructions SET
      delivery_status='legacy_reconciliation_required',next_attempt_at=NULL,
      lease_expires_at=NULL,lease_token=NULL,last_error_code='LEGACY_ATTESTATION_RECONCILIATION_REQUIRED'
      WHERE id=$1 AND lease_token=$2 AND delivery_status='leased'`, [row.id, row.lease_token])
  }
}

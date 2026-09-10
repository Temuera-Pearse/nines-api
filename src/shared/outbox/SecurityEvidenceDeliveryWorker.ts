import { randomUUID } from 'node:crypto'
import type { Pool, QueryResultRow } from 'pg'

import type { CanonicalJson } from '../contracts/canonicalJson.js'
import type { AppLogger } from '../observability/logger.js'
import { HmacServiceAuthenticator } from '../security/ServiceMessageAuthentication.js'

interface EvidenceRow extends QueryResultRow { id: string; payload: CanonicalJson; attempt_count: number; lease_token: string }
const PATH = '/internal/v1/evidence'

export class SecurityEvidenceDeliveryWorker {
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private readonly authenticator: HmacServiceAuthenticator

  constructor(private readonly pool: Pool, private readonly baseUrl: string,
    environment: string, secret: string, keyId: string, private readonly logger: AppLogger,
    private readonly pollIntervalMs = 1000, private readonly fetcher: typeof fetch = fetch) {
    this.authenticator = new HmacServiceAuthenticator({ serviceId: 'nines-api', keyId, secret, environment })
  }
  start(): void { if (this.timer) return; this.runOnce(); this.timer = setInterval(() => this.runOnce(), this.pollIntervalMs); this.timer.unref() }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await this.inFlight }
  private runOnce(): void { if (this.inFlight) return; this.inFlight = this.deliverOne()
    .catch((err: unknown) => this.logger.error({ event: 'security_evidence_delivery_failed', err }))
    .finally(() => { this.inFlight = null }) }
  private async deliverOne(): Promise<void> {
    const leaseToken = randomUUID()
    const claimed = await this.pool.query<EvidenceRow>(`UPDATE security_evidence_outbox SET
      attempt_count=attempt_count+1,next_attempt_at=NOW()+INTERVAL '60 seconds',lease_token=$1
      WHERE id=(SELECT id FROM security_evidence_outbox WHERE delivery_status IN ('pending','retry_wait')
        AND COALESCE(next_attempt_at,NOW())<=NOW() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,payload,attempt_count,lease_token`, [leaseToken])
    const row = claimed.rows[0]
    if (!row) return
    const headers = this.authenticator.sign('POST', PATH, row.payload)
    try {
      const response = await this.fetcher(`${this.baseUrl}${PATH}`, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(10_000) })
      if (response.status === 200 || response.status === 201) {
        await this.pool.query(`UPDATE security_evidence_outbox SET delivery_status='delivered',
          delivered_at=NOW(),lease_token=NULL WHERE id=$1 AND lease_token=$2
          AND delivery_status IN ('pending','retry_wait')`, [row.id, row.lease_token]); return
      }
      await this.retry(row, response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)
    } catch { await this.retry(row, false) }
  }
  private async retry(row: EvidenceRow, permanent: boolean): Promise<void> {
    const dead = permanent || row.attempt_count >= 12
    await this.pool.query(`UPDATE security_evidence_outbox SET delivery_status=$2,
      next_attempt_at=NOW()+($3::text||' seconds')::interval,lease_token=NULL
      WHERE id=$1 AND lease_token=$4 AND delivery_status IN ('pending','retry_wait')`,
    [row.id, dead ? 'dead_letter' : 'retry_wait', Math.min(3600, 2 ** Math.min(row.attempt_count, 11)),
      row.lease_token])
  }
}

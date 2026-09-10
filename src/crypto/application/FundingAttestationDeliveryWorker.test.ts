import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

import { FundingAttestationDeliveryWorker } from './FundingAttestationDeliveryWorker.js'
import { SecurityEvidenceDeliveryWorker } from '../../shared/outbox/SecurityEvidenceDeliveryWorker.js'

const logger = { error() {}, warn() {} } as never

describe('delivery lease ownership', () => {
  it('does not let a stale Financial-delivery worker regress an acknowledged attestation', async () => {
    const state = { status: 'pending', token: '' }
    const payload = { environment: 'test', correlationId: 'corr', causationId: 'cause' }
    const client = { release() {}, async query(sql: string, parameters: unknown[] = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: null }
      if (sql.includes('WITH candidate AS')) {
        state.status = 'leased'; state.token = String(parameters[0])
        return { rows: [{ id: 'a2c24b8d-57f7-4e54-a8c5-b3b4e817a478',
          attestation_payload: payload, attempt_count: 1, lease_token: state.token }], rowCount: 1 }
      }
      if (sql.includes("WHERE id=$1 AND lease_token=$2 AND delivery_status='leased'")) {
        const owned = state.status === 'leased' && state.token === parameters[1]
        if (owned) state.status = String(parameters[2])
        return { rows: owned ? [{ id: parameters[0] }] : [], rowCount: owned ? 1 : 0 }
      }
      throw new Error(`Unexpected client query: ${sql}`)
    } }
    const pool = { async query(sql: string) {
      if (sql.includes('legacy_reconciliation_required')) return { rows: [], rowCount: 0 }
      throw new Error(`Unexpected pool query: ${sql}`)
    }, async connect() { return client } } as unknown as Pool
    const fetcher = async () => {
      state.status = 'acknowledged'; state.token = 'newer-lease-token'
      return new Response('temporary', { status: 500 })
    }
    const worker = new FundingAttestationDeliveryWorker(pool, 'http://financial.test', 'test',
      'worker-lease-test-secret-at-least-32', 'test-key', logger, 1000, fetcher)
    await (worker as unknown as { deliverOne(): Promise<void> }).deliverOne()
    expect(state).toEqual({ status: 'acknowledged', token: 'newer-lease-token' })
  })

  it('does not let a stale Security-delivery worker regress delivered evidence', async () => {
    const state = { status: 'pending', token: '' }
    const pool = { async query(sql: string, parameters: unknown[] = []) {
      if (sql.includes('RETURNING id,payload,attempt_count,lease_token')) {
        state.token = String(parameters[0])
        return { rows: [{ id: 'd637056e-795e-4287-9809-c2354cb9f5d4', payload: { event: 'e' },
          attempt_count: 1, lease_token: state.token }], rowCount: 1 }
      }
      if (sql.includes('WHERE id=$1 AND lease_token=$4')) {
        const owned = state.token === parameters[3] && state.status !== 'delivered'
        if (owned) state.status = String(parameters[1])
        return { rows: [], rowCount: owned ? 1 : 0 }
      }
      throw new Error(`Unexpected query: ${sql}`)
    } } as unknown as Pool
    const fetcher = async () => {
      state.status = 'delivered'; state.token = 'newer-security-lease'
      return new Response('temporary', { status: 500 })
    }
    const worker = new SecurityEvidenceDeliveryWorker(pool, 'http://security.test', 'test',
      'worker-lease-test-secret-at-least-32', 'test-key', logger, 1000, fetcher)
    await (worker as unknown as { deliverOne(): Promise<void> }).deliverOne()
    expect(state).toEqual({ status: 'delivered', token: 'newer-security-lease' })
  })
})

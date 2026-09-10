import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { FundingAttestationDeliveryWorker } from '../src/crypto/application/FundingAttestationDeliveryWorker.js'
import { createTestPool, resetTestDatabase } from './support/database.js'

describe('migration 006 legacy funding upgrade', () => {
  let pool: Pool
  beforeAll(async () => { pool = createTestPool() })
  afterAll(async () => { await pool.end() })

  it('quarantines a pre-attestation pending row without delivery or retry', async () => {
    await resetTestDatabase(pool)
    const migrations = path.resolve(process.cwd(), 'db/migrations')
    for (const name of [
      '001_phase_1_player_identity.sql', '002_phase_2_eligibility.sql',
      '003_phase_3_kyc.sql', '004_phase_3_5_kyc_lifecycle_hardening.sql',
      '005_phase_4_crypto_funding.sql',
    ]) await pool.query(await readFile(path.join(migrations, name), 'utf8'))

    const playerId=randomUUID(); const intentId=randomUUID(); const attestationId=randomUUID()
    const now=new Date('2026-08-10T10:00:00.000Z')
    await pool.query(`INSERT INTO players(id,account_status) VALUES ($1,'active')`,[playerId])
    await pool.query('BEGIN')
    await pool.query(`INSERT INTO crypto_funding_intents
      (id,player_id,asset,requested_amount,status,provider,idempotency_key,request_hash,
       provider_reference,expires_at,confirmed_at,version,created_at,updated_at)
      VALUES ($1,$2,'USDC','1','confirmed','fake','legacy-key',$3,'legacy-payment',$4,$5,2,$5,$5)`,
    [intentId,playerId,'a'.repeat(64),new Date(now.getTime()+3600000),now])
    await pool.query(`INSERT INTO financial_funding_instructions
      (id,funding_intent_id,player_id,asset,external_amount,provider,provider_reference,
       confirmed_at,delivery_status,created_at)
      VALUES ($1,$2,$3,'USDC','1','fake','legacy-payment',$4,'pending',$4)`,
    [attestationId,intentId,playerId,now])
    await pool.query('COMMIT')

    await pool.query(await readFile(path.join(migrations,
      '006_confirmed_funding_attestations.sql'),'utf8'))
    const migrated=await pool.query(`SELECT delivery_status,last_error_code,attestation_payload,
      attempt_count,next_attempt_at FROM financial_funding_instructions WHERE id=$1`,[attestationId])
    expect(migrated.rows[0]).toMatchObject({
      delivery_status:'legacy_reconciliation_required',
      last_error_code:'LEGACY_ATTESTATION_RECONCILIATION_REQUIRED',
      attestation_payload:null,attempt_count:0,next_attempt_at:null,
    })

    const fetcher=vi.fn<typeof fetch>()
    const logger={error:vi.fn(),warn:vi.fn()} as never
    const worker=new FundingAttestationDeliveryWorker(pool,'http://financial.test','test',
      'legacy-upgrade-test-secret-at-least-32','test-key',logger,1000,fetcher)
    await (worker as unknown as {deliverOne():Promise<void>}).deliverOne()
    expect(fetcher).not.toHaveBeenCalled()
    const after=await pool.query(`SELECT delivery_status,attempt_count,last_error_code
      FROM financial_funding_instructions WHERE id=$1`,[attestationId])
    expect(after.rows[0]).toMatchObject({delivery_status:'legacy_reconciliation_required',
      attempt_count:0,last_error_code:'LEGACY_ATTESTATION_RECONCILIATION_REQUIRED'})
  })
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { canonicalizeJson, hashCanonicalJson } from '../contracts/canonicalJson.js'
import { HmacServiceAuthenticator, verifyHmacSignature } from './ServiceMessageAuthentication.js'

describe('service message authentication and canonical contract hashing', () => {
  it('locks the shared attestation schema fixture', () => {
    const fixture = readFileSync('contracts/confirmed-funding-attestation-v1.schema.json')
    expect(createHash('sha256').update(fixture).digest('hex'))
      .toBe('e9e46c6f68ba73314ee8eef0f0b9eead1ec3c6b3caebe5afcd2a5d8d7c3278e1')
  })
  it('hashes equivalent JSON objects identically', () => {
    expect(hashCanonicalJson({ z: 1, nested: { b: true, a: null } }))
      .toBe(hashCanonicalJson({ nested: { a: null, b: true }, z: 1 }))
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('signs the complete request tuple and rejects path tampering', () => {
    const secret = 'api-service-authentication-test-secret-32+'
    const authenticator = new HmacServiceAuthenticator({ serviceId: 'nines-api',
      keyId: 'test', secret, environment: 'test',
      clock: () => new Date('2026-09-01T00:00:00.000Z'),
      createRequestId: () => '5f2656bb-30a3-42d7-a960-6180fecd1a0d' })
    const body = { fundingAttestationId: '20d77989-0923-4474-ad36-831b7693bc82' }
    const headers = authenticator.sign('POST', '/internal/v1/funding-attestations', body)
    const common = { method: 'POST', environment: 'test', serviceId: 'nines-api', keyId: 'test',
      requestId: headers['x-nines-request-id'],
      sentAt: headers['x-nines-sent-at'], contentHash: headers['x-nines-content-sha256'],
      signature: headers['x-nines-signature'], secret }
    expect(verifyHmacSignature({ ...common, path: '/internal/v1/funding-attestations' })).toBe(true)
    expect(verifyHmacSignature({ ...common, path: '/internal/v1/evidence' })).toBe(false)
    expect(verifyHmacSignature({ ...common, path: '/internal/v1/funding-attestations', keyId: 'other' })).toBe(false)
  })
})

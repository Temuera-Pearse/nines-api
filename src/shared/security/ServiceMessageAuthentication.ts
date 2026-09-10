import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { CanonicalJson } from '../contracts/canonicalJson.js'
import { hashCanonicalJson } from '../contracts/canonicalJson.js'

export interface ServiceAuthHeaders {
  'x-nines-service-id': string
  'x-nines-key-id': string
  'x-nines-request-id': string
  'x-nines-sent-at': string
  'x-nines-content-sha256': string
  'x-nines-signature': string
}

export interface HmacServiceAuthenticatorOptions {
  serviceId: string
  keyId: string
  secret: string
  environment: string
  clock?: () => Date
  createRequestId?: () => string
}

function signingInput(method: string, path: string, environment: string, serviceId: string,
  keyId: string, requestId: string,
  sentAt: string, contentHash: string): string {
  return ['NINES-HTTP-SIGNATURE-V1', method.toUpperCase(), path, environment,
    serviceId, keyId, requestId, sentAt, contentHash].join('\n')
}

export class HmacServiceAuthenticator {
  private readonly clock: () => Date
  private readonly createRequestId: () => string

  constructor(private readonly options: HmacServiceAuthenticatorOptions) {
    if (options.secret.length < 32) throw new Error('Service authentication secret must contain at least 32 characters')
    this.clock = options.clock ?? (() => new Date())
    this.createRequestId = options.createRequestId ?? randomUUID
  }

  sign(method: string, path: string, body: CanonicalJson): ServiceAuthHeaders {
    const requestId = this.createRequestId()
    const sentAt = this.clock().toISOString()
    const contentHash = hashCanonicalJson(body)
    const signature = createHmac('sha256', this.options.secret)
      .update(signingInput(method, path, this.options.environment, this.options.serviceId,
        this.options.keyId, requestId, sentAt, contentHash))
      .digest('hex')
    return {
      'x-nines-service-id': this.options.serviceId,
      'x-nines-key-id': this.options.keyId,
      'x-nines-request-id': requestId,
      'x-nines-sent-at': sentAt,
      'x-nines-content-sha256': contentHash,
      'x-nines-signature': signature,
    }
  }
}

export function verifyHmacSignature(input: {
  method: string
  path: string
  environment: string
  serviceId: string
  keyId: string
  requestId: string
  sentAt: string
  contentHash: string
  signature: string
  secret: string
}): boolean {
  const expected = createHmac('sha256', input.secret)
    .update(signingInput(input.method, input.path, input.environment, input.serviceId,
      input.keyId, input.requestId,
      input.sentAt, input.contentHash))
    .digest()
  let actual: Buffer
  try { actual = Buffer.from(input.signature, 'hex') } catch { return false }
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

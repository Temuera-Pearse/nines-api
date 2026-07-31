import { describe, expect, it } from 'vitest'
import { sanitizeAuditMetadata } from './metadata.js'

describe('audit metadata sanitization', () => {
  it('redacts secrets recursively and preserves safe fields', () => {
    expect(
      sanitizeAuditMetadata({
        provider: 'auth0',
        authorization: 'Bearer raw-token',
        nested: { password: 'secret', result: 'ok' },
      }),
    ).toEqual({
      provider: 'auth0',
      authorization: '[REDACTED]',
      nested: { password: '[REDACTED]', result: 'ok' },
    })
  })
})

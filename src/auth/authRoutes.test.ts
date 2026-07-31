import crypto from 'node:crypto'
import type { NextFunction, Response } from 'express'
import {
  createLocalJWKSet,
  exportJWK,
  SignJWT,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { createSilentLogger } from '../shared/observability/logger.js'
import { AuthError } from './AuthError.js'
import {
  createAuth0JwtVerifier,
  requireAuth0Identity,
  type AuthenticatedRequest,
} from './auth0Jwt.js'

const issuer = 'https://tenant.example.auth0.com/'
const audience = 'https://nines-api.example'
let privateKey: crypto.KeyObject
let otherPrivateKey: crypto.KeyObject
let jwks: { keys: JWK[] }

beforeAll(async () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const otherPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  privateKey = pair.privateKey
  otherPrivateKey = otherPair.privateKey
  jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }],
  }
})

interface TokenOptions {
  issuer?: string
  audience?: string
  subject?: string | null
  expiration?: string | null
  notBefore?: string
  kid?: string
  key?: crypto.KeyObject
}

async function signToken(payload: JWTPayload = {}, options: TokenOptions = {}) {
  let jwt = new SignJWT({
    email: 'player@example.com',
    email_verified: true,
    name: 'Player One',
    ...payload,
  })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'test-key' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setIssuedAt()

  if (options.subject !== null) jwt = jwt.setSubject(options.subject ?? 'auth0|player-1')
  if (options.expiration !== null) jwt = jwt.setExpirationTime(options.expiration ?? '5m')
  if (options.notBefore) jwt = jwt.setNotBefore(options.notBefore)
  return jwt.sign(options.key ?? privateKey)
}

function verifier(keyResolver: JWTVerifyGetKey = createLocalJWKSet(jwks)) {
  return createAuth0JwtVerifier({ issuer, audience, keyResolver })
}

async function expectAuthCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: 'AuthError', code })
}

describe('Auth0 player-token verifier', () => {
  it('accepts a valid human player token and returns only normalized identity', async () => {
    await expect(verifier()(await signToken())).resolves.toEqual({
      provider: 'auth0',
      issuer,
      subject: 'auth0|player-1',
      email: 'player@example.com',
      emailVerified: true,
      displayName: 'Player One',
      tokenType: 'human',
    })
  })

  it('rejects a malformed JWT', async () => {
    await expectAuthCode(verifier()('not-a-jwt'), 'AUTH_TOKEN_INVALID')
  })

  it('rejects an encrypted JWE', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url')
    await expectAuthCode(verifier()(`${header}..iv.ciphertext.tag`), 'AUTH_TOKEN_INVALID')
  })

  it('rejects HS256 before key resolution', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
    await expectAuthCode(verifier()(`${header}.payload.signature`), 'AUTH_TOKEN_INVALID')
  })

  it('rejects a wrong RSA signature', async () => {
    await expectAuthCode(
      verifier()(await signToken({}, { key: otherPrivateKey })),
      'AUTH_TOKEN_INVALID',
    )
  })

  it('rejects the wrong issuer', async () => {
    await expectAuthCode(
      verifier()(await signToken({}, { issuer: 'https://wrong.example/' })),
      'AUTH_TOKEN_INVALID',
    )
  })

  it('rejects the wrong audience', async () => {
    await expectAuthCode(
      verifier()(await signToken({}, { audience: 'https://wrong-audience.example' })),
      'AUTH_TOKEN_INVALID',
    )
  })

  it('requires sub', async () => {
    await expectAuthCode(verifier()(await signToken({}, { subject: null })), 'AUTH_TOKEN_INVALID')
  })

  it('requires exp', async () => {
    await expectAuthCode(verifier()(await signToken({}, { expiration: null })), 'AUTH_TOKEN_INVALID')
  })

  it('rejects expired tokens', async () => {
    await expectAuthCode(
      verifier()(await signToken({}, { expiration: '-1m' })),
      'AUTH_TOKEN_EXPIRED',
    )
  })

  it('rejects tokens with a future nbf', async () => {
    await expectAuthCode(
      verifier()(await signToken({}, { notBefore: '5m' })),
      'AUTH_TOKEN_NOT_ACTIVE',
    )
  })

  it.each([
    [{ gty: 'client-credentials' }, 'auth0|machine'],
    [{}, 'client-id@clients'],
  ])('rejects unsuitable machine tokens', async (payload, subject) => {
    await expectAuthCode(
      verifier()(await signToken(payload, { subject })),
      'AUTH_PLAYER_TOKEN_REQUIRED',
    )
  })

  it('rejects an unknown kid', async () => {
    await expectAuthCode(
      verifier()(await signToken({}, { kid: 'unknown-key' })),
      'AUTH_TOKEN_INVALID',
    )
  })

  it('maps failed key resolution to dependency unavailability', async () => {
    const failedResolver: JWTVerifyGetKey = async () => {
      throw new Error('JWKS unavailable')
    }
    await expectAuthCode(
      verifier(failedResolver)(await signToken()),
      'AUTH_KEYS_UNAVAILABLE',
    )
  })
})

describe('authorization header policy', () => {
  async function run(authorization?: string) {
    const request = {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? authorization : undefined,
    } as AuthenticatedRequest
    let capturedError: unknown
    const next: NextFunction = (error?: unknown) => {
      capturedError = error
    }
    await requireAuth0Identity(verifier(), createSilentLogger())(
      request,
      {} as Response,
      next,
    )
    return { request, capturedError }
  }

  it('rejects a missing authorization header', async () => {
    const { capturedError } = await run()
    expect(capturedError).toMatchObject({ code: 'AUTH_HEADER_MISSING' })
  })

  it.each(['Basic abc', 'Bearer', 'Bearer token with spaces']) (
    'rejects malformed authorization header %s',
    async (header) => {
      const { capturedError } = await run(header)
      expect(capturedError).toMatchObject({ code: 'AUTH_HEADER_MALFORMED' })
    },
  )

  it('attaches normalized identity for a valid header', async () => {
    const token = await signToken()
    const { request, capturedError } = await run(`Bearer ${token}`)
    expect(capturedError).toBeUndefined()
    expect(request.identity?.subject).toBe('auth0|player-1')
  })
})

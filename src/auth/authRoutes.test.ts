import crypto from 'node:crypto'
import type { NextFunction, Response } from 'express'
import {
  createLocalJWKSet,
  exportJWK,
  SignJWT,
  type JWK,
  type JWTPayload,
} from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createAuth0JwtVerifier,
  requireAuth0Jwt,
  type AuthenticatedPlayer,
  type AuthenticatedRequest,
} from './auth0Jwt.js'

const issuer = 'https://nines-dev.au.auth0.com/'
const audience = 'https://api.nines.test'

let privateKey: crypto.KeyObject
let jwks: { keys: JWK[] }

beforeAll(async () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  privateKey = pair.privateKey
  const publicJwk = await exportJWK(pair.publicKey)
  jwks = {
    keys: [
      {
        ...publicJwk,
        kid: 'test-key',
        alg: 'RS256',
        use: 'sig',
      },
    ],
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeMiddleware() {
  const verifier = createAuth0JwtVerifier({
    issuer,
    audience,
    keyResolver: createLocalJWKSet(jwks),
  })

  return requireAuth0Jwt(verifier)
}

async function signToken(payload: JWTPayload = {}, expiresIn = '5m') {
  return new SignJWT({
    email: 'player@example.com',
    name: 'Player One',
    nickname: 'player-one',
    ...payload,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('auth0|player-1')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey)
}

function mockRequest(authorization?: string): AuthenticatedRequest {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? authorization : undefined,
  } as AuthenticatedRequest
}

function mockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }

  return response as Response & typeof response
}

async function runMiddleware(authorization?: string) {
  const req = mockRequest(authorization)
  const res = mockResponse()
  let nextCalled = false
  const next: NextFunction = () => {
    nextCalled = true
  }

  await makeMiddleware()(req, res, next)

  return {
    req,
    res,
    nextCalled,
    player: req.player as AuthenticatedPlayer | undefined,
  }
}

describe('auth middleware', () => {
  it('rejects requests without a bearer token', async () => {
    const { res, nextCalled } = await runMiddleware()

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({
      error: 'missing_bearer_token',
      message: 'Authorization header must be Bearer <token>',
    })
  })

  it('rejects requests with an invalid token', async () => {
    const { res, nextCalled } = await runMiddleware('Bearer not-a-jwt')

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({
      error: 'invalid_token',
      message: 'Bearer token is invalid',
    })
  })

  it('rejects encrypted Auth0 JWE tokens as unsupported without logging the token', async () => {
    const protectedHeader = Buffer.from(
      JSON.stringify({ alg: 'dir', enc: 'A256GCM' }),
    ).toString('base64url')
    const token = `${protectedHeader}..initialization-vector.ciphertext.authentication-tag`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { res, nextCalled } = await runMiddleware(`Bearer ${token}`)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({
      error: 'invalid_token',
      message: 'Bearer token is invalid',
    })
    expect(warn).toHaveBeenCalledWith(
      'Unsupported Auth0 bearer token format',
      {
        segmentCount: 5,
        alg: 'dir',
        enc: 'A256GCM',
      },
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token)
  })

  it('rejects signed tokens that do not use RS256', async () => {
    const protectedHeader = Buffer.from(
      JSON.stringify({ alg: 'HS256' }),
    ).toString('base64url')
    const token = `${protectedHeader}.payload.signature`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { res, nextCalled } = await runMiddleware(`Bearer ${token}`)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({
      error: 'invalid_token',
      message: 'Bearer token is invalid',
    })
    expect(warn).toHaveBeenCalledWith(
      'Unsupported Auth0 bearer token format',
      {
        segmentCount: 3,
        alg: 'HS256',
      },
    )
  })

  it('rejects requests with an expired token', async () => {
    const token = await signToken({}, '-5m')
    const { res, nextCalled } = await runMiddleware(`Bearer ${token}`)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({
      error: 'token_expired',
      message: 'Bearer token has expired',
    })
  })

  it('attaches the player identity for a valid Auth0 token', async () => {
    const token = await signToken()
    const { nextCalled, player } = await runMiddleware(`Bearer ${token}`)

    expect(nextCalled).toBe(true)
    expect(player).toMatchObject({
      userId: 'auth0|player-1',
      authProvider: 'auth0',
      email: 'player@example.com',
      displayName: 'Player One',
      roles: ['player'],
    })
  })
})

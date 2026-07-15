import type { NextFunction, Request, Response } from 'express'
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'

export interface AuthenticatedPlayer {
  userId: string
  authProvider: 'auth0'
  email?: string
  displayName: string
  roles: ['player']
  claims: JWTPayload
}

export interface AuthenticatedRequest extends Request {
  player?: AuthenticatedPlayer
}

export interface Auth0JwtConfig {
  issuer: string
  audience: string
}

export interface Auth0JwtVerifierOptions extends Auth0JwtConfig {
  keyResolver?: JWTVerifyGetKey
}

type VerifyBearerToken = (token: string) => Promise<AuthenticatedPlayer>

interface UnsupportedTokenFormat {
  segmentCount: number
  alg?: string
  enc?: string
}

function normalizeIssuer(rawIssuer: string): string {
  const issuer = rawIssuer.trim()
  return issuer.endsWith('/') ? issuer : `${issuer}/`
}

function getStringClaim(claims: JWTPayload, key: string): string | undefined {
  const value = claims[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization')
  if (!header) return null

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

function getUnsupportedTokenFormat(
  token: string,
): UnsupportedTokenFormat | null {
  const segmentCount = token.split('.').length

  if (segmentCount !== 3 && segmentCount !== 5) {
    return null
  }

  let header: ReturnType<typeof decodeProtectedHeader> | null = null
  try {
    header = decodeProtectedHeader(token)
  } catch {
    if (segmentCount === 5) {
      return { segmentCount }
    }
    return null
  }

  const alg = typeof header.alg === 'string' ? header.alg : undefined
  const enc = typeof header.enc === 'string' ? header.enc : undefined
  const isEncrypted = segmentCount === 5 || enc !== undefined

  if (isEncrypted || alg !== 'RS256') {
    return {
      segmentCount,
      ...(alg ? { alg } : {}),
      ...(enc ? { enc } : {}),
    }
  }

  return null
}

function logUnsupportedTokenFormat(format: UnsupportedTokenFormat): void {
  console.warn('Unsupported Auth0 bearer token format', format)
}

function unauthorized(
  res: Response,
  error: 'missing_bearer_token' | 'invalid_token' | 'token_expired',
  message: string,
) {
  return res.status(401).json({ error, message })
}

export function getAuth0JwtConfig(env: NodeJS.ProcessEnv): Auth0JwtConfig {
  const issuer = env.AUTH0_ISSUER?.trim()
  const audience = env.AUTH0_AUDIENCE?.trim()

  if (!issuer || !audience) {
    throw new Error('AUTH0_ISSUER and AUTH0_AUDIENCE are required')
  }

  return {
    issuer: normalizeIssuer(issuer),
    audience,
  }
}

export function createAuth0JwtVerifier({
  issuer,
  audience,
  keyResolver,
}: Auth0JwtVerifierOptions) {
  const normalizedIssuer = normalizeIssuer(issuer)
  const resolver =
    keyResolver ??
    createRemoteJWKSet(new URL('.well-known/jwks.json', normalizedIssuer))

  return async function verifyBearerToken(token: string): Promise<AuthenticatedPlayer> {
    const { payload } = await jwtVerify(token, resolver, {
      issuer: normalizedIssuer,
      audience,
      algorithms: ['RS256'],
    })

    if (!payload.sub) {
      throw new joseErrors.JWTClaimValidationFailed(
        'missing required subject claim',
        payload,
        'sub',
        'required',
      )
    }

    const email = getStringClaim(payload, 'email')
    const name = getStringClaim(payload, 'name')
    const nickname = getStringClaim(payload, 'nickname')
    const displayName = name ?? nickname ?? email ?? payload.sub

    return {
      userId: payload.sub,
      authProvider: 'auth0',
      email,
      displayName,
      roles: ['player'],
      claims: payload,
    }
  }
}

export function requireAuth0Jwt(
  verifyBearerToken?: VerifyBearerToken,
) {
  let verifier = verifyBearerToken

  return async function auth0JwtMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    const token = extractBearerToken(req)
    if (!token) {
      return unauthorized(
        res,
        'missing_bearer_token',
        'Authorization header must be Bearer <token>',
      )
    }

    const unsupportedFormat = getUnsupportedTokenFormat(token)
    if (unsupportedFormat) {
      logUnsupportedTokenFormat(unsupportedFormat)
      return unauthorized(res, 'invalid_token', 'Bearer token is invalid')
    }

    try {
      verifier ??= createAuth0JwtVerifier(getAuth0JwtConfig(process.env))
      req.player = await verifier(token)
      return next()
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        return unauthorized(res, 'token_expired', 'Bearer token has expired')
      }

      if (
        error instanceof Error &&
        error.message === 'AUTH0_ISSUER and AUTH0_AUDIENCE are required'
      ) {
        return res.status(500).json({
          error: 'auth_not_configured',
          message: error.message,
        })
      }

      return unauthorized(res, 'invalid_token', 'Bearer token is invalid')
    }
  }
}

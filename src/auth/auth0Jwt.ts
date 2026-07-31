import type { NextFunction, Request, Response } from 'express'
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import type { AppLogger } from '../shared/observability/logger.js'
import type { ContextRequest } from '../shared/http/requestContext.js'
import type { AuthenticatedIdentity } from './AuthenticatedIdentity.js'
import { AuthError } from './AuthError.js'

export interface AuthenticatedRequest extends ContextRequest {
  identity?: AuthenticatedIdentity
}

export interface Auth0JwtConfig {
  issuer: string
  audience: string
}

export interface Auth0JwtVerifierOptions extends Auth0JwtConfig {
  keyResolver?: JWTVerifyGetKey
}

export type VerifyBearerToken = (token: string) => Promise<AuthenticatedIdentity>

function normalizeIssuer(rawIssuer: string): string {
  const issuer = rawIssuer.trim()
  return issuer.endsWith('/') ? issuer : `${issuer}/`
}

function stringClaim(payload: JWTPayload, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function validateTokenStructure(token: string): void {
  const segmentCount = token.split('.').length
  if (segmentCount !== 3) throw new AuthError('AUTH_TOKEN_INVALID')

  try {
    const header = decodeProtectedHeader(token)
    if (header.enc !== undefined || header.alg !== 'RS256') {
      throw new AuthError('AUTH_TOKEN_INVALID')
    }
  } catch (error) {
    if (error instanceof AuthError) throw error
    throw new AuthError('AUTH_TOKEN_INVALID', { cause: error })
  }
}

function isMachineToMachineToken(payload: JWTPayload): boolean {
  const grantType = stringClaim(payload, 'gty')?.toLowerCase()
  return grantType === 'client-credentials' || Boolean(payload.sub?.endsWith('@clients'))
}

function mapVerificationError(error: unknown): AuthError {
  if (error instanceof AuthError) return error
  if (error instanceof joseErrors.JWTExpired) {
    return new AuthError('AUTH_TOKEN_EXPIRED', { cause: error })
  }
  if (
    error instanceof joseErrors.JWTClaimValidationFailed &&
    (error as joseErrors.JWTClaimValidationFailed & { claim?: string }).claim === 'nbf'
  ) {
    return new AuthError('AUTH_TOKEN_NOT_ACTIVE', { cause: error })
  }
  if (error instanceof joseErrors.JOSEError) {
    if (error.code === 'ERR_JWKS_TIMEOUT') {
      return new AuthError('AUTH_KEYS_UNAVAILABLE', { status: 503, cause: error })
    }
    return new AuthError('AUTH_TOKEN_INVALID', { cause: error })
  }
  return new AuthError('AUTH_KEYS_UNAVAILABLE', { status: 503, cause: error })
}

export function createAuth0JwtVerifier({
  issuer,
  audience,
  keyResolver,
}: Auth0JwtVerifierOptions): VerifyBearerToken {
  const normalizedIssuer = normalizeIssuer(issuer)
  const resolver =
    keyResolver ??
    createRemoteJWKSet(new URL('.well-known/jwks.json', normalizedIssuer), {
      timeoutDuration: 3_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    })

  return async (token: string): Promise<AuthenticatedIdentity> => {
    validateTokenStructure(token)
    try {
      const { payload } = await jwtVerify(token, resolver, {
        issuer: normalizedIssuer,
        audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp'],
      })

      if (isMachineToMachineToken(payload)) {
        throw new AuthError('AUTH_PLAYER_TOKEN_REQUIRED', { status: 403 })
      }

      const email = stringClaim(payload, 'email')
      const displayName =
        stringClaim(payload, 'name') ?? stringClaim(payload, 'nickname') ?? email
      const emailVerified =
        typeof payload.email_verified === 'boolean' ? payload.email_verified : null

      return {
        provider: 'auth0',
        issuer: normalizedIssuer,
        subject: payload.sub!,
        email,
        emailVerified,
        displayName,
        tokenType: 'human',
      }
    } catch (error) {
      throw mapVerificationError(error)
    }
  }
}

function bearerToken(request: Request): string {
  const header = request.header('authorization')
  if (!header) throw new AuthError('AUTH_HEADER_MISSING')
  const match = /^Bearer ([^\s]+)$/.exec(header.trim())
  if (!match?.[1]) throw new AuthError('AUTH_HEADER_MALFORMED')
  return match[1]
}

export function requireAuth0Identity(
  verifyBearerToken: VerifyBearerToken,
  logger: AppLogger,
) {
  return async function auth0JwtMiddleware(
    request: AuthenticatedRequest,
    _response: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      request.identity = await verifyBearerToken(bearerToken(request))
      next()
    } catch (error) {
      const authError = error instanceof AuthError ? error : mapVerificationError(error)
      logger.warn({
        event: 'authentication_failed',
        category: authError.code,
        correlationId: request.context?.correlationId,
      })
      next(authError)
    }
  }
}

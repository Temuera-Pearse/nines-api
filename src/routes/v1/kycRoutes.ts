import { Router, type RequestHandler } from 'express'
import type { AuthenticatedRequest } from '../../auth/auth0Jwt.js'
import type { GetKycProfileService } from '../../kyc/application/GetKycProfileService.js'
import type { StartKycVerificationService } from '../../kyc/application/StartKycVerificationService.js'
import type { ResolveOrCreatePlayerService } from '../../players/application/ResolveOrCreatePlayerService.js'
import { AppError } from '../../shared/http/AppError.js'
import { requireRequestContext } from '../../shared/http/requestContext.js'

const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface KycRouteDependencies {
  requireIdentity: RequestHandler
  resolvePlayer: ResolveOrCreatePlayerService
  getKycProfile: GetKycProfileService
  startKycVerification: StartKycVerificationService
}

function requireIdentity(request: AuthenticatedRequest) {
  if (!request.identity) {
    throw new AppError({
      status: 500,
      code: 'AUTH_CONTEXT_MISSING',
      message: 'Authenticated identity was not attached',
      publicMessage: 'An unexpected error occurred',
    })
  }
  return request.identity
}

function idempotencyKey(request: AuthenticatedRequest): string | null {
  const value = request.header('idempotency-key')?.trim()
  if (!value) return null
  if (!SAFE_IDEMPOTENCY_KEY.test(value)) {
    throw new AppError({
      status: 400,
      code: 'IDEMPOTENCY_KEY_INVALID',
      message: 'Idempotency key has an invalid format',
    })
  }
  return value
}

export function createKycRouter(dependencies: KycRouteDependencies): Router {
  const router = Router()
  router.get(
    '/me/kyc',
    dependencies.requireIdentity,
    (request: AuthenticatedRequest, response, next) => {
      const context = requireRequestContext(request)
      void dependencies.resolvePlayer
        .execute(requireIdentity(request), { correlationId: context.correlationId })
        .then(({ player }) =>
          dependencies.getKycProfile.execute(player.id, {
            actorType: 'external_identity',
            actorId: request.identity!.subject,
            correlationId: context.correlationId,
          }),
        )
        .then((profile) => response.status(200).json(profile))
        .catch(next)
    },
  )
  router.post(
    '/me/kyc/sessions',
    dependencies.requireIdentity,
    (request: AuthenticatedRequest, response, next) => {
      const context = requireRequestContext(request)
      let key: string | null
      try {
        key = idempotencyKey(request)
      } catch (error) {
        next(error)
        return
      }
      void dependencies.resolvePlayer
        .execute(requireIdentity(request), { correlationId: context.correlationId })
        .then(({ player }) =>
          dependencies.startKycVerification.execute(
            { playerId: player.id, idempotencyKey: key },
            {
              actorType: 'external_identity',
              actorId: request.identity!.subject,
              correlationId: context.correlationId,
            },
          ),
        )
        .then((session) => response.status(200).json(session))
        .catch(next)
    },
  )
  return router
}

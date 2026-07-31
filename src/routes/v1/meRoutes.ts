import { Router, type RequestHandler } from 'express'
import type { AuthenticatedRequest } from '../../auth/auth0Jwt.js'
import type { GetCurrentPlayerService } from '../../players/application/GetCurrentPlayerService.js'
import { AppError } from '../../shared/http/AppError.js'
import { requireRequestContext } from '../../shared/http/requestContext.js'
import { createKycRouter, type KycRouteDependencies } from './kycRoutes.js'

export interface MeRouteDependencies extends KycRouteDependencies {
  requireIdentity: RequestHandler
  getCurrentPlayer: GetCurrentPlayerService
}

export async function currentPlayerPayload(
  request: AuthenticatedRequest,
  service: GetCurrentPlayerService,
) {
  if (!request.identity) {
    throw new AppError({
      status: 500,
      code: 'AUTH_CONTEXT_MISSING',
      message: 'Authenticated identity was not attached',
      publicMessage: 'An unexpected error occurred',
    })
  }
  const { correlationId } = requireRequestContext(request)
  return service.execute(request.identity, correlationId)
}

export function createMeHandler(service: GetCurrentPlayerService): RequestHandler {
  return (request: AuthenticatedRequest, response, next) => {
    void currentPlayerPayload(request, service)
      .then((payload) => response.status(200).json(payload))
      .catch(next)
  }
}

export function createV1Router(dependencies: MeRouteDependencies): Router {
  const router = Router()
  router.get('/me', dependencies.requireIdentity, createMeHandler(dependencies.getCurrentPlayer))
  router.use(createKycRouter(dependencies))
  return router
}

import { Router, type RequestHandler } from 'express'
import type { GetCurrentPlayerService } from '../players/application/GetCurrentPlayerService.js'
import { currentPlayerPayload } from '../routes/v1/meRoutes.js'
import type { AuthenticatedRequest } from './auth0Jwt.js'

/** Deprecated compatibility route for the existing frontend. Never use roles from this response for authorization. */
export function createAuthRoutes(
  requireIdentity: RequestHandler,
  getCurrentPlayer: GetCurrentPlayerService,
): Router {
  const router = Router()
  router.get('/me', requireIdentity, (request: AuthenticatedRequest, response, next) => {
    response.setHeader('Deprecation', 'true')
    response.setHeader('Link', '</v1/me>; rel="successor-version"')
    void currentPlayerPayload(request, getCurrentPlayer)
      .then((player) =>
        response.status(200).json({
          userId: player.playerId,
          authProvider: 'auth0',
          email: player.email ?? undefined,
          displayName: player.displayName ?? player.playerId,
          roles: ['player'],
        }),
      )
      .catch(next)
  })
  return router
}

import { Router } from 'express'
import {
  type AuthenticatedRequest,
  requireAuth0Jwt,
} from './auth0Jwt.js'

export function createAuthRoutes() {
  const router = Router()

  router.get('/me', requireAuth0Jwt(), (req: AuthenticatedRequest, res) => {
    if (!req.player) {
      return res.status(401).json({
        error: 'invalid_token',
        message: 'Bearer token is invalid',
      })
    }

    const { userId, authProvider, email, displayName, roles } = req.player
    return res.json({
      userId,
      authProvider,
      email,
      displayName,
      roles,
    })
  })

  return router
}

export default createAuthRoutes()

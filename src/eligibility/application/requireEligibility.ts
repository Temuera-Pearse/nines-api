import type { NextFunction, RequestHandler, Response } from 'express'
import type { AuthenticatedRequest } from '../../auth/auth0Jwt.js'
import type { ResolveOrCreatePlayerService } from '../../players/application/ResolveOrCreatePlayerService.js'
import type { Player } from '../../players/domain/Player.js'
import { AppError } from '../../shared/http/AppError.js'
import { requireRequestContext } from '../../shared/http/requestContext.js'
import type { EligibilityDecision } from '../domain/EligibilityDecision.js'
import type { PlayerOperation } from '../domain/PlayerOperation.js'
import type { EvaluateEligibilityService } from './EvaluateEligibilityService.js'

export interface EligibilityRequest extends AuthenticatedRequest {
  player?: Player
  eligibilityDecision?: EligibilityDecision
}

export interface RequireEligibilityDependencies {
  resolvePlayer: ResolveOrCreatePlayerService
  evaluateEligibility: EvaluateEligibilityService
}

export function requireEligibility(
  operation: PlayerOperation,
  dependencies: RequireEligibilityDependencies,
): RequestHandler {
  return async (
    request: EligibilityRequest,
    _response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      if (!request.identity) {
        throw new AppError({
          status: 500,
          code: 'AUTH_CONTEXT_MISSING',
          message: 'Authenticated identity was not attached',
          publicMessage: 'An unexpected error occurred',
        })
      }
      const { correlationId } = requireRequestContext(request)
      const { player } = await dependencies.resolvePlayer.execute(request.identity, {
        correlationId,
      })
      const decision = await dependencies.evaluateEligibility.execute(
        { player, operation },
        {
          actorType: 'external_identity',
          actorId: request.identity.subject,
          correlationId,
          purpose: 'authorization',
        },
      )
      request.player = player
      request.eligibilityDecision = decision

      if (!decision.allowed) {
        throw new AppError({
          status: 403,
          code: 'ELIGIBILITY_DENIED',
          message: `Eligibility denied for ${operation}`,
          publicMessage: 'Operation is not permitted',
          publicDetails: {
            decisionId: decision.decisionId,
            reasonCodes: decision.reasonCodes,
          },
        })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

import { Router, type RequestHandler } from 'express'
import type { AuthenticatedRequest } from '../../auth/auth0Jwt.js'
import type { CreateCryptoFundingIntentService } from '../../crypto/application/CreateCryptoFundingIntentService.js'
import type { GetCryptoFundingIntentService } from '../../crypto/application/GetCryptoFundingIntentService.js'
import type { ResolveOrCreatePlayerService } from '../../players/application/ResolveOrCreatePlayerService.js'
import { AppError } from '../../shared/http/AppError.js'
import { requireRequestContext } from '../../shared/http/requestContext.js'

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface CryptoFundingRouteDependencies {
  requireIdentity: RequestHandler
  resolvePlayer: ResolveOrCreatePlayerService
  createCryptoFundingIntent: CreateCryptoFundingIntentService
  getCryptoFundingIntent: GetCryptoFundingIntentService
}

function identity(request: AuthenticatedRequest) {
  if (!request.identity) throw new AppError({ status: 500, code: 'AUTH_CONTEXT_MISSING', message: 'Authenticated identity was not attached', publicMessage: 'An unexpected error occurred' })
  return request.identity
}

function key(request: AuthenticatedRequest): string {
  const value = request.header('idempotency-key')?.trim()
  if (!value) throw new AppError({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key is required' })
  if (!SAFE_KEY.test(value)) throw new AppError({ status: 400, code: 'IDEMPOTENCY_KEY_INVALID', message: 'Idempotency key has an invalid format' })
  return value
}

export function createCryptoFundingRouter(dependencies: CryptoFundingRouteDependencies): Router {
  const router = Router()
  router.post('/crypto/funding-intents', dependencies.requireIdentity, (request: AuthenticatedRequest, response, next) => {
    const context = requireRequestContext(request)
    let idempotencyKey: string
    try { idempotencyKey = key(request) } catch (error) { next(error); return }
    const body = request.body as Record<string, unknown>
    if (typeof body?.asset !== 'string' || typeof body?.amount !== 'string') {
      next(new AppError({ status: 400, code: 'CRYPTO_FUNDING_REQUEST_INVALID', message: 'Crypto funding request is invalid' })); return
    }
    void dependencies.resolvePlayer.execute(identity(request), { correlationId: context.correlationId })
      .then(({ player }) => dependencies.createCryptoFundingIntent.execute(
        { playerId: player.id, asset: body.asset as string, amount: body.amount as string, idempotencyKey },
        { actorType: 'PLAYER', actorId: request.identity!.subject, correlationId: context.correlationId },
      )).then((intent) => response.status(200).json(intent)).catch(next)
  })
  router.get('/crypto/funding-intents', dependencies.requireIdentity, (request: AuthenticatedRequest, response, next) => {
    const context = requireRequestContext(request)
    void dependencies.resolvePlayer.execute(identity(request), { correlationId: context.correlationId })
      .then(({ player }) => dependencies.getCryptoFundingIntent.list(player.id))
      .then((intents) => response.status(200).json({ items: intents })).catch(next)
  })
  router.get('/crypto/funding-intents/:id', dependencies.requireIdentity, (request: AuthenticatedRequest, response, next) => {
    if (!UUID.test(request.params.id)) { next(new AppError({ status: 404, code: 'CRYPTO_FUNDING_INTENT_NOT_FOUND', message: 'Crypto funding intent was not found' })); return }
    const context = requireRequestContext(request)
    void dependencies.resolvePlayer.execute(identity(request), { correlationId: context.correlationId })
      .then(({ player }) => dependencies.getCryptoFundingIntent.get(player.id, request.params.id))
      .then((intent) => response.status(200).json(intent)).catch(next)
  })
  return router
}

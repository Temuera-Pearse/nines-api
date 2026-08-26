import { Router } from 'express'
import type { ProcessCryptoProviderEventService } from '../../crypto/application/ProcessCryptoProviderEventService.js'
import { AppError } from '../../shared/http/AppError.js'
import { requireRequestContext } from '../../shared/http/requestContext.js'

export function createCryptoProviderEventRouter(providerName: string, service: ProcessCryptoProviderEventService): Router {
  const router = Router()
  router.post('/provider-events/crypto/:provider', (request, response, next) => {
    if (request.params.provider !== providerName) {
      next(new AppError({ status: 404, code: 'CRYPTO_PROVIDER_NOT_FOUND', message: 'Crypto provider was not found' })); return
    }
    const context = requireRequestContext(request)
    void service.execute(
      {
        payload: request.body,
        signature: request.header('x-crypto-provider-signature') ?? null,
        rawBody: (request as typeof request & { rawBody?: Buffer }).rawBody,
        headers: request.headers,
      },
      { actorType: 'PROVIDER', actorId: providerName, correlationId: context.correlationId },
    ).then((result) => response.status(200).json(result)).catch(next)
  })
  return router
}

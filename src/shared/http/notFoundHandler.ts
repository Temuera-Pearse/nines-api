import type { RequestHandler } from 'express'
import { type ContextRequest, requireRequestContext } from './requestContext.js'

export const notFoundHandler: RequestHandler = (request: ContextRequest, response) => {
  const { correlationId } = requireRequestContext(request)
  response.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: 'Route not found',
      correlationId,
    },
  })
}

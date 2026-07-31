import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AppLogger } from '../observability/logger.js'

const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface RequestContext {
  correlationId: string
  logger: AppLogger
}

export interface ContextRequest extends Request {
  context?: RequestContext
}

export function correlationIdFromRequest(request: Request): string {
  const incoming = request.header('x-correlation-id')?.trim()
  return incoming && SAFE_CORRELATION_ID.test(incoming) ? incoming : randomUUID()
}

export function createRequestContextMiddleware(logger: AppLogger): RequestHandler {
  return (request: ContextRequest, response: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint()
    const correlationId = correlationIdFromRequest(request)
    const requestLogger = logger.child({ correlationId })
    request.context = { correlationId, logger: requestLogger }
    response.setHeader('x-correlation-id', correlationId)

    response.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      requestLogger.info({
        event: 'http_request_completed',
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      })
    })
    next()
  }
}

export function requireRequestContext(request: ContextRequest): RequestContext {
  if (!request.context) throw new Error('Request context middleware was not applied')
  return request.context
}

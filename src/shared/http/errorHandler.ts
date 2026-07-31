import type { ErrorRequestHandler } from 'express'
import { isAppError } from './AppError.js'
import { type ContextRequest, requireRequestContext } from './requestContext.js'

export const errorHandler: ErrorRequestHandler = (error, request: ContextRequest, response, _next) => {
  const context = requireRequestContext(request)
  if (isAppError(error)) {
    const log = error.status >= 500 ? context.logger.error.bind(context.logger) : context.logger.warn.bind(context.logger)
    log({ event: 'application_error', code: error.code, status: error.status, err: error.cause ?? error })
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.publicMessage,
        correlationId: context.correlationId,
        ...error.publicDetails,
      },
    })
    return
  }

  context.logger.error({ event: 'unexpected_application_error', err: error })
  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      correlationId: context.correlationId,
    },
  })
}

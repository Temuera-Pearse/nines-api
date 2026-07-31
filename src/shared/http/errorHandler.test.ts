import type { NextFunction, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../observability/logger.js'
import { AppError } from './AppError.js'
import { errorHandler } from './errorHandler.js'
import type { ContextRequest } from './requestContext.js'

function responseHarness() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
  return response as Response & typeof response
}

function requestHarness(): ContextRequest {
  return {
    context: { correlationId: 'corr-1', logger: createSilentLogger() },
  } as ContextRequest
}

describe('public error mapping', () => {
  it('maps expected errors to stable public shape', () => {
    const response = responseHarness()
    errorHandler(
      new AppError({ status: 400, code: 'INVALID_INPUT', message: 'Invalid input' }),
      requestHarness(),
      response,
      (() => undefined) as NextFunction,
    )
    expect(response.statusCode).toBe(400)
    expect(response.body).toEqual({
      error: { code: 'INVALID_INPUT', message: 'Invalid input', correlationId: 'corr-1' },
    })
  })

  it('does not expose unexpected error details', () => {
    const response = responseHarness()
    errorHandler(
      new Error('database password was visible'),
      requestHarness(),
      response,
      (() => undefined) as NextFunction,
    )
    expect(response.statusCode).toBe(500)
    expect(JSON.stringify(response.body)).not.toContain('database password')
    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        correlationId: 'corr-1',
      },
    })
  })
})

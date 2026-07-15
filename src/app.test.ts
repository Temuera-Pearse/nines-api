import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { createCorsMiddleware, getAllowedCorsOrigins } from './app.js'

function runCorsMiddleware({
  env = {},
  method,
  origin,
}: {
  env?: NodeJS.ProcessEnv
  method: string
  origin: string
}) {
  const headers = new Map<string, string>()
  let statusCode = 200
  let nextCalled = false

  const req = {
    method,
    header: (name: string) =>
      name.toLowerCase() === 'origin' ? origin : undefined,
  } as Request
  const res = {
    header(name: string, value: string) {
      headers.set(name.toLowerCase(), value)
      return this
    },
    sendStatus(code: number) {
      statusCode = code
      return this
    },
  } as unknown as Response
  const next: NextFunction = () => {
    nextCalled = true
  }

  createCorsMiddleware(env)(req, res, next)

  return {
    headers,
    get statusCode() {
      return statusCode
    },
    get nextCalled() {
      return nextCalled
    },
  }
}

describe('CORS configuration', () => {
  it('allows both local Vite origins by default', () => {
    expect(getAllowedCorsOrigins({})).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ])
  })

  it('supports one or comma-separated CORS_ORIGIN values', () => {
    expect(
      getAllowedCorsOrigins({
        CORS_ORIGIN: 'https://one.example',
      }),
    ).toEqual(['https://one.example'])

    expect(
      getAllowedCorsOrigins({
        CORS_ORIGIN:
          'https://one.example, https://two.example, http://localhost:5173',
      }),
    ).toEqual([
      'https://one.example',
      'https://two.example',
      'http://localhost:5173',
    ])
  })

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ])('handles /auth/me preflight from %s', (origin) => {
    const result = runCorsMiddleware({
      method: 'OPTIONS',
      origin,
    })

    expect(result.statusCode).toBe(204)
    expect(result.nextCalled).toBe(false)
    expect(result.headers.get('access-control-allow-origin')).toBe(origin)
    expect(result.headers.get('access-control-allow-methods')).toBe(
      'GET, OPTIONS',
    )
    expect(result.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type',
    )
    expect(result.headers.get('vary')).toContain('Origin')
  })

  it('forwards GET requests to /auth/me authentication', () => {
    const origin = 'http://localhost:5173'
    const result = runCorsMiddleware({
      method: 'GET',
      origin,
    })

    expect(result.statusCode).toBe(200)
    expect(result.nextCalled).toBe(true)
    expect(result.headers.get('access-control-allow-origin')).toBe(origin)
  })

  it('does not expose CORS permission to an unlisted origin', () => {
    const result = runCorsMiddleware({
      env: {
        CORS_ORIGIN: 'https://allowed.example',
      },
      method: 'OPTIONS',
      origin: 'https://not-allowed.example',
    })

    expect(result.statusCode).toBe(204)
    expect(result.headers.has('access-control-allow-origin')).toBe(false)
  })
})

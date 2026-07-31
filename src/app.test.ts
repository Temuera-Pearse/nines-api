import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { createCorsMiddleware, isMockHostedKycEnabled } from './app.js'
import { loadConfig } from './config/config.js'
import { renderMockKycPage } from './routes/dev/mockKycRoutes.js'

function runCors(method: string, origin: string, allowedOrigins: readonly string[]) {
  const headers = new Map<string, string>()
  let status = 200
  let nextCalled = false
  const request = {
    method,
    header: (name: string) => (name.toLowerCase() === 'origin' ? origin : undefined),
  } as Request
  const response = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    status(code: number) {
      status = code
      return this
    },
    send() {
      return this
    },
  } as unknown as Response
  const next: NextFunction = () => {
    nextCalled = true
  }
  createCorsMiddleware(allowedOrigins)(request, response, next)
  return { headers, status, nextCalled }
}

describe('CORS middleware', () => {
  it('allows an explicitly configured origin', () => {
    const result = runCors('GET', 'https://app.example', ['https://app.example'])
    expect(result.nextCalled).toBe(true)
    expect(result.headers.get('access-control-allow-origin')).toBe('https://app.example')
  })

  it('does not grant an unlisted origin', () => {
    const result = runCors('GET', 'https://evil.example', ['https://app.example'])
    expect(result.nextCalled).toBe(true)
    expect(result.headers.has('access-control-allow-origin')).toBe(false)
  })

  it('answers preflight and exposes the correlation header', () => {
    const result = runCors('OPTIONS', 'https://app.example', ['https://app.example'])
    expect(result.status).toBe(204)
    expect(result.nextCalled).toBe(false)
    expect(result.headers.get('access-control-expose-headers')).toContain('X-Correlation-Id')
  })
})

const baseEnvironment = {
  AUTH0_ISSUER: 'https://tenant.example.auth0.com/',
  AUTH0_AUDIENCE: 'https://nines-api.example',
  DATABASE_URL: 'postgresql://localhost/nines_api',
  CORS_ORIGIN: 'http://localhost:5173',
  PUBLIC_API_BASE_URL: 'http://localhost:3002',
}

describe('development-only mock hosted KYC page', () => {
  it('renders the standalone provider page content', () => {
    const html = renderMockKycPage(
      '11111111-1111-4111-8111-111111111111',
    )
    expect(html).toContain('Mock KYC Provider')
    expect(html).toContain('This is a mock KYC page.')
    expect(html).toContain(
      'For now, would you like to pass or fail verification?',
    )
    expect(html).toContain('Pass verification')
    expect(html).toContain('Fail verification')
    expect(html).toContain('Cancel')
  })

  it('can be enabled in development but is always absent in production', () => {
    const development = loadConfig({
      ...baseEnvironment,
      NODE_ENV: 'development',
      ENABLE_FAKE_KYC_TEST_ROUTES: 'true',
    })
    const production = loadConfig({
      ...baseEnvironment,
      NODE_ENV: 'production',
      PUBLIC_API_BASE_URL: 'https://api.example',
      ENABLE_FAKE_KYC_TEST_ROUTES: 'false',
    })
    expect(isMockHostedKycEnabled(development)).toBe(true)
    expect(isMockHostedKycEnabled(production)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const valid = {
  NODE_ENV: 'development',
  PORT: '3002',
  AUTH0_ISSUER: 'https://tenant.example.auth0.com',
  AUTH0_AUDIENCE: 'https://nines-api.example',
  DATABASE_URL: 'postgresql://localhost/nines_api',
  CORS_ORIGIN: 'https://app.example,https://second.example',
}

describe('runtime configuration', () => {
  it('parses, normalizes, and freezes valid configuration', () => {
    const config = loadConfig(valid)
    expect(config.auth0.issuer).toBe('https://tenant.example.auth0.com/')
    expect(config.cors.allowedOrigins).toEqual(['https://app.example', 'https://second.example'])
    expect(config.kyc).toEqual({
      provider: 'fake',
      sessionTtlMinutes: 60,
      verificationTtlDays: 365,
      providerMaxFutureSkewSeconds: 300,
      enableFakeTestRoutes: false,
      publicApiBaseUrl: 'http://localhost:3002',
    })
    expect(config.crypto).toEqual({
      fundingEnabled: false,
      provider: null,
      supportedAssets: [{ asset: 'USDC', decimals: 6 }],
      minimumAmount: '1',
      maximumAmount: '100000',
      intentTtlMinutes: 60,
      providerMaxFutureSkewSeconds: 300,
      fakeWebhookSecret: null,
    })
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.auth0)).toBe(true)
  })

  it.each(['0', '65536', 'not-a-port'])('rejects invalid PORT %s', (port) => {
    expect(() => loadConfig({ ...valid, PORT: port })).toThrow(/PORT/)
  })

  it('requires a database outside isolated unit tests', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: '' })).toThrow('DATABASE_URL is required')
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'test', DATABASE_URL: '' }),
    ).not.toThrow()
  })

  it('requires a valid Auth0 issuer and non-empty audience', () => {
    expect(() => loadConfig({ ...valid, AUTH0_ISSUER: 'invalid' })).toThrow(/AUTH0_ISSUER/)
    expect(() => loadConfig({ ...valid, AUTH0_AUDIENCE: ' ' })).toThrow(/AUTH0_AUDIENCE/)
  })

  it('requires HTTPS issuer in production', () => {
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', AUTH0_ISSUER: 'http://tenant.example' }),
    ).toThrow(/HTTPS/)
  })

  it('rejects wildcard CORS in production', () => {
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', CORS_ORIGIN: '*' }),
    ).toThrow(/wildcard/)
  })

  it('rejects origins with paths', () => {
    expect(() => loadConfig({ ...valid, CORS_ORIGIN: 'https://app.example/path' })).toThrow(
      /without paths/,
    )
  })

  it('validates KYC provider and TTL configuration', () => {
    expect(() => loadConfig({ ...valid, KYC_PROVIDER: 'real-vendor' })).toThrow(
      /KYC_PROVIDER/,
    )
    expect(() => loadConfig({ ...valid, KYC_SESSION_TTL_MINUTES: '0' })).toThrow(
      /KYC_SESSION_TTL_MINUTES/,
    )
    expect(() => loadConfig({ ...valid, KYC_VERIFICATION_TTL_DAYS: '1.5' })).toThrow(
      /KYC_VERIFICATION_TTL_DAYS/,
    )
    expect(() => loadConfig({ ...valid, KYC_PROVIDER_MAX_FUTURE_SKEW_SECONDS: '0' })).toThrow(
      /KYC_PROVIDER_MAX_FUTURE_SKEW_SECONDS/,
    )
  })

  it('cannot enable fake KYC mutation routes in production', () => {
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        ENABLE_FAKE_KYC_TEST_ROUTES: 'true',
      }),
    ).toThrow(/cannot be enabled in production/)
  })

  it('validates the public API origin used by hosted mock KYC', () => {
    expect(
      loadConfig({ ...valid, PUBLIC_API_BASE_URL: 'http://localhost:4000' }).kyc
        .publicApiBaseUrl,
    ).toBe('http://localhost:4000')
    expect(() =>
      loadConfig({ ...valid, PUBLIC_API_BASE_URL: 'http://localhost:4000/path' }),
    ).toThrow(/without a path/)
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        PUBLIC_API_BASE_URL: 'http://api.example',
      }),
    ).toThrow(/HTTPS/)
  })

  it('fails closed for crypto funding and rejects fake production configuration', () => {
    expect(() => loadConfig({ ...valid, CRYPTO_FUNDING_ENABLED: 'true' })).toThrow(/CRYPTO_PROVIDER/)
    const enabled = loadConfig({ ...valid, CRYPTO_FUNDING_ENABLED: 'true', CRYPTO_PROVIDER: 'fake',
      CRYPTO_FAKE_WEBHOOK_SECRET: 'development-secret-123', CRYPTO_SUPPORTED_ASSETS: 'USDC:6,BTC:8' })
    expect(enabled.crypto.fundingEnabled).toBe(true)
    expect(enabled.crypto.supportedAssets).toEqual([{ asset: 'USDC', decimals: 6 }, { asset: 'BTC', decimals: 8 }])
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', CRYPTO_FUNDING_ENABLED: 'true',
      CRYPTO_PROVIDER: 'fake', CRYPTO_FAKE_WEBHOOK_SECRET: 'production-secret-123' })).toThrow(/cannot be enabled in production/)
  })

  it('rejects crypto ranges that a configured asset cannot represent', () => {
    expect(() => loadConfig({
      ...valid,
      CRYPTO_SUPPORTED_ASSETS: 'USDC:2',
      CRYPTO_FUNDING_MIN_AMOUNT: '0.001',
    })).toThrow(/precision for USDC/)
  })
})

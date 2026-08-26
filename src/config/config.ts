import { parseEnvironment, type ParseEnvironmentOptions } from './env.js'

export interface AppConfig {
  readonly environment: 'development' | 'test' | 'production'
  readonly port: number
  readonly auth0: Readonly<{
    issuer: string
    audience: string
  }>
  readonly database: Readonly<{
    url: string | null
  }>
  readonly cors: Readonly<{
    allowedOrigins: readonly string[]
  }>
  readonly kyc: Readonly<{
    provider: 'fake'
    sessionTtlMinutes: number
    verificationTtlDays: number
    providerMaxFutureSkewSeconds: number
    enableFakeTestRoutes: boolean
    publicApiBaseUrl: string | null
  }>
  readonly crypto: Readonly<{
    fundingEnabled: boolean
    provider: 'fake' | null
    supportedAssets: readonly Readonly<{ asset: string; decimals: number }>[]
    minimumAmount: string
    maximumAmount: string
    intentTtlMinutes: number
    providerMaxFutureSkewSeconds: number
    fakeWebhookSecret: string | null
  }>
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  options: ParseEnvironmentOptions = {},
): AppConfig {
  const env = parseEnvironment(source, options)
  return Object.freeze({
    environment: env.nodeEnvironment,
    port: env.port,
    auth0: Object.freeze({ issuer: env.auth0Issuer, audience: env.auth0Audience }),
    database: Object.freeze({ url: env.databaseUrl }),
    cors: Object.freeze({ allowedOrigins: Object.freeze([...env.corsOrigins]) }),
    kyc: Object.freeze({
      provider: env.kycProvider,
      sessionTtlMinutes: env.kycSessionTtlMinutes,
      verificationTtlDays: env.kycVerificationTtlDays,
      providerMaxFutureSkewSeconds: env.kycProviderMaxFutureSkewSeconds,
      enableFakeTestRoutes: env.enableFakeKycTestRoutes,
      publicApiBaseUrl: env.publicApiBaseUrl,
    }),
    crypto: Object.freeze({
      fundingEnabled: env.cryptoFundingEnabled,
      provider: env.cryptoProvider,
      supportedAssets: Object.freeze(env.cryptoSupportedAssets.map((entry) => Object.freeze({ ...entry }))),
      minimumAmount: env.cryptoFundingMinimumAmount,
      maximumAmount: env.cryptoFundingMaximumAmount,
      intentTtlMinutes: env.cryptoFundingIntentTtlMinutes,
      providerMaxFutureSkewSeconds: env.cryptoProviderMaxFutureSkewSeconds,
      fakeWebhookSecret: env.cryptoFakeWebhookSecret,
    }),
  })
}

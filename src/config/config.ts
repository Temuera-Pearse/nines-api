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
    enableFakeTestRoutes: boolean
    publicApiBaseUrl: string | null
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
      enableFakeTestRoutes: env.enableFakeKycTestRoutes,
      publicApiBaseUrl: env.publicApiBaseUrl,
    }),
  })
}

import { z } from 'zod'
import { compareCryptoAmounts, normalizeCryptoAsset, parseCryptoAmount } from '../crypto/domain/CryptoAmount.js'

const nodeEnvironmentSchema = z.enum(['development', 'test', 'production'])

export interface ParsedEnvironment {
  nodeEnvironment: z.infer<typeof nodeEnvironmentSchema>
  port: number
  auth0Issuer: string
  auth0Audience: string
  databaseUrl: string | null
  corsOrigins: string[]
  kycProvider: 'fake'
  kycSessionTtlMinutes: number
  kycVerificationTtlDays: number
  kycProviderMaxFutureSkewSeconds: number
  enableFakeKycTestRoutes: boolean
  publicApiBaseUrl: string | null
  cryptoFundingEnabled: boolean
  cryptoProvider: 'fake' | null
  cryptoSupportedAssets: Array<{ asset: string; decimals: number }>
  cryptoFundingMinimumAmount: string
  cryptoFundingMaximumAmount: string
  cryptoFundingIntentTtlMinutes: number
  cryptoProviderMaxFutureSkewSeconds: number
  cryptoFakeWebhookSecret: string | null
  fundingAttestationDeliveryEnabled: boolean
  financialServiceBaseUrl: string | null
  securityEvidenceDeliveryEnabled: boolean
  securityServiceBaseUrl: string | null
  serviceAuthHmacSecret: string | null
  serviceAuthKeyId: string
  serviceDeliveryPollIntervalMs: number
}

export interface ParseEnvironmentOptions {
  requireDatabase?: boolean
}

const LOCAL_DEVELOPMENT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

function parsePort(value: string | undefined): number {
  const parsed = z.coerce.number().int().min(1).max(65_535).safeParse(value ?? 3002)
  if (!parsed.success) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }
  return parsed.data
}

function parseIssuer(value: string | undefined, nodeEnvironment: ParsedEnvironment['nodeEnvironment']): string {
  const parsed = z.string().trim().min(1).url().safeParse(value)
  if (!parsed.success) {
    throw new Error('AUTH0_ISSUER must be a valid URL')
  }

  const url = new URL(parsed.data)
  if (nodeEnvironment === 'production' && url.protocol !== 'https:') {
    throw new Error('AUTH0_ISSUER must use HTTPS in production')
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('AUTH0_ISSUER must use HTTP or HTTPS')
  }

  return url.href.endsWith('/') ? url.href : `${url.href}/`
}

function parseDatabaseUrl(value: string | undefined, required: boolean): string | null {
  const normalized = value?.trim() ?? ''
  if (!normalized) {
    if (required) throw new Error('DATABASE_URL is required')
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol')
  }
  return normalized
}

function parseCorsOrigins(value: string | undefined, nodeEnvironment: ParsedEnvironment['nodeEnvironment']): string[] {
  const origins = (value ?? (nodeEnvironment === 'production' ? '' : LOCAL_DEVELOPMENT_ORIGINS.join(',')))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  if (nodeEnvironment === 'production' && origins.includes('*')) {
    throw new Error('CORS_ORIGIN must not contain a wildcard in production')
  }

  for (const origin of origins) {
    if (origin === '*' && nodeEnvironment !== 'production') continue
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new Error(`CORS_ORIGIN contains an invalid origin: ${origin}`)
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`CORS_ORIGIN must contain HTTP origins without paths: ${origin}`)
    }
  }

  return [...new Set(origins)]
}

function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const parsed = z.coerce.number().int().positive().safeParse(value ?? defaultValue)
  if (!parsed.success) throw new Error(`${name} must be a positive integer`)
  return parsed.data
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined) return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function parseCryptoAssets(value: string | undefined): Array<{ asset: string; decimals: number }> {
  const entries = (value ?? 'USDC:6').split(',').map((item) => item.trim()).filter(Boolean)
  const parsed = entries.map((entry) => {
    const [rawAsset, rawDecimals, extra] = entry.split(':')
    if (!rawAsset || !rawDecimals || extra !== undefined) throw new Error('CRYPTO_SUPPORTED_ASSETS must use ASSET:DECIMALS entries')
    const asset = normalizeCryptoAsset(rawAsset)
    const decimals = Number(rawDecimals)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) throw new Error('CRYPTO_SUPPORTED_ASSETS decimals must be between 0 and 30')
    return { asset, decimals }
  })
  if (!parsed.length || new Set(parsed.map((entry) => entry.asset)).size !== parsed.length) throw new Error('CRYPTO_SUPPORTED_ASSETS must contain unique assets')
  return parsed
}

function parseCryptoAmountRange(value: string | undefined, fallback: string, name: string): string {
  try { return parseCryptoAmount(value ?? fallback, 30).canonical }
  catch { throw new Error(`${name} must be a positive decimal string`) }
}

function parsePublicApiBaseUrl(
  value: string | undefined,
  nodeEnvironment: ParsedEnvironment['nodeEnvironment'],
  port: number,
): string | null {
  const normalized =
    value?.trim() ||
    (nodeEnvironment === 'production' ? '' : `http://localhost:${port}`)
  if (!normalized) return null

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error('PUBLIC_API_BASE_URL must be a valid HTTP URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('PUBLIC_API_BASE_URL must be an HTTP origin without a path')
  }
  if (nodeEnvironment === 'production' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_API_BASE_URL must use HTTPS in production')
  }
  return url.origin
}

function parseServiceBaseUrl(value: string | undefined, name: string,
  nodeEnvironment: ParsedEnvironment['nodeEnvironment']): string | null {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  let url: URL
  try { url = new URL(normalized) } catch { throw new Error(`${name} must be a valid HTTP URL`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP origin without a path`)
  }
  if (nodeEnvironment === 'production' && url.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS in production`)
  }
  return url.origin
}

export function parseEnvironment(
  source: NodeJS.ProcessEnv,
  options: ParseEnvironmentOptions = {},
): ParsedEnvironment {
  const nodeEnvironmentResult = nodeEnvironmentSchema.safeParse(source.NODE_ENV ?? 'development')
  if (!nodeEnvironmentResult.success) {
    throw new Error('NODE_ENV must be development, test, or production')
  }
  const nodeEnvironment = nodeEnvironmentResult.data
  const port = parsePort(source.PORT)
  const audience = source.AUTH0_AUDIENCE?.trim() ?? ''
  if (!audience) throw new Error('AUTH0_AUDIENCE is required')
  const kycProvider = source.KYC_PROVIDER?.trim() || 'fake'
  if (kycProvider !== 'fake') throw new Error('KYC_PROVIDER must be fake')
  const enableFakeKycTestRoutes = parseBoolean(
    source.ENABLE_FAKE_KYC_TEST_ROUTES,
    'ENABLE_FAKE_KYC_TEST_ROUTES',
  )
  if (nodeEnvironment === 'production' && enableFakeKycTestRoutes) {
    throw new Error('ENABLE_FAKE_KYC_TEST_ROUTES cannot be enabled in production')
  }
  const cryptoFundingEnabled = parseBoolean(source.CRYPTO_FUNDING_ENABLED, 'CRYPTO_FUNDING_ENABLED')
  const cryptoProviderValue = source.CRYPTO_PROVIDER?.trim() || null
  if (cryptoProviderValue !== null && cryptoProviderValue !== 'fake') throw new Error('CRYPTO_PROVIDER must be fake when configured')
  if (cryptoFundingEnabled && cryptoProviderValue !== 'fake') throw new Error('CRYPTO_PROVIDER=fake is required when crypto funding is enabled')
  if (nodeEnvironment === 'production' && cryptoFundingEnabled) throw new Error('The fake crypto provider cannot be enabled in production')
  const cryptoFakeWebhookSecret = source.CRYPTO_FAKE_WEBHOOK_SECRET?.trim() || null
  if (cryptoFundingEnabled && (!cryptoFakeWebhookSecret || cryptoFakeWebhookSecret.length < 16)) throw new Error('CRYPTO_FAKE_WEBHOOK_SECRET must contain at least 16 characters when crypto funding is enabled')
  const cryptoSupportedAssets = parseCryptoAssets(source.CRYPTO_SUPPORTED_ASSETS)
  const cryptoFundingMinimumAmount = parseCryptoAmountRange(source.CRYPTO_FUNDING_MIN_AMOUNT, '1', 'CRYPTO_FUNDING_MIN_AMOUNT')
  const cryptoFundingMaximumAmount = parseCryptoAmountRange(source.CRYPTO_FUNDING_MAX_AMOUNT, '100000', 'CRYPTO_FUNDING_MAX_AMOUNT')
  if (compareCryptoAmounts(parseCryptoAmount(cryptoFundingMinimumAmount, 30), parseCryptoAmount(cryptoFundingMaximumAmount, 30)) > 0) throw new Error('CRYPTO_FUNDING_MIN_AMOUNT must not exceed CRYPTO_FUNDING_MAX_AMOUNT')
  for (const { asset, decimals } of cryptoSupportedAssets) {
    try {
      parseCryptoAmount(cryptoFundingMinimumAmount, decimals)
      parseCryptoAmount(cryptoFundingMaximumAmount, decimals)
    } catch {
      throw new Error(`Crypto funding amount range exceeds configured precision for ${asset}`)
    }
  }
  const fundingAttestationDeliveryEnabled = parseBoolean(
    source.FINANCIAL_FUNDING_ATTESTATION_DELIVERY_ENABLED,
    'FINANCIAL_FUNDING_ATTESTATION_DELIVERY_ENABLED')
  const securityEvidenceDeliveryEnabled = parseBoolean(
    source.SECURITY_EVIDENCE_DELIVERY_ENABLED, 'SECURITY_EVIDENCE_DELIVERY_ENABLED')
  const financialServiceBaseUrl = parseServiceBaseUrl(source.FINANCIAL_SERVICE_BASE_URL,
    'FINANCIAL_SERVICE_BASE_URL', nodeEnvironment)
  const securityServiceBaseUrl = parseServiceBaseUrl(source.SECURITY_SERVICE_BASE_URL,
    'SECURITY_SERVICE_BASE_URL', nodeEnvironment)
  if (fundingAttestationDeliveryEnabled && !financialServiceBaseUrl) {
    throw new Error('FINANCIAL_SERVICE_BASE_URL is required when funding attestation delivery is enabled')
  }
  if (securityEvidenceDeliveryEnabled && !securityServiceBaseUrl) {
    throw new Error('SECURITY_SERVICE_BASE_URL is required when security evidence delivery is enabled')
  }
  const serviceAuthHmacSecret = source.SERVICE_AUTH_HMAC_SECRET?.trim() || null
  if ((fundingAttestationDeliveryEnabled || securityEvidenceDeliveryEnabled) &&
      (!serviceAuthHmacSecret || serviceAuthHmacSecret.length < 32)) {
    throw new Error('SERVICE_AUTH_HMAC_SECRET must contain at least 32 characters when service delivery is enabled')
  }
  if (nodeEnvironment === 'production' &&
      (fundingAttestationDeliveryEnabled || securityEvidenceDeliveryEnabled)) {
    throw new Error('Production service delivery requires a production authenticator; HMAC delivery is development/test only')
  }

  return {
    nodeEnvironment,
    port,
    auth0Issuer: parseIssuer(source.AUTH0_ISSUER, nodeEnvironment),
    auth0Audience: audience,
    databaseUrl: parseDatabaseUrl(
      source.DATABASE_URL,
      options.requireDatabase ?? nodeEnvironment !== 'test',
    ),
    corsOrigins: parseCorsOrigins(source.CORS_ORIGIN, nodeEnvironment),
    kycProvider,
    kycSessionTtlMinutes: parsePositiveInteger(
      source.KYC_SESSION_TTL_MINUTES,
      60,
      'KYC_SESSION_TTL_MINUTES',
    ),
    kycVerificationTtlDays: parsePositiveInteger(
      source.KYC_VERIFICATION_TTL_DAYS,
      365,
      'KYC_VERIFICATION_TTL_DAYS',
    ),
    kycProviderMaxFutureSkewSeconds: parsePositiveInteger(
      source.KYC_PROVIDER_MAX_FUTURE_SKEW_SECONDS,
      300,
      'KYC_PROVIDER_MAX_FUTURE_SKEW_SECONDS',
    ),
    enableFakeKycTestRoutes,
    publicApiBaseUrl: parsePublicApiBaseUrl(
      source.PUBLIC_API_BASE_URL,
      nodeEnvironment,
      port,
    ),
    cryptoFundingEnabled,
    cryptoProvider: cryptoProviderValue,
    cryptoSupportedAssets,
    cryptoFundingMinimumAmount,
    cryptoFundingMaximumAmount,
    cryptoFundingIntentTtlMinutes: parsePositiveInteger(source.CRYPTO_FUNDING_INTENT_TTL_MINUTES, 60, 'CRYPTO_FUNDING_INTENT_TTL_MINUTES'),
    cryptoProviderMaxFutureSkewSeconds: parsePositiveInteger(source.CRYPTO_PROVIDER_MAX_FUTURE_SKEW_SECONDS, 300, 'CRYPTO_PROVIDER_MAX_FUTURE_SKEW_SECONDS'),
    cryptoFakeWebhookSecret,
    fundingAttestationDeliveryEnabled,
    financialServiceBaseUrl,
    securityEvidenceDeliveryEnabled,
    securityServiceBaseUrl,
    serviceAuthHmacSecret,
    serviceAuthKeyId: source.SERVICE_AUTH_KEY_ID?.trim() || 'development-hmac-v1',
    serviceDeliveryPollIntervalMs: parsePositiveInteger(source.SERVICE_DELIVERY_POLL_INTERVAL_MS,
      1000, 'SERVICE_DELIVERY_POLL_INTERVAL_MS'),
  }
}

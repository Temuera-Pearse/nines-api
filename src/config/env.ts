import { z } from 'zod'

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
  enableFakeKycTestRoutes: boolean
  publicApiBaseUrl: string | null
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
    enableFakeKycTestRoutes,
    publicApiBaseUrl: parsePublicApiBaseUrl(
      source.PUBLIC_API_BASE_URL,
      nodeEnvironment,
      port,
    ),
  }
}

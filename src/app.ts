import express, { type RequestHandler } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from './config/config.js'
import { createAuth0JwtVerifier, requireAuth0Identity, type VerifyBearerToken } from './auth/auth0Jwt.js'
import { createAuthRoutes } from './auth/authRoutes.js'
import { PostgresAuditRepository } from './audit/PostgresAuditRepository.js'
import { EvaluateEligibilityService } from './eligibility/application/EvaluateEligibilityService.js'
import { PostgresEligibilityDecisionRepository } from './eligibility/infrastructure/PostgresEligibilityDecisionRepository.js'
import { PostgresRestrictionRepository } from './eligibility/infrastructure/PostgresRestrictionRepository.js'
import { GetKycProfileService } from './kyc/application/GetKycProfileService.js'
import { MockHostedKycService } from './kyc/application/MockHostedKycService.js'
import { ProcessKycProviderEventService } from './kyc/application/ProcessKycProviderEventService.js'
import { StartKycVerificationService } from './kyc/application/StartKycVerificationService.js'
import { PostgresKycProfileRepository } from './kyc/infrastructure/PostgresKycProfileRepository.js'
import { PostgresKycProviderEventRepository } from './kyc/infrastructure/PostgresKycProviderEventRepository.js'
import { PostgresKycSessionRepository } from './kyc/infrastructure/PostgresKycSessionRepository.js'
import { PostgresKycStatusReader } from './kyc/infrastructure/PostgresKycStatusReader.js'
import { PostgresKycStatusTransitionRepository } from './kyc/infrastructure/PostgresKycStatusTransitionRepository.js'
import { FakeKycProvider } from './kyc/providers/FakeKycProvider.js'
import type { KycProvider } from './kyc/providers/KycProvider.js'
import { EligibilityPermissionService } from './permissions/EligibilityPermissionService.js'
import { GetCurrentPlayerService } from './players/application/GetCurrentPlayerService.js'
import { ResolveOrCreatePlayerService } from './players/application/ResolveOrCreatePlayerService.js'
import { PostgresAuthenticationIdentityRepository } from './players/infrastructure/PostgresAuthenticationIdentityRepository.js'
import { PostgresPlayerRepository } from './players/infrastructure/PostgresPlayerRepository.js'
import { createHealthRouter } from './routes/healthRoutes.js'
import {
  createMockKycRouter,
  type MockHostedKycOperations,
} from './routes/dev/mockKycRoutes.js'
import { createV1Router } from './routes/v1/meRoutes.js'
import { errorHandler } from './shared/http/errorHandler.js'
import { notFoundHandler } from './shared/http/notFoundHandler.js'
import { createRequestContextMiddleware } from './shared/http/requestContext.js'
import type { AppLogger } from './shared/observability/logger.js'

export function createCorsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  return (request, response, next) => {
    const origin = request.header('origin')
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
    }
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Correlation-Id, Idempotency-Key')
    response.setHeader('Access-Control-Expose-Headers', 'X-Correlation-Id, Deprecation, Link')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (request.method === 'OPTIONS') {
      response.status(204).send()
      return
    }
    next()
  }
}

export interface CreateAppDependencies {
  config: AppConfig
  pool: Pool
  logger: AppLogger
  verifyBearerToken?: VerifyBearerToken
  getCurrentPlayer?: GetCurrentPlayerService
  kycProvider?: KycProvider
  mockHostedKyc?: MockHostedKycOperations
  clock?: () => Date
}

export function isMockHostedKycEnabled(config: AppConfig): boolean {
  return (
    config.environment !== 'production' &&
    config.kyc.enableFakeTestRoutes
  )
}

export function createApp(dependencies: CreateAppDependencies) {
  const { config, pool, logger } = dependencies
  const verifier =
    dependencies.verifyBearerToken ??
    createAuth0JwtVerifier({ issuer: config.auth0.issuer, audience: config.auth0.audience })
  const resolver = new ResolveOrCreatePlayerService(
    pool,
    new PostgresPlayerRepository(),
    new PostgresAuthenticationIdentityRepository(),
    new PostgresAuditRepository(),
    logger,
  )
  const restrictionRepository = new PostgresRestrictionRepository()
  const kycProfiles = new PostgresKycProfileRepository()
  const kycSessions = new PostgresKycSessionRepository()
  const kycTransitions = new PostgresKycStatusTransitionRepository()
  const kycStatuses = new PostgresKycStatusReader(
    pool,
    kycProfiles,
    new PostgresAuditRepository(),
  )
  const clock = dependencies.clock ?? (() => new Date())
  const kycProvider =
    dependencies.kycProvider ??
    new FakeKycProvider(
      config.kyc.sessionTtlMinutes * 60_000,
      clock,
      config.kyc.enableFakeTestRoutes
        ? config.kyc.publicApiBaseUrl
        : null,
    )
  const eligibility = new EvaluateEligibilityService(
    pool,
    restrictionRepository,
    new PostgresEligibilityDecisionRepository(),
    new PostgresAuditRepository(),
    kycStatuses,
    clock,
  )
  const getCurrentPlayer =
    dependencies.getCurrentPlayer ??
    new GetCurrentPlayerService(
      resolver,
      new EligibilityPermissionService(eligibility),
    )
  const getKycProfile = new GetKycProfileService(
    pool,
    new PostgresPlayerRepository(),
    kycProfiles,
    kycSessions,
    new PostgresAuditRepository(),
  )
  const startKycVerification = new StartKycVerificationService(
    pool,
    new PostgresPlayerRepository(),
    kycProfiles,
    kycSessions,
    kycTransitions,
    new PostgresAuditRepository(),
    eligibility,
    kycProvider,
    clock,
  )
  const requireIdentity = requireAuth0Identity(verifier, logger)

  const app = express()
  app.disable('x-powered-by')
  app.use(createRequestContextMiddleware(logger))
  app.use(createCorsMiddleware(config.cors.allowedOrigins))
  app.use(express.json({ limit: '100kb' }))

  app.use('/health', createHealthRouter(pool, logger))
  app.get('/health', (_request, response) => {
    response.setHeader('Deprecation', 'true')
    response.setHeader('Link', '</health/live>; rel="successor-version"')
    response.status(200).json({ status: 'live', service: 'nines-api' })
  })
  app.use(
    '/v1',
    createV1Router({
      requireIdentity,
      getCurrentPlayer,
      resolvePlayer: resolver,
      getKycProfile,
      startKycVerification,
    }),
  )
  app.use('/auth', createAuthRoutes(requireIdentity, getCurrentPlayer))
  if (isMockHostedKycEnabled(config)) {
    if (!config.kyc.publicApiBaseUrl) {
      throw new Error(
        'Hosted mock KYC routes require PUBLIC_API_BASE_URL',
      )
    }
    const mockHostedKyc =
      dependencies.mockHostedKyc ??
      (() => {
        if (!(kycProvider instanceof FakeKycProvider)) {
          throw new Error('Hosted mock KYC routes require the fake provider')
        }
        const processKycProviderEvent = new ProcessKycProviderEventService(
          pool,
          kycProfiles,
          kycSessions,
          new PostgresKycProviderEventRepository(),
          kycTransitions,
          new PostgresAuditRepository(),
          kycProvider,
          config.kyc.verificationTtlDays * 24 * 60 * 60_000,
          clock,
        )
        return new MockHostedKycService(
          pool,
          kycSessions,
          kycProfiles,
          kycProvider,
          processKycProviderEvent,
          clock,
        )
      })()
    app.use(
      '/dev/kyc/mock',
      createMockKycRouter(mockHostedKyc),
    )
  }
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

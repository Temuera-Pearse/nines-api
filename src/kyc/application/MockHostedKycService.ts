import type { Pool } from 'pg'
import { AppError } from '../../shared/http/AppError.js'
import type { KycSession } from '../domain/KycSession.js'
import type { KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycSessionRepository } from '../infrastructure/KycSessionRepository.js'
import type { FakeKycProvider } from '../providers/FakeKycProvider.js'
import type {
  ProcessKycProviderEventResult,
  ProcessKycProviderEventService,
} from './ProcessKycProviderEventService.js'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type MockKycOutcome = 'pass' | 'fail'

export interface MockHostedKycState {
  sessionId: string
  sessionStatus: KycSession['status']
  kycStatus: 'pending' | 'verified' | 'failed'
  expiresAt: Date | null
  verifiedAt: Date | null
}

export interface MockHostedKycOutcomeResult extends MockHostedKycState {
  outcome: MockKycOutcome
  processingStatus: ProcessKycProviderEventResult['processingStatus']
}

interface LoadedSession {
  session: KycSession
  profile: NonNullable<
    Awaited<ReturnType<KycProfileRepository['findForPlayer']>>
  >
}

export class MockHostedKycService {
  constructor(
    private readonly pool: Pool,
    private readonly sessions: KycSessionRepository,
    private readonly profiles: KycProfileRepository,
    private readonly provider: FakeKycProvider,
    private readonly processProviderEvent: ProcessKycProviderEventService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async requirePendingSession(sessionId: string): Promise<MockHostedKycState> {
    const loaded = await this.load(sessionId)
    this.assertCurrent(loaded)
    if (
      loaded.session.expiresAt &&
      loaded.session.expiresAt.getTime() <= this.clock().getTime()
    ) {
      throw new AppError({
        status: 410,
        code: 'KYC_SESSION_EXPIRED',
        message: 'KYC verification session has expired',
        publicMessage: 'This verification session has expired',
      })
    }
    if (
      loaded.session.status !== 'pending' ||
      loaded.profile.status !== 'pending'
    ) {
      throw new AppError({
        status: 409,
        code: 'KYC_SESSION_NOT_PENDING',
        message: 'KYC verification session is not pending',
        publicMessage: 'This verification session is no longer available',
      })
    }
    return this.safeState(loaded)
  }

  async submitOutcome(
    sessionId: string,
    outcome: MockKycOutcome,
    correlationId: string,
  ): Promise<MockHostedKycOutcomeResult> {
    const loaded = await this.load(sessionId)
    this.assertCurrent(loaded)
    const expectedStatus = outcome === 'pass' ? 'verified' : 'failed'

    if (
      loaded.session.status === expectedStatus &&
      loaded.profile.status === expectedStatus
    ) {
      return {
        ...this.safeState(loaded),
        outcome,
        processingStatus: 'ignored_duplicate',
      }
    }

    if (
      loaded.session.expiresAt &&
      loaded.session.expiresAt.getTime() <= this.clock().getTime()
    ) {
      throw new AppError({
        status: 410,
        code: 'KYC_SESSION_EXPIRED',
        message: 'KYC verification session has expired',
        publicMessage: 'This verification session has expired',
      })
    }
    if (
      loaded.session.status !== 'pending' ||
      loaded.profile.status !== 'pending' ||
      !loaded.session.providerSessionReference
    ) {
      throw new AppError({
        status: 409,
        code: 'KYC_SESSION_NOT_PENDING',
        message: 'KYC verification session is not pending',
        publicMessage: 'This verification session is no longer available',
      })
    }

    const processed = await this.processProviderEvent.execute(
      {
        payload: this.provider.buildEvent({
          providerEventId: `mock-hosted-${sessionId}-${outcome}`,
          providerSessionReference: loaded.session.providerSessionReference,
          resultingStatus: expectedStatus,
          occurredAt: this.clock(),
          metadata: { source: 'mock_hosted_page' },
        }),
      },
      {
        actorType: 'PROVIDER',
        actorId: 'mock_hosted_page',
        correlationId,
      },
    )
    const finalState = await this.load(sessionId)
    return {
      ...this.safeState(finalState),
      outcome,
      processingStatus: processed.processingStatus,
    }
  }

  private async load(sessionId: string): Promise<LoadedSession> {
    if (!UUID.test(sessionId)) {
      throw new AppError({
        status: 404,
        code: 'KYC_SESSION_NOT_FOUND',
        message: 'KYC verification session was not found',
      })
    }
    const session = await this.sessions.findById(sessionId, this.pool)
    if (!session || session.provider !== this.provider.providerName) {
      throw new AppError({
        status: 404,
        code: 'KYC_SESSION_NOT_FOUND',
        message: 'KYC verification session was not found',
      })
    }
    const profile = await this.profiles.findForPlayer(
      session.playerId,
      this.pool,
    )
    if (!profile) {
      throw new AppError({
        status: 404,
        code: 'KYC_SESSION_NOT_FOUND',
        message: 'KYC verification session was not found',
      })
    }
    return { session, profile }
  }

  private assertCurrent(loaded: LoadedSession): void {
    if (loaded.profile.currentSessionId !== loaded.session.id) {
      throw new AppError({
        status: 409,
        code: 'KYC_SESSION_SUPERSEDED',
        message: 'KYC verification session was superseded',
        publicMessage: 'A newer verification session is active',
      })
    }
  }

  private safeState(loaded: LoadedSession): MockHostedKycState {
    const status = loaded.profile.status
    if (status !== 'pending' && status !== 'verified' && status !== 'failed') {
      throw new AppError({
        status: 409,
        code: 'KYC_SESSION_NOT_PENDING',
        message: 'KYC verification session has an unsupported state',
        publicMessage: 'This verification session is no longer available',
      })
    }
    return {
      sessionId: loaded.session.id,
      sessionStatus: loaded.session.status,
      kycStatus: status,
      expiresAt: loaded.session.expiresAt,
      verifiedAt: loaded.profile.verifiedAt,
    }
  }
}

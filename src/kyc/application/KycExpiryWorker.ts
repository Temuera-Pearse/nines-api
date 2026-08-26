import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { PostgresAuditRepository } from '../../audit/PostgresAuditRepository.js'
import type { AppLogger } from '../../shared/observability/logger.js'
import { PostgresKycManualReviewRepository } from '../infrastructure/PostgresKycManualReviewRepository.js'
import { PostgresKycProfileRepository } from '../infrastructure/PostgresKycProfileRepository.js'
import { PostgresKycSessionRepository } from '../infrastructure/PostgresKycSessionRepository.js'
import { PostgresKycStatusTransitionRepository } from '../infrastructure/PostgresKycStatusTransitionRepository.js'
import { ExpireKycSessionsService } from './ExpireKycSessionsService.js'
import { TransitionKycStatusService } from './TransitionKycStatusService.js'

const DEFAULT_POLL_INTERVAL_MS = 60_000
const DEFAULT_BATCH_SIZE = 100

export class KycExpiryWorker {
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly expiry: ExpireKycSessionsService,
    private readonly logger: AppLogger,
    private readonly clock: () => Date = () => new Date(),
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return
    this.runOnce()
    this.timer = setInterval(() => this.runOnce(), this.pollIntervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.inFlight
  }

  private runOnce(): void {
    if (this.inFlight) return
    const correlationId = `kyc-expiry-${randomUUID()}`
    this.inFlight = this.expiry
      .execute(this.clock(), {
        actorType: 'SYSTEM',
        actorId: 'kyc_expiry_worker',
        correlationId,
      })
      .then((result) => {
        if (result.failures.length) {
          this.logger.error({
            event: 'kyc_expiry_batch_partial_failure',
            correlationId,
            failures: result.failures,
          })
        }
        if (
          result.sessionsExamined ||
          result.profilesExamined
        ) {
          this.logger.info({
            event: 'kyc_expiry_batch_completed',
            correlationId,
            expiredSessionCount: result.expiredSessionIds.length,
            expiredProfileCount: result.expiredProfileIds.length,
            sessionsExamined: result.sessionsExamined,
            profilesExamined: result.profilesExamined,
            failures: result.failures,
          })
        }
      })
      .catch((error: unknown) => {
        this.logger.error({ event: 'kyc_expiry_batch_failed', correlationId, err: error })
      })
      .finally(() => {
        this.inFlight = null
      })
  }
}

export function createKycExpiryWorker(
  pool: Pool,
  logger: AppLogger,
  clock: () => Date = () => new Date(),
): KycExpiryWorker {
  const profiles = new PostgresKycProfileRepository()
  const sessions = new PostgresKycSessionRepository()
  const audit = new PostgresAuditRepository()
  const transition = new TransitionKycStatusService(
    profiles,
    new PostgresKycStatusTransitionRepository(),
    new PostgresKycManualReviewRepository(),
    audit,
    clock,
  )
  return new KycExpiryWorker(
    new ExpireKycSessionsService(
      pool,
      profiles,
      sessions,
      transition,
      audit,
      DEFAULT_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
    ),
    logger,
    clock,
  )
}

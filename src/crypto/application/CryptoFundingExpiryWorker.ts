import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { PostgresAuditRepository } from '../../audit/PostgresAuditRepository.js'
import type { AppLogger } from '../../shared/observability/logger.js'
import { PostgresCryptoFundingRepository } from '../infrastructure/PostgresCryptoFundingRepository.js'
import { ExpireCryptoFundingIntentsService } from './ExpireCryptoFundingIntentsService.js'
import { TransitionCryptoFundingService } from './TransitionCryptoFundingService.js'

const POLL_INTERVAL_MS = 60_000

export class CryptoFundingExpiryWorker {
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  constructor(private readonly service: ExpireCryptoFundingIntentsService,
    private readonly logger: AppLogger, private readonly clock: () => Date = () => new Date(),
    private readonly pollIntervalMs = POLL_INTERVAL_MS) {}
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
    const correlationId = `crypto-expiry-${randomUUID()}`
    this.inFlight = this.service.execute(this.clock(), { actorType: 'SYSTEM', actorId: 'crypto_funding_expiry_worker', correlationId })
      .then((result) => {
        if (result.examined) this.logger.info({ event: 'crypto_funding_expiry_batch_completed', correlationId, ...result })
      })
      .catch((error: unknown) => this.logger.error({ event: 'crypto_funding_expiry_batch_failed', correlationId, err: error }))
      .finally(() => { this.inFlight = null })
  }
}

export function createCryptoFundingExpiryWorker(pool: Pool, logger: AppLogger,
  clock: () => Date = () => new Date()): CryptoFundingExpiryWorker {
  const repository = new PostgresCryptoFundingRepository()
  const audit = new PostgresAuditRepository()
  const transitions = new TransitionCryptoFundingService(repository, audit, clock)
  return new CryptoFundingExpiryWorker(
    new ExpireCryptoFundingIntentsService(pool, repository, transitions, audit), logger, clock,
  )
}

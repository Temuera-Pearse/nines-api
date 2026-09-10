import { createServer, type Server } from 'node:http'
import { createApp } from './app.js'
import { loadConfig } from './config/config.js'
import { checkDatabaseHealth } from './shared/db/health.js'
import { closeDatabasePool, createDatabasePool } from './shared/db/pool.js'
import { createLogger } from './shared/observability/logger.js'
import { createKycExpiryWorker } from './kyc/application/KycExpiryWorker.js'
import { createCryptoFundingExpiryWorker } from './crypto/application/CryptoFundingExpiryWorker.js'
import { FundingAttestationDeliveryWorker } from './crypto/application/FundingAttestationDeliveryWorker.js'
import { SecurityEvidenceDeliveryWorker } from './shared/outbox/SecurityEvidenceDeliveryWorker.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeIdleConnections?.()
  })
}

async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.database.url) throw new Error('DATABASE_URL is required')
  const logger = createLogger(config.environment)
  const pool = createDatabasePool(config.database.url)
  let server: Server | null = null
  const expiryWorker = createKycExpiryWorker(pool, logger)
  const cryptoExpiryWorker = createCryptoFundingExpiryWorker(pool, logger)
  const fundingDeliveryWorker = config.serviceDelivery.fundingAttestationsEnabled
    ? new FundingAttestationDeliveryWorker(pool, config.serviceDelivery.financialBaseUrl!,
      config.environment, config.serviceDelivery.hmacSecret!, config.serviceDelivery.keyId,
      logger, config.serviceDelivery.pollIntervalMs) : null
  const securityEvidenceWorker = config.serviceDelivery.securityEvidenceEnabled
    ? new SecurityEvidenceDeliveryWorker(pool, config.serviceDelivery.securityBaseUrl!,
      config.environment, config.serviceDelivery.hmacSecret!, config.serviceDelivery.keyId,
      logger, config.serviceDelivery.pollIntervalMs) : null

  try {
    await checkDatabaseHealth(pool)
    const app = createApp({ config, pool, logger })
    server = createServer(app)
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(config.port, resolve)
    })
    logger.info({ event: 'service_started', port: config.port, environment: config.environment })
    expiryWorker.start()
    cryptoExpiryWorker.start()
    fundingDeliveryWorker?.start()
    securityEvidenceWorker?.start()

    let shuttingDown = false
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      logger.info({ event: 'service_shutdown_started', signal })

      const timeout = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Graceful shutdown timed out')), SHUTDOWN_TIMEOUT_MS)
        timer.unref()
      })
      try {
        await Promise.race([
          (async () => {
            if (server) await closeHttpServer(server)
            await expiryWorker.stop()
            await cryptoExpiryWorker.stop()
            await fundingDeliveryWorker?.stop()
            await securityEvidenceWorker?.stop()
            await closeDatabasePool(pool)
          })(),
          timeout,
        ])
        logger.info({ event: 'service_shutdown_completed' })
      } catch (error) {
        logger.error({ event: 'service_shutdown_failed', err: error })
        server?.closeAllConnections?.()
        process.exit(1)
      }
    }

    process.once('SIGTERM', () => void shutdown('SIGTERM'))
    process.once('SIGINT', () => void shutdown('SIGINT'))
  } catch (error) {
    await expiryWorker.stop().catch(() => undefined)
    await cryptoExpiryWorker.stop().catch(() => undefined)
    await fundingDeliveryWorker?.stop().catch(() => undefined)
    await securityEvidenceWorker?.stop().catch(() => undefined)
    await closeDatabasePool(pool).catch(() => undefined)
    throw error
  }
}

void main().catch((error: unknown) => {
  const logger = createLogger('development')
  logger.fatal({ event: 'service_startup_failed', err: error })
  process.exitCode = 1
})

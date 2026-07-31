import { Router } from 'express'
import type { Pool } from 'pg'
import { checkDatabaseHealth } from '../shared/db/health.js'
import type { AppLogger } from '../shared/observability/logger.js'

export function createHealthRouter(pool: Pool, logger: AppLogger): Router {
  const router = Router()

  const liveResponse = { status: 'live', service: 'nines-api' } as const
  router.get('/live', (_request, response) => response.status(200).json(liveResponse))

  router.get('/ready', async (_request, response) => {
    try {
      await checkDatabaseHealth(pool, 1_000)
      response.status(200).json({ status: 'ready', service: 'nines-api' })
    } catch (error) {
      logger.error({ event: 'database_readiness_failed', err: error })
      response.status(503).json({ status: 'not_ready', service: 'nines-api' })
    }
  })
  return router
}

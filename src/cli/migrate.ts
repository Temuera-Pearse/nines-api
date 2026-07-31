import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config/config.js'
import { createLogger } from '../shared/observability/logger.js'
import { closeDatabasePool, createDatabasePool } from '../shared/db/pool.js'
import { runMigrations } from '../shared/db/migrations.js'

async function main(): Promise<void> {
  const useTestDatabase = process.argv.includes('--test')
  const source = useTestDatabase
    ? { ...process.env, NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL }
    : process.env
  const config = loadConfig(source, { requireDatabase: true })
  if (!config.database.url) throw new Error('DATABASE_URL is required')
  const logger = createLogger(config.environment)
  const pool = createDatabasePool(config.database.url)
  const migrationsDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../db/migrations',
  )

  try {
    const result = await runMigrations(pool, migrationsDirectory)
    logger.info({ event: 'database_migrations_completed', ...result })
  } finally {
    await closeDatabasePool(pool)
  }
}

void main().catch((error: unknown) => {
  const logger = createLogger('development')
  logger.fatal({ event: 'database_migration_failed', err: error })
  process.exitCode = 1
})

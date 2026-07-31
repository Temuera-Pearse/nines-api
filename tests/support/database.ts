import path from 'node:path'
import { Pool } from 'pg'
import { runMigrations } from '../../src/shared/db/migrations.js'

export function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim()
  if (!value) throw new Error('TEST_DATABASE_URL is required for database integration tests')
  const databaseName = new URL(value).pathname.slice(1)
  if (!databaseName.endsWith('_test')) {
    throw new Error('Integration test database name must end in _test')
  }
  return value
}

export function createTestPool(): Pool {
  return new Pool({
    connectionString: requireTestDatabaseUrl(),
    max: 10,
    connectionTimeoutMillis: 3_000,
  })
}

export async function resetAndMigrateTestDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS kyc_status_transitions CASCADE')
  await pool.query('DROP TABLE IF EXISTS kyc_provider_events CASCADE')
  await pool.query('DROP TABLE IF EXISTS player_kyc_profiles CASCADE')
  await pool.query('DROP TABLE IF EXISTS kyc_verification_sessions CASCADE')
  await pool.query('DROP TABLE IF EXISTS eligibility_decisions CASCADE')
  await pool.query('DROP TABLE IF EXISTS player_restrictions CASCADE')
  await pool.query('DROP TABLE IF EXISTS player_account_status_transitions CASCADE')
  await pool.query('DROP TABLE IF EXISTS audit_events CASCADE')
  await pool.query('DROP TABLE IF EXISTS authentication_identities CASCADE')
  await pool.query('DROP TABLE IF EXISTS players CASCADE')
  await pool.query('DROP TABLE IF EXISTS nines_api_schema_migrations CASCADE')
  await runMigrations(pool, path.resolve(process.cwd(), 'db/migrations'))
}

export async function truncatePhase1Tables(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE
       eligibility_decisions,
       kyc_status_transitions,
       kyc_provider_events,
       player_kyc_profiles,
       kyc_verification_sessions,
       player_restrictions,
       player_account_status_transitions,
       audit_events,
       authentication_identities,
       players`,
  )
}

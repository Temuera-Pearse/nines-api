import { Pool, type PoolConfig } from 'pg'

export function createDatabasePool(connectionString: string): Pool {
  const config: PoolConfig = {
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    application_name: 'nines-api',
  }
  return new Pool(config)
}

export async function closeDatabasePool(pool: Pool): Promise<void> {
  await pool.end()
}

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'

const MIGRATION_LOCK_ID = 6_709_282_401

interface AppliedMigrationRow {
  filename: string
  checksum: string
}

export interface MigrationResult {
  applied: string[]
  alreadyApplied: string[]
}

export async function runMigrations(pool: Pool, directory: string): Promise<MigrationResult> {
  const entries = await readdir(directory, { withFileTypes: true })
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  const client = await pool.connect()
  const result: MigrationResult = { applied: [], alreadyApplied: [] }
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await client.query(`
      CREATE TABLE IF NOT EXISTS nines_api_schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const appliedResult = await client.query<AppliedMigrationRow>(
      'SELECT filename, checksum FROM nines_api_schema_migrations',
    )
    const applied = new Map(appliedResult.rows.map((row) => [row.filename, row.checksum]))

    for (const filename of filenames) {
      const sql = await readFile(path.join(directory, filename), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const existingChecksum = applied.get(filename)
      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          throw new Error(`Applied migration checksum does not match: ${filename}`)
        }
        result.alreadyApplied.push(filename)
        continue
      }

      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query(
          'INSERT INTO nines_api_schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum],
        )
        await client.query('COMMIT')
        result.applied.push(filename)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    return result
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined)
    client.release()
  }
}

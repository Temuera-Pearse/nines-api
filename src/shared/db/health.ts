import type { Pool } from 'pg'

export async function checkDatabaseHealth(pool: Pool, timeoutMs = 1_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      pool.query<{
        players: string | null
        identities: string | null
        audit: string | null
      }>(`SELECT
          to_regclass('public.players')::text AS players,
          to_regclass('public.authentication_identities')::text AS identities,
          to_regclass('public.audit_events')::text AS audit`),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Database health check timed out')), timeoutMs)
        timer.unref()
      }),
    ]).then((result) => {
      if (!result.rows[0]?.players || !result.rows[0]?.identities || !result.rows[0]?.audit) {
        throw new Error('Required Phase 1 database schema is not available')
      }
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

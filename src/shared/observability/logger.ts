import pino, { type Logger } from 'pino'

const REDACTED_PATHS = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'accessToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'config.database.url',
]

export type AppLogger = Logger

export function createLogger(environment: string): AppLogger {
  return pino({
    name: 'nines-api',
    level: environment === 'test' ? 'silent' : 'info',
    base: { service: 'nines-api' },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  })
}

export function createSilentLogger(): AppLogger {
  return pino({ level: 'silent' })
}

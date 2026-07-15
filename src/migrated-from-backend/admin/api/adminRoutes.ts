import { Router } from 'express'
import { engineMetrics } from '../metrics/engineMetrics.js'
import { activeRaces } from '../race/activeRaceMemory.js'
import { RaceState } from '../race/raceState.js'
import type { RacePhase } from '../race/stateMachine.js'
import { isDatabaseConfigured } from '../db/pool.js'

type PlatformModeKey =
  | 'licensedMode'
  | 'realMoneyEnabled'
  | 'bettingEnabled'
  | 'depositsEnabled'
  | 'withdrawalsEnabled'
  | 'maintenanceMode'
  | 'readOnlyMode'

type RaceOverview = {
  currentRaceId: string | null
  lifecycleStatus: RacePhase | 'unknown'
  status: RacePhase | 'unknown'
  scheduledStartTime: string | null
  actualStartTime: string | null
  expectedFinishTime: string | null
  winnerId: string | null
  connectedWebsocketClients: number | null
  lastTickTime: string | null
  degraded: boolean
  degradedFlags: string[]
  source: 'race_engine'
  timestamp: string
}

const router = Router()

const platformModeDescriptions: Record<PlatformModeKey, string> = {
  licensedMode: 'Licensed operations gate',
  realMoneyEnabled: 'Real-money operation gate',
  bettingEnabled: 'Bet acceptance gate',
  depositsEnabled: 'Deposit workflow gate',
  withdrawalsEnabled: 'Withdrawal workflow gate',
  maintenanceMode: 'Operator maintenance mode',
  readOnlyMode: 'Backend read-only mode',
}

const platformModeEnvKeys: Record<PlatformModeKey, string[]> = {
  licensedMode: ['NINES_LICENSED_MODE', 'LICENSED_MODE'],
  realMoneyEnabled: ['NINES_REAL_MONEY_ENABLED', 'REAL_MONEY_ENABLED'],
  bettingEnabled: ['NINES_BETTING_ENABLED', 'BETTING_ENABLED'],
  depositsEnabled: ['NINES_DEPOSITS_ENABLED', 'DEPOSITS_ENABLED'],
  withdrawalsEnabled: ['NINES_WITHDRAWALS_ENABLED', 'WITHDRAWALS_ENABLED'],
  maintenanceMode: ['NINES_MAINTENANCE_MODE', 'MAINTENANCE_MODE'],
  readOnlyMode: ['NINES_READ_ONLY_MODE', 'READ_ONLY_MODE'],
}

function booleanFromEnv(keys: string[]): boolean {
  for (const key of keys) {
    const raw = process.env[key]
    if (raw === undefined) continue
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
  }
  return false
}

function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

function scheduledStartFromCycle(second: number): string | null {
  if (!Number.isFinite(second)) return null
  const now = new Date()
  const scheduled = new Date(now)
  scheduled.setUTCSeconds(30, 0)
  if (second > 30) {
    scheduled.setUTCMinutes(scheduled.getUTCMinutes() + 1)
  }
  return scheduled.toISOString()
}

function expectedFinishTime(
  scheduledStartTime: string | null,
  actualStartTime: string | null,
  durationMs: unknown,
): string | null {
  const start = actualStartTime ?? scheduledStartTime
  if (!start) return null
  const duration = Number(durationMs)
  if (!Number.isFinite(duration) || duration <= 0) return null
  return new Date(new Date(start).getTime() + duration).toISOString()
}

function lastTickTimeForRace(raceId: string | null): string | null {
  if (!raceId) return null
  const activeRace = activeRaces.get(raceId)
  if (!activeRace || activeRace.currentTickIndex < 0) return null
  const tick = activeRace.ticks[activeRace.currentTickIndex]
  return toIsoTimestamp(tick?.tickTs)
}

export function buildRaceOverview(now = new Date()): RaceOverview {
  const degradedFlags: string[] = []
  let phase: RacePhase | 'unknown' = 'unknown'
  let second = Number.NaN

  try {
    const state = RaceState.getStateMachine().getPhaseAndSecond()
    phase = state.phase
    second = state.second
  } catch {
    degradedFlags.push('race_state_machine_unavailable')
  }

  const precomputed = RaceState.getPrecomputedRace()
  const currentRace = RaceState.getCurrentRace()
  const currentRaceId = precomputed?.id ?? currentRace?.id ?? null

  if (!currentRaceId) {
    degradedFlags.push('race_engine_state_missing')
  }

  let metrics: ReturnType<typeof engineMetrics.getMetrics> | null = null
  try {
    metrics = engineMetrics.getMetrics()
  } catch {
    degradedFlags.push('engine_metrics_unavailable')
  }

  const scheduledStartTime =
    toIsoTimestamp(precomputed?.startTime) ?? scheduledStartFromCycle(second)
  const actualStartTime = toIsoTimestamp(precomputed?.startTime)
  const configuredDurationMs = precomputed?.config?.durationMs
  const expectedFinish =
    toIsoTimestamp(precomputed?.endTime) ??
    expectedFinishTime(scheduledStartTime, actualStartTime, configuredDurationMs)
  const winnerVisible =
    phase === 'race_finished' ||
    phase === 'results_showing' ||
    Boolean(precomputed?.endTime) ||
    Boolean(precomputed?.authoritativeFinish)

  return {
    currentRaceId,
    lifecycleStatus: phase,
    status: phase,
    scheduledStartTime,
    actualStartTime,
    expectedFinishTime: expectedFinish,
    winnerId: winnerVisible
      ? precomputed?.authoritativeFinish?.winnerId ?? precomputed?.winnerId ?? null
      : null,
    connectedWebsocketClients: metrics?.ws.clientCount ?? null,
    lastTickTime: lastTickTimeForRace(currentRaceId),
    degraded: degradedFlags.length > 0,
    degradedFlags,
    source: 'race_engine',
    timestamp: now.toISOString(),
  }
}

export function buildPlatformModes() {
  const modes = Object.entries(platformModeDescriptions).map(
    ([key, description]) => {
      const modeKey = key as PlatformModeKey
      return {
        key: modeKey,
        enabled: booleanFromEnv(platformModeEnvKeys[modeKey]),
        description,
        source: 'backend_env' as const,
      }
    },
  )

  return {
    source: 'backend_env' as const,
    modes: Object.fromEntries(modes.map((mode) => [mode.key, mode.enabled])),
    platformModes: modes,
    timestamp: new Date().toISOString(),
  }
}

router.get('/health', (_req, res) => {
  let metrics: ReturnType<typeof engineMetrics.getMetrics> | null = null
  try {
    metrics = engineMetrics.getMetrics()
  } catch {
    metrics = null
  }

  const status = metrics ? 'ok' : 'degraded'
  res.json({
    serviceName: 'nines-back-end',
    service: 'race_backend',
    status,
    uptimeSeconds: process.uptime(),
    timestamp: new Date().toISOString(),
    raceEngine: {
      status,
      startedAt: metrics?.startedAt ?? null,
      tickRate: metrics?.tickRate ?? null,
      ticksTotal: metrics?.ticksTotal ?? null,
    },
    websocket: {
      status: metrics ? 'ok' : 'degraded',
      connectedClients: metrics?.ws.clientCount ?? null,
      droppedTickFrames: metrics?.ws.droppedTickFrames ?? null,
    },
    database: {
      status: isDatabaseConfigured() ? 'configured' : 'not_configured',
      checked: false,
      reason: isDatabaseConfigured()
        ? 'Database URL is configured; no active health query was run.'
        : 'DATABASE_URL is not configured.',
    },
  })
})

router.get('/race/overview', (_req, res) => {
  res.json(buildRaceOverview())
})

router.get('/platform-modes', (_req, res) => {
  res.json(buildPlatformModes())
})

router.get('/discrepancies/summary', (_req, res) => {
  res.json({
    source: 'placeholder',
    notImplemented: true,
    openCount: 0,
    incidentCount: 0,
    warningCount: 0,
    byStatus: {},
    bySeverity: {},
    timestamp: new Date().toISOString(),
    note: 'No nines-back-end discrepancy domain exists yet; counts are intentionally empty.',
  })
})

export default router

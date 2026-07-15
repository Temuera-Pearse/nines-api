import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import adminRoutes from './adminRoutes.js'
import { RaceState } from '../race/raceState.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', adminRoutes)
  return app
}

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  for (const key of [
    'NINES_LICENSED_MODE',
    'LICENSED_MODE',
    'NINES_REAL_MONEY_ENABLED',
    'REAL_MONEY_ENABLED',
    'NINES_BETTING_ENABLED',
    'BETTING_ENABLED',
    'NINES_DEPOSITS_ENABLED',
    'DEPOSITS_ENABLED',
    'NINES_WITHDRAWALS_ENABLED',
    'WITHDRAWALS_ENABLED',
    'NINES_MAINTENANCE_MODE',
    'MAINTENANCE_MODE',
    'NINES_READ_ONLY_MODE',
    'READ_ONLY_MODE',
  ]) {
    delete process.env[key]
  }
})

afterEach(() => {
  process.env = savedEnv
  vi.restoreAllMocks()
})

describe('admin read-only operational routes', () => {
  it('GET /admin/health returns service and subsystem status', async () => {
    const res = await request(makeApp()).get('/admin/health')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      serviceName: 'nines-back-end',
      service: 'race_backend',
      status: 'ok',
      raceEngine: {
        status: 'ok',
      },
      websocket: {
        status: 'ok',
      },
      database: {
        checked: false,
      },
    })
    expect(typeof res.body.uptimeSeconds).toBe('number')
    expect(typeof res.body.timestamp).toBe('string')
  })

  it('GET /admin/race/overview exposes safe operational race data', async () => {
    const startTime = new Date('2026-05-08T00:00:30.000Z')
    vi.spyOn(RaceState, 'getStateMachine').mockReturnValue({
      getPhaseAndSecond: () => ({ phase: 'results_showing', second: 55 }),
    } as any)
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue({
      id: 'race-admin-1',
      config: {
        trackLength: 1000,
        finishRatio: 0.9,
        durationMs: 20_000,
        dtMs: 50,
        seed: 'hidden-seed',
      },
      horses: [],
      ticks: [],
      finishLine: 900,
      winnerId: 'horse-7',
      finishOrder: ['horse-7'],
      finishTimesMs: { 'horse-7': 12_000 },
      finishTickIndex: { 'horse-7': 240 },
      startTime,
    } as any)
    vi.spyOn(RaceState, 'getCurrentRace').mockReturnValue(null)

    const res = await request(makeApp()).get('/admin/race/overview')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      currentRaceId: 'race-admin-1',
      lifecycleStatus: 'results_showing',
      status: 'results_showing',
      scheduledStartTime: '2026-05-08T00:00:30.000Z',
      actualStartTime: '2026-05-08T00:00:30.000Z',
      expectedFinishTime: '2026-05-08T00:00:50.000Z',
      winnerId: 'horse-7',
      degraded: false,
      degradedFlags: [],
      source: 'race_engine',
    })
    expect(typeof res.body.connectedWebsocketClients).toBe('number')
  })

  it('GET /admin/race/overview hides winner before finish', async () => {
    vi.spyOn(RaceState, 'getStateMachine').mockReturnValue({
      getPhaseAndSecond: () => ({ phase: 'countdown', second: 28 }),
    } as any)
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue({
      id: 'race-admin-2',
      config: { durationMs: 20_000 },
      winnerId: 'horse-secret',
    } as any)
    vi.spyOn(RaceState, 'getCurrentRace').mockReturnValue(null)

    const res = await request(makeApp()).get('/admin/race/overview')

    expect(res.status).toBe(200)
    expect(res.body.currentRaceId).toBe('race-admin-2')
    expect(res.body.lifecycleStatus).toBe('countdown')
    expect(res.body.winnerId).toBeNull()
  })

  it('GET /admin/race/overview marks degraded when race engine state is unavailable', async () => {
    vi.spyOn(RaceState, 'getStateMachine').mockImplementation(() => {
      throw new Error('state unavailable')
    })
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue(null)
    vi.spyOn(RaceState, 'getCurrentRace').mockReturnValue(null)

    const res = await request(makeApp()).get('/admin/race/overview')

    expect(res.status).toBe(200)
    expect(res.body.degraded).toBe(true)
    expect(res.body.degradedFlags).toContain(
      'race_state_machine_unavailable',
    )
    expect(res.body.degradedFlags).toContain('race_engine_state_missing')
  })

  it('GET /admin/platform-modes defaults all risky modes to false', async () => {
    const res = await request(makeApp()).get('/admin/platform-modes')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('backend_env')
    expect(res.body.modes).toEqual({
      licensedMode: false,
      realMoneyEnabled: false,
      bettingEnabled: false,
      depositsEnabled: false,
      withdrawalsEnabled: false,
      maintenanceMode: false,
      readOnlyMode: false,
    })
    expect(res.body.platformModes).toHaveLength(7)
  })

  it('GET /admin/platform-modes reads explicit backend-owned mode env', async () => {
    process.env.NINES_MAINTENANCE_MODE = 'true'
    process.env.NINES_READ_ONLY_MODE = '1'

    const res = await request(makeApp()).get('/admin/platform-modes')

    expect(res.status).toBe(200)
    expect(res.body.modes.maintenanceMode).toBe(true)
    expect(res.body.modes.readOnlyMode).toBe(true)
    expect(res.body.modes.realMoneyEnabled).toBe(false)
  })

  it('GET /admin/discrepancies/summary returns placeholder-safe empty counts', async () => {
    const res = await request(makeApp()).get('/admin/discrepancies/summary')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      source: 'placeholder',
      notImplemented: true,
      openCount: 0,
      incidentCount: 0,
      warningCount: 0,
      byStatus: {},
      bySeverity: {},
    })
  })

  it('does not expose admin write methods', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(makeApp())[method]('/admin/platform-modes')
      expect(res.status).toBe(404)
    }
  })
})

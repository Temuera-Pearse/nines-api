import { describe, expect, it } from 'vitest'
import type { PlayerRestriction } from './Restriction.js'
import { isRestrictionActive } from './Restriction.js'

function restriction(overrides: Partial<PlayerRestriction> = {}): PlayerRestriction {
  return {
    id: 'restriction',
    playerId: 'player',
    type: 'wagering_blocked',
    status: 'active',
    reasonCode: 'TEST',
    source: 'test',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

describe('restriction activity', () => {
  const now = new Date('2026-01-02T00:00:00Z')

  it('recognizes currently effective restrictions', () => {
    expect(isRestrictionActive(restriction(), now)).toBe(true)
  })

  it('does not apply scheduled, expired, or manually removed restrictions', () => {
    expect(
      isRestrictionActive(
        restriction({ startsAt: new Date('2026-01-03T00:00:00Z') }),
        now,
      ),
    ).toBe(false)
    expect(
      isRestrictionActive(
        restriction({ endsAt: new Date('2026-01-02T00:00:00Z') }),
        now,
      ),
    ).toBe(false)
    expect(isRestrictionActive(restriction({ status: 'removed' }), now)).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { EvaluateEligibilityService } from '../eligibility/application/EvaluateEligibilityService.js'
import { ELIGIBILITY_POLICY_VERSION } from '../eligibility/domain/EligibilityDecision.js'
import type { PlayerOperation } from '../eligibility/domain/PlayerOperation.js'
import type { Player } from '../players/domain/Player.js'
import { EligibilityPermissionService } from './EligibilityPermissionService.js'

const player: Player = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  displayName: null,
  accountStatus: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  version: 1,
}

describe('eligibility permission calculation', () => {
  it('derives every permission from typed eligibility evaluations', async () => {
    const execute = vi.fn(async ({ operation }: { operation: PlayerOperation }) => ({
      decisionId: `decision-${operation}`,
      playerId: player.id,
      operation,
      allowed: operation !== 'withdraw',
      reasonCodes: operation === 'withdraw' ? ['WITHDRAWALS_BLOCKED' as const] : [],
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      evaluatedAt: new Date('2026-01-01T00:00:00Z'),
      inputSnapshot: {
        accountStatus: 'active',
        kycStatus: 'verified',
        activeRestrictionTypes: [],
      },
    }))
    const service = new EligibilityPermissionService(
      { execute } as unknown as EvaluateEligibilityService,
    )

    await expect(
      service.forPlayer(player, { correlationId: 'corr-permissions', actorId: 'auth0|one' }),
    ).resolves.toEqual({
      kycStatus: 'verified',
      permissions: {
        viewRaces: true,
        usePracticeBalance: true,
        deposit: true,
        withdraw: false,
        placeWager: true,
        startKyc: true,
        manageProfile: true,
      },
    })
    expect(execute).toHaveBeenCalledTimes(6)
    expect(execute.mock.calls.map(([input]) => input.operation)).toEqual([
      'view_races',
      'deposit',
      'withdraw',
      'place_wager',
      'start_kyc',
      'manage_profile',
    ])
  })
})

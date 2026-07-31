import type { EvaluateEligibilityService } from '../eligibility/application/EvaluateEligibilityService.js'
import type { PlayerOperation } from '../eligibility/domain/PlayerOperation.js'
import { isKycStatus } from '../kyc/domain/KycStatus.js'
import type { Player } from '../players/domain/Player.js'
import type {
  PermissionEvaluationContext,
  PermissionService,
  PlayerPermissionEvaluation,
} from './PermissionService.js'

const PERMISSION_OPERATIONS = [
  'view_races',
  'deposit',
  'withdraw',
  'place_wager',
  'start_kyc',
  'manage_profile',
] as const satisfies readonly PlayerOperation[]

export class EligibilityPermissionService implements PermissionService {
  constructor(
    private readonly eligibility: EvaluateEligibilityService,
  ) {}

  async forPlayer(
    player: Player,
    context: PermissionEvaluationContext,
  ): Promise<PlayerPermissionEvaluation> {
    const evaluations = await Promise.all(
      PERMISSION_OPERATIONS.map((operation) =>
        this.eligibility.execute(
          { player, operation },
          {
            actorType: 'external_identity',
            actorId: context.actorId,
            correlationId: context.correlationId,
            purpose: 'permission_projection',
          },
        ),
      ),
    )
    const allowed = Object.fromEntries(
      evaluations.map((decision) => [decision.operation, decision.allowed]),
    ) as Record<PlayerOperation, boolean>
    const evaluatedKycStatus = evaluations[0]?.inputSnapshot.kycStatus
    const kycStatus = isKycStatus(evaluatedKycStatus)
      ? evaluatedKycStatus
      : 'not_started'

    return {
      kycStatus,
      permissions: {
        viewRaces: allowed.view_races,
        // Practice wagering follows the same player-safety gate as wager placement.
        usePracticeBalance: allowed.place_wager,
        deposit: allowed.deposit,
        withdraw: allowed.withdraw,
        placeWager: allowed.place_wager,
        startKyc: allowed.start_kyc,
        manageProfile: allowed.manage_profile,
      },
    }
  }
}

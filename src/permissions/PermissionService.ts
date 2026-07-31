import type { Player } from '../players/domain/Player.js'
import type { KycStatus } from '../kyc/domain/KycStatus.js'

export interface PlayerPermissions {
  viewRaces: boolean
  usePracticeBalance: boolean
  deposit: boolean
  withdraw: boolean
  placeWager: boolean
  startKyc: boolean
  manageProfile: boolean
}

export interface PermissionEvaluationContext {
  correlationId: string
  actorId: string | null
}

export interface PlayerPermissionEvaluation {
  kycStatus: KycStatus
  permissions: PlayerPermissions
}

export interface PermissionService {
  forPlayer(
    player: Player,
    context: PermissionEvaluationContext,
  ): Promise<PlayerPermissionEvaluation>
}

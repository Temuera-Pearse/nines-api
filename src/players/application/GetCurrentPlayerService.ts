import type { AuthenticatedIdentity } from '../../auth/AuthenticatedIdentity.js'
import type { PermissionService, PlayerPermissions } from '../../permissions/PermissionService.js'
import type { KycStatus } from '../../kyc/domain/KycStatus.js'
import type { AccountStatus } from '../domain/AccountStatus.js'
import type { ResolveOrCreatePlayerService } from './ResolveOrCreatePlayerService.js'

export interface CurrentPlayerResponse {
  playerId: string
  email: string | null
  displayName: string | null
  accountStatus: AccountStatus
  kycStatus: KycStatus
  permissions: PlayerPermissions
}

export class GetCurrentPlayerService {
  constructor(
    private readonly playerResolver: ResolveOrCreatePlayerService,
    private readonly permissions: PermissionService,
  ) {}

  async execute(
    identity: AuthenticatedIdentity,
    correlationId: string,
  ): Promise<CurrentPlayerResponse> {
    const { player } = await this.playerResolver.execute(identity, { correlationId })
    const evaluation = await this.permissions.forPlayer(player, {
      correlationId,
      actorId: identity.subject,
    })
    return {
      playerId: player.id,
      email: player.email,
      displayName: player.displayName,
      accountStatus: player.accountStatus,
      kycStatus: evaluation.kycStatus,
      permissions: evaluation.permissions,
    }
  }
}

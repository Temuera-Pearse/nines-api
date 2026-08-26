import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycActorContext } from '../application/KycContext.js'
import type { KycStatusReader } from '../application/KycStatusReader.js'
import { getOrCreateKycProfile } from '../application/profileCreation.js'
import { isKycStatus, type KycStatus } from '../domain/KycStatus.js'
import type { KycProfileRepository } from './KycProfileRepository.js'
import type { TransitionKycStatusService } from '../application/TransitionKycStatusService.js'

export class PostgresKycStatusReader implements KycStatusReader {
  constructor(
    private readonly pool: Pool,
    private readonly profiles: KycProfileRepository,
    private readonly audit: AuditRepository,
    private readonly transitions?: TransitionKycStatusService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getStatusForPlayer(
    playerId: string,
    actor?: KycActorContext,
    executor: QueryExecutor = this.pool,
  ): Promise<KycStatus | null> {
    let profile = actor
      ? (
          await getOrCreateKycProfile(
            playerId,
            actor,
            this.profiles,
            this.audit,
            executor,
          )
        ).profile
      : await this.profiles.findForPlayer(playerId, executor)
    if (!profile) return 'not_started'
    if (
      profile.status === 'verified' &&
      profile.expiresAt !== null &&
      profile.expiresAt.getTime() <= this.clock().getTime()
    ) {
      if (actor && this.transitions) {
        profile =
          (await this.transitions.expireIfDue(playerId, actor, executor)) ?? profile
      } else {
        return 'expired'
      }
    }
    return isKycStatus(profile.status) ? profile.status : null
  }
}

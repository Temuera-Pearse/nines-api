import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycActorContext } from '../application/KycContext.js'
import type { KycStatusReader } from '../application/KycStatusReader.js'
import { getOrCreateKycProfile } from '../application/profileCreation.js'
import { isKycStatus, type KycStatus } from '../domain/KycStatus.js'
import type { KycProfileRepository } from './KycProfileRepository.js'

export class PostgresKycStatusReader implements KycStatusReader {
  constructor(
    private readonly pool: Pool,
    private readonly profiles: KycProfileRepository,
    private readonly audit: AuditRepository,
  ) {}

  async getStatusForPlayer(
    playerId: string,
    actor?: KycActorContext,
    executor: QueryExecutor = this.pool,
  ): Promise<KycStatus | null> {
    const profile = actor
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
    return isKycStatus(profile.status) ? profile.status : null
  }
}

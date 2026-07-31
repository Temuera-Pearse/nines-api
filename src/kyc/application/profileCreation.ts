import { randomUUID } from 'node:crypto'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { GetOrCreateKycProfileResult, KycProfileRepository } from '../infrastructure/KycProfileRepository.js'
import type { KycActorContext } from './KycContext.js'

export async function getOrCreateKycProfile(
  playerId: string,
  actor: KycActorContext,
  profiles: KycProfileRepository,
  audit: AuditRepository,
  executor: QueryExecutor,
): Promise<GetOrCreateKycProfileResult> {
  const result = await profiles.getOrCreateForPlayer(
    randomUUID(),
    playerId,
    executor,
  )
  if (result.created) {
    await audit.append(
      {
        id: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        playerId,
        action: 'kyc.profile_created',
        outcome: 'success',
        reasonCode: 'KYC_PROFILE_CREATED',
        correlationId: actor.correlationId,
        metadata: { profileId: result.profile.id },
      },
      executor,
    )
  }
  return result
}

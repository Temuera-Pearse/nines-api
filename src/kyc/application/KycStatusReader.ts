import type { QueryExecutor } from '../../shared/db/transaction.js'
import type { KycStatus } from '../domain/KycStatus.js'
import type { KycActorContext } from './KycContext.js'

export interface KycStatusReader {
  getStatusForPlayer(
    playerId: string,
    actor?: KycActorContext,
    executor?: QueryExecutor,
  ): Promise<KycStatus | null>
}

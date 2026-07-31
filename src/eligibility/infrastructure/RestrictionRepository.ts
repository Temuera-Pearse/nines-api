import type { QueryExecutor } from '../../shared/db/transaction.js'
import type {
  PlayerRestriction,
  RestrictionStatus,
  RestrictionType,
} from '../domain/Restriction.js'

export interface CreateRestrictionInput {
  id: string
  playerId: string
  type: RestrictionType
  reasonCode: string
  source: string
  startsAt: Date
  endsAt: Date | null
  metadata: Record<string, unknown>
}

export interface RestrictionRepository {
  create(input: CreateRestrictionInput, executor: QueryExecutor): Promise<PlayerRestriction>
  findByIdForUpdate(
    restrictionId: string,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction | null>
  listForPlayer(playerId: string, executor: QueryExecutor): Promise<PlayerRestriction[]>
  listActiveAt(
    playerId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction[]>
  changeStatus(
    restrictionId: string,
    fromStatus: RestrictionStatus,
    toStatus: RestrictionStatus,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction | null>
  findExpiredActive(
    playerId: string,
    at: Date,
    executor: QueryExecutor,
  ): Promise<PlayerRestriction[]>
}

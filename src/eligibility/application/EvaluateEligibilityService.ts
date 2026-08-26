import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AuditRepository } from '../../audit/AuditRepository.js'
import type { Player } from '../../players/domain/Player.js'
import type { KycStatusReader } from '../../kyc/application/KycStatusReader.js'
import type { KycActorType } from '../../kyc/application/KycContext.js'
import { withTransaction } from '../../shared/db/transaction.js'
import type {
  EligibilityDecision,
  EligibilityInputSnapshot,
} from '../domain/EligibilityDecision.js'
import { ELIGIBILITY_POLICY_VERSION } from '../domain/EligibilityDecision.js'
import { evaluateEligibilityPolicy } from '../domain/evaluateEligibilityPolicy.js'
import type { PlayerOperation } from '../domain/PlayerOperation.js'
import type { RestrictionType } from '../domain/Restriction.js'
import type { EligibilityDecisionRepository } from '../infrastructure/EligibilityDecisionRepository.js'
import type { RestrictionRepository } from '../infrastructure/RestrictionRepository.js'
import type { EligibilityEvaluationContext } from './EligibilityContext.js'

export interface EvaluateEligibilityInput {
  player: Player
  operation: PlayerOperation
}

export interface EvaluateEligibilityManyInput {
  player: Player
  operations: readonly PlayerOperation[]
}

function toKycActorType(actorType: string): KycActorType {
  if (actorType === 'PLAYER' || actorType === 'external_identity') return 'PLAYER'
  if (actorType === 'PROVIDER' || actorType === 'fake_provider') return 'PROVIDER'
  if (actorType === 'ADMIN' || actorType === 'test_operator') return 'ADMIN'
  return 'SYSTEM'
}

export class EvaluateEligibilityService {
  constructor(
    private readonly pool: Pool,
    private readonly restrictions: RestrictionRepository,
    private readonly decisions: EligibilityDecisionRepository,
    private readonly audit: AuditRepository,
    private readonly kycStatuses: KycStatusReader,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async execute(
    input: EvaluateEligibilityInput,
    actor: EligibilityEvaluationContext,
  ): Promise<EligibilityDecision> {
    const decisions = await this.executeMany(
      { player: input.player, operations: [input.operation] },
      actor,
    )
    if (!decisions[0]) throw new Error('Eligibility evaluation did not produce a decision')
    return decisions[0]
  }

  async executeMany(
    input: EvaluateEligibilityManyInput,
    actor: EligibilityEvaluationContext,
  ): Promise<EligibilityDecision[]> {
    const evaluatedAt = this.clock()
    return withTransaction(
      this.pool,
      async (client) => {
        const activeRestrictions = await this.restrictions.listActiveAt(
          input.player.id,
          evaluatedAt,
          client,
        )
        const storedKycStatus = await this.kycStatuses.getStatusForPlayer(
          input.player.id,
          {
            actorType: toKycActorType(actor.actorType),
            actorId: actor.actorId,
            correlationId: actor.correlationId,
          },
          client,
        )
        const activeRestrictionTypes = [
          ...new Set(activeRestrictions.map((restriction) => restriction.type)),
        ].sort() as RestrictionType[]
        const inputSnapshot: EligibilityInputSnapshot = {
          accountStatus: input.player.accountStatus,
          kycStatus: storedKycStatus ?? 'invalid',
          activeRestrictionTypes,
        }
        const decisions: EligibilityDecision[] = []
        for (const operation of [...new Set(input.operations)]) {
          const policy = evaluateEligibilityPolicy({ operation, ...inputSnapshot })
          const decision: EligibilityDecision = {
            decisionId: this.createId(),
            playerId: input.player.id,
            operation,
            allowed: policy.allowed,
            reasonCodes: policy.reasonCodes,
            policyVersion: ELIGIBILITY_POLICY_VERSION,
            evaluatedAt,
            inputSnapshot,
          }

          await this.decisions.append(decision, actor.correlationId, client)
          await this.audit.append(
            {
              id: randomUUID(),
              actorType: actor.actorType,
              actorId: actor.actorId,
              playerId: input.player.id,
              action: 'eligibility.evaluated',
              outcome: decision.allowed ? 'allowed' : 'denied',
              reasonCode: decision.reasonCodes[0] ?? null,
              correlationId: actor.correlationId,
              metadata: {
                decisionId: decision.decisionId,
                operation: decision.operation,
                policyVersion: decision.policyVersion,
                reasonCodes: decision.reasonCodes,
                purpose: actor.purpose ?? 'eligibility_check',
              },
            },
            client,
          )
          if (!decision.allowed && actor.purpose === 'authorization') {
            await this.audit.append(
              {
                id: randomUUID(),
                actorType: actor.actorType,
                actorId: actor.actorId,
                playerId: input.player.id,
                action: 'eligibility.operation_denied',
                outcome: 'denied',
                reasonCode: decision.reasonCodes[0] ?? 'POLICY_DATA_INCOMPLETE',
                correlationId: actor.correlationId,
                metadata: {
                  decisionId: decision.decisionId,
                  operation: decision.operation,
                  policyVersion: decision.policyVersion,
                  reasonCodes: decision.reasonCodes,
                },
              },
              client,
            )
          }
          decisions.push(decision)
        }
        return decisions
      },
    )
  }
}

export const KYC_ACTOR_TYPES = ['PLAYER', 'ADMIN', 'PROVIDER', 'SYSTEM'] as const

export type KycActorType = (typeof KYC_ACTOR_TYPES)[number]

export interface KycActorContext {
  actorType: KycActorType
  actorId: string | null
  correlationId: string
}

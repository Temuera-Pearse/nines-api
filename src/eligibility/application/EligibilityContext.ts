export interface EligibilityActorContext {
  actorType: string
  actorId: string | null
  correlationId: string
}

export interface EligibilityEvaluationContext extends EligibilityActorContext {
  purpose?: 'authorization' | 'permission_projection' | 'eligibility_check'
}

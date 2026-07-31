export interface AppendAuditEventInput {
  id: string
  actorType: string
  actorId: string | null
  playerId: string | null
  action: string
  outcome: string
  reasonCode: string | null
  correlationId: string
  metadata: Record<string, unknown>
}

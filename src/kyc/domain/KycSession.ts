export const KYC_SESSION_STATUSES = [
  'creating',
  'pending',
  'verified',
  'failed',
  'manual_review',
  'expired',
  'creation_failed',
] as const

export type KycSessionStatus = (typeof KYC_SESSION_STATUSES)[number]

export interface KycSession {
  id: string
  playerId: string
  provider: string
  providerSessionReference: string | null
  verificationUrl: string | null
  idempotencyKey: string | null
  status: KycSessionStatus
  attemptNumber: number
  startedAt: Date
  expiresAt: Date | null
  completedAt: Date | null
  lastEventAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export function isEffectiveKycSession(session: KycSession, at: Date): boolean {
  return (
    ['creating', 'pending', 'manual_review'].includes(session.status) &&
    (session.expiresAt === null || session.expiresAt.getTime() > at.getTime())
  )
}

export const KYC_STATUSES = [
  'not_started',
  'pending',
  'verified',
  'failed',
  'manual_review',
  'expired',
] as const

export type KycStatus = (typeof KYC_STATUSES)[number]

export function isKycStatus(value: unknown): value is KycStatus {
  return typeof value === 'string' && KYC_STATUSES.includes(value as KycStatus)
}

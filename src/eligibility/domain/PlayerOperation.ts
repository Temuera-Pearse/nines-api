export const PLAYER_OPERATIONS = [
  'view_races',
  'deposit',
  'withdraw',
  'place_wager',
  'start_kyc',
  'manage_profile',
] as const

export type PlayerOperation = (typeof PLAYER_OPERATIONS)[number]

export function isPlayerOperation(value: unknown): value is PlayerOperation {
  return typeof value === 'string' && PLAYER_OPERATIONS.includes(value as PlayerOperation)
}

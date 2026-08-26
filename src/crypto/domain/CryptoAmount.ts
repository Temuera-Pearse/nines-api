const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

export interface ParsedCryptoAmount {
  canonical: string
  units: bigint
  scale: number
}

export function parseCryptoAmount(value: string, maximumScale: number): ParsedCryptoAmount {
  if (typeof value !== 'string' || value.length > 96) {
    throw new Error('Crypto amount must be a bounded decimal string')
  }
  const match = DECIMAL.exec(value)
  if (!match) throw new Error('Crypto amount must be a positive decimal string')
  const fractional = match[2] ?? ''
  if (fractional.length > maximumScale) {
    throw new Error('Crypto amount exceeds the supported decimal precision')
  }
  const trimmedFractional = fractional.replace(/0+$/, '')
  const canonical = trimmedFractional ? `${match[1]}.${trimmedFractional}` : match[1]
  const units = BigInt(`${match[1]}${fractional.padEnd(maximumScale, '0')}`)
  if (units <= 0n) throw new Error('Crypto amount must be greater than zero')
  return { canonical, units, scale: maximumScale }
}

export function compareCryptoAmounts(left: ParsedCryptoAmount, right: ParsedCryptoAmount): number {
  const scale = Math.max(left.scale, right.scale)
  const leftUnits = left.units * 10n ** BigInt(scale - left.scale)
  const rightUnits = right.units * 10n ** BigInt(scale - right.scale)
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0
}

export function normalizeCryptoAsset(value: string): string {
  const asset = value.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,11}$/.test(asset)) throw new Error('Crypto asset is invalid')
  return asset
}

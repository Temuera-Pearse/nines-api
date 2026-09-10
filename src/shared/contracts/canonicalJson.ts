import { createHash } from 'node:crypto'

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | {
  [key: string]: CanonicalJson
}

export function canonicalizeJson(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => {
    const entry = value[key]
    if (entry === undefined) throw new TypeError(`Canonical JSON does not permit undefined at ${key}`)
    return `${JSON.stringify(key)}:${canonicalizeJson(entry)}`
  }).join(',')}}`
}

export function hashCanonicalJson(value: CanonicalJson): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex')
}

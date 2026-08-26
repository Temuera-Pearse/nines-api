const SENSITIVE_KEY =
  /authorization|bearer|cookie|password|secret|token|jwt|database.?url|document|image|biometric|selfie|full.?name|date.?of.?birth|\bdob\b|address|passport|licen[cs]e|national.?id|social.?security|\bssn\b|identity.?number/i

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return '[TRUNCATED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length <= 512 ? value : `${value.slice(0, 512)}…`
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1)]),
    )
  }
  return String(value)
}

export function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(metadata, 0) as Record<string, unknown>
}

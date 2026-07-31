import { describe, expect, it } from 'vitest'
import { canChangeAccountStatus } from './AccountStatusTransition.js'

describe('account status transitions', () => {
  it('supports controlled transitions among non-terminal states', () => {
    expect(canChangeAccountStatus('restricted', 'active')).toBe(true)
    expect(canChangeAccountStatus('active', 'suspended')).toBe(true)
    expect(canChangeAccountStatus('suspended', 'active')).toBe(true)
    expect(canChangeAccountStatus('active', 'restricted')).toBe(true)
  })

  it('allows closing an open account and treats closed as terminal', () => {
    expect(canChangeAccountStatus('restricted', 'closed')).toBe(true)
    expect(canChangeAccountStatus('active', 'closed')).toBe(true)
    expect(canChangeAccountStatus('closed', 'active')).toBe(false)
  })

  it('rejects no-op transitions', () => {
    expect(canChangeAccountStatus('restricted', 'restricted')).toBe(false)
    expect(canChangeAccountStatus('active', 'active')).toBe(false)
  })
})

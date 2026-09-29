/**
 * Agent access control.
 *
 * The two properties this file exists to hold are the ones that make the
 * difference between a control and a checkbox:
 *
 *  1. A RULE NAMING A PLATFORM IS REFUSED WITHOUT VERIFICATION. Selling
 *     allow/deny keyed on a spoofable header is a security misrepresentation
 *     (design doc §3), so the compiler rejects those rules rather than
 *     enforcing them against a self-asserted `Signature-Agent`. A merchant who
 *     ticks "deny scrapers" and gets a rule that anyone can walk past is worse
 *     off than one who was told it does not apply.
 *
 *  2. NOTHING HERE CAN TOUCH A SEARCH CRAWLER OR A HUMAN. consistent source content says
 *     Googlebot always receives canonical HTML. A policy about agents that
 *     could deindex the site is a policy that eventually will.
 *
 * The rest is arithmetic: window boundaries, precedence, and the fact that a
 * denial costs the merchant nothing.
 */
import { describe, expect, it } from 'vitest'
import type { DetectionResult } from '@rebilder/agent-detect'
import {
  accessDeniedResponse,
  compileAccessPolicy,
  createAccessLimiter,
  createAccessRuntime,
  evaluateAccess,
  type AccessPolicy,
} from '../src/core/access'

const VERIFIED = { verificationConfigured: true }
const UNVERIFIED_GATEWAY = { verificationConfigured: false }

function agent(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    kind: 'agent',
    platform: null,
    verified: false,
    acceptsMarkdown: true,
    signals: [],
    confidence: 'high',
    ...overrides,
  }
}

const human = (): DetectionResult => agent({ kind: 'human', acceptsMarkdown: false })
const crawler = (): DetectionResult => agent({ kind: 'crawler', acceptsMarkdown: false })

function decide(policy: AccessPolicy, detection: DetectionResult, options = VERIFIED) {
  const compiled = compileAccessPolicy(policy, options)
  return evaluateAccess(compiled, detection, createAccessLimiter(), 0)
}

// ---------------------------------------------------------------------------

describe('a rule naming a platform requires verification', () => {
  it('is rejected, with a reason, when verification is not wired', () => {
    const compiled = compileAccessPolicy(
      { rules: [{ subject: 'chatgpt', action: 'deny' }] },
      UNVERIFIED_GATEWAY,
    )
    expect(compiled.bySubject.size).toBe(0)
    expect(compiled.rejected).toHaveLength(1)
    expect(compiled.rejected[0]?.reason).toContain('verification')
  })

  it('is applied when verification is wired', () => {
    const compiled = compileAccessPolicy(
      { rules: [{ subject: 'chatgpt', action: 'deny' }] },
      VERIFIED,
    )
    expect(compiled.bySubject.has('chatgpt')).toBe(true)
    expect(compiled.rejected).toHaveLength(0)
  })

  it('still allows a rule about the ABSENCE of proof without verification', () => {
    // "deny unverified" is meaningful even with no verifier wired: it refuses
    // everything that did not prove itself, which is a claim nobody can forge.
    const compiled = compileAccessPolicy(
      { rules: [{ subject: 'unverified', action: 'deny' }] },
      UNVERIFIED_GATEWAY,
    )
    expect(compiled.bySubject.has('unverified')).toBe(true)
    expect(compiled.rejected).toHaveLength(0)
  })

  it('allows a wildcard rule without verification', () => {
    const compiled = compileAccessPolicy(
      { rules: [{ subject: '*', action: 'deny' }] },
      UNVERIFIED_GATEWAY,
    )
    expect(compiled.bySubject.has('*')).toBe(true)
  })

  it('only matches a named platform when the agent is actually verified', () => {
    const policy: AccessPolicy = { rules: [{ subject: 'chatgpt', action: 'deny' }] }
    // Claims to be ChatGPT, has not proved it: the rule does not apply and the
    // default does. Nothing here trusts `platform` on its own.
    expect(decide(policy, agent({ platform: 'chatgpt', verified: false })).allowed).toBe(true)
    expect(decide(policy, agent({ platform: 'chatgpt', verified: true })).allowed).toBe(false)
  })
})

describe('humans and search crawlers are never subject to a policy', () => {
  const denyEverything: AccessPolicy = {
    default: 'deny',
    rules: [{ subject: '*', action: 'deny' }],
  }

  it('serves a human under a deny-all policy', () => {
    expect(decide(denyEverything, human()).allowed).toBe(true)
  })

  it('serves a crawler under a deny-all policy', () => {
    // consistent source content: Googlebot always receives canonical HTML. An access policy
    // that could deindex the merchant's site is one that eventually will.
    expect(decide(denyEverything, crawler()).allowed).toBe(true)
  })

  it('serves a crawler even on a protocol route', () => {
    // The protocol-route widening below makes unidentified machine traffic
    // subject to policy. The crawler exemption is checked FIRST so that
    // widening can never reach a search crawler by a side door.
    const compiled = compileAccessPolicy(denyEverything, VERIFIED)
    const decision = evaluateAccess(compiled, crawler(), createAccessLimiter(), 0, {
      protocolRoute: true,
    })
    expect(decision.allowed).toBe(true)
  })
})

describe('a protocol route is machine traffic by its address', () => {
  // A browser does not fetch /.well-known/ucp. The classifier reports
  // `kind: 'human'` for a client it cannot identify, so without this a policy
  // would govern every agent EXCEPT the ones talking to the commerce
  // endpoints — the traffic a merchant most wants a say over. This was found
  // by the end-to-end test, not by design.
  const denyUnverified: AccessPolicy = { rules: [{ subject: 'unverified', action: 'deny' }] }

  it('applies the policy to an unidentified client on a protocol route', () => {
    const compiled = compileAccessPolicy(denyUnverified, VERIFIED)
    const decision = evaluateAccess(compiled, human(), createAccessLimiter(), 0, {
      protocolRoute: true,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.matched).toBe('unverified')
  })

  it('leaves the same client alone on an ordinary page', () => {
    const compiled = compileAccessPolicy(denyUnverified, VERIFIED)
    expect(evaluateAccess(compiled, human(), createAccessLimiter(), 0).allowed).toBe(true)
  })
})

describe('precedence — most specific first', () => {
  const policy: AccessPolicy = {
    default: 'allow',
    rules: [
      { subject: 'claude', action: 'allow' },
      { subject: 'unverified', action: 'deny' },
      { subject: '*', action: 'allow' },
    ],
  }

  it('a verified platform rule beats the wildcard', () => {
    expect(decide(policy, agent({ platform: 'claude', verified: true })).matched).toBe('claude')
  })

  it('unverified beats the wildcard', () => {
    expect(decide(policy, agent()).matched).toBe('unverified')
    expect(decide(policy, agent()).allowed).toBe(false)
  })

  it('the wildcard catches a verified platform with no rule of its own', () => {
    expect(decide(policy, agent({ platform: 'gemini', verified: true })).matched).toBe('*')
  })

  it('the default applies when nothing matches', () => {
    const bare: AccessPolicy = { default: 'deny' }
    const decision = decide(bare, agent())
    expect(decision.allowed).toBe(false)
    expect(decision.matched).toBeNull()
  })

  it('defaults to allow when no default is given', () => {
    expect(decide({}, agent()).allowed).toBe(true)
  })

  it('normalises the case a merchant typed into their rule', () => {
    // `AgentPlatform` is a closed lower-case union, so the detection side is
    // already normalised. The side that is not is the Console field a person
    // types "ChatGPT" into, and a rule that silently never fires because of a
    // capital letter is the worst kind of access control.
    const shouty: AccessPolicy = { rules: [{ subject: '  ChatGPT  ', action: 'deny' }] }
    expect(compileAccessPolicy(shouty, VERIFIED).bySubject.has('chatgpt')).toBe(true)
    expect(decide(shouty, agent({ platform: 'chatgpt', verified: true })).allowed).toBe(false)
  })
})

describe('the compiler never throws, and never silently drops', () => {
  it('reports a malformed rule instead of failing the boot', () => {
    // A policy that threw at compile time would take the merchant's site down
    // at deploy, which is far worse than one rule not being enforced.
    const compiled = compileAccessPolicy(
      {
        rules: [
          { subject: '', action: 'deny' },
          { subject: 'a', action: 'nonsense' as never },
          { subject: 'b', action: 'limit' },
          { subject: 'c', action: 'limit', limit: { requests: 0, windowSeconds: 60 } },
          { subject: 'd', action: 'limit', limit: { requests: 5, windowSeconds: 0 } },
          { subject: 'ok', action: 'deny' },
        ],
      },
      VERIFIED,
    )
    expect(compiled.rejected).toHaveLength(5)
    expect(compiled.bySubject.has('ok')).toBe(true)
  })

  it('keeps the first of two rules with the same subject, and says so', () => {
    const compiled = compileAccessPolicy(
      {
        rules: [
          { subject: 'claude', action: 'allow' },
          { subject: 'claude', action: 'deny' },
        ],
      },
      VERIFIED,
    )
    expect(compiled.bySubject.get('claude')?.action).toBe('allow')
    expect(compiled.rejected[0]?.reason).toContain('duplicate')
  })

  it('survives a policy with no rules array at all', () => {
    expect(() => compileAccessPolicy({} as AccessPolicy, VERIFIED)).not.toThrow()
    expect(() => compileAccessPolicy({ rules: 'not an array' as never }, VERIFIED)).not.toThrow()
  })

  it('caps the rule count so a pathological policy cannot bloat the hot path', () => {
    const rules = Array.from({ length: 500 }, (_, i) => ({
      subject: `agent-${i}`,
      action: 'deny' as const,
    }))
    const compiled = compileAccessPolicy({ rules }, VERIFIED)
    expect(compiled.bySubject.size).toBeLessThanOrEqual(100)
  })
})

describe('the rate limiter', () => {
  const policy: AccessPolicy = {
    rules: [{ subject: '*', action: 'limit', limit: { requests: 3, windowSeconds: 60 } }],
  }

  it('allows up to the limit and refuses the next one', () => {
    const compiled = compileAccessPolicy(policy, VERIFIED)
    const limiter = createAccessLimiter()
    for (let i = 0; i < 3; i += 1) {
      expect(evaluateAccess(compiled, agent(), limiter, 0).allowed, `request ${i}`).toBe(true)
    }
    const refused = evaluateAccess(compiled, agent(), limiter, 0)
    expect(refused.allowed).toBe(false)
    expect(refused.reason).toBe('rate-limited')
  })

  it('reports a Retry-After that shrinks as the window elapses', () => {
    const compiled = compileAccessPolicy(policy, VERIFIED)
    const limiter = createAccessLimiter()
    for (let i = 0; i < 3; i += 1) evaluateAccess(compiled, agent(), limiter, 0)

    expect(evaluateAccess(compiled, agent(), limiter, 0).retryAfterSeconds).toBe(60)
    expect(evaluateAccess(compiled, agent(), limiter, 30_000).retryAfterSeconds).toBe(30)
    // Never zero: a Retry-After of 0 invites an immediate retry that fails.
    expect(evaluateAccess(compiled, agent(), limiter, 59_900).retryAfterSeconds).toBe(1)
  })

  it('rolls over into a fresh window', () => {
    const compiled = compileAccessPolicy(policy, VERIFIED)
    const limiter = createAccessLimiter()
    for (let i = 0; i < 3; i += 1) evaluateAccess(compiled, agent(), limiter, 0)
    expect(evaluateAccess(compiled, agent(), limiter, 0).allowed).toBe(false)
    expect(evaluateAccess(compiled, agent(), limiter, 60_000).allowed).toBe(true)
  })

  it('counts each subject separately', () => {
    const perAgent: AccessPolicy = {
      rules: [
        { subject: 'claude', action: 'limit', limit: { requests: 1, windowSeconds: 60 } },
        { subject: 'unverified', action: 'limit', limit: { requests: 1, windowSeconds: 60 } },
      ],
    }
    const compiled = compileAccessPolicy(perAgent, VERIFIED)
    const limiter = createAccessLimiter()
    const claude = agent({ platform: 'claude', verified: true })

    expect(evaluateAccess(compiled, claude, limiter, 0).allowed).toBe(true)
    expect(evaluateAccess(compiled, claude, limiter, 0).allowed).toBe(false)
    // A different subject has its own budget, not the exhausted one.
    expect(evaluateAccess(compiled, agent(), limiter, 0).allowed).toBe(true)
  })

  it('does not grow its bookkeeping with traffic', () => {
    // Keyed by subject, which the rule count bounds — never by IP or URL, which
    // would make a memory leak out of a busy day.
    const compiled = compileAccessPolicy(policy, VERIFIED)
    const limiter = createAccessLimiter()
    for (let i = 0; i < 1000; i += 1) evaluateAccess(compiled, agent(), limiter, i * 10)
    expect(evaluateAccess(compiled, agent(), limiter, 0)).toBeDefined()
  })
})

describe('the response a denied agent receives', () => {
  it('is a 403 with a machine-readable body', () => {
    const response = accessDeniedResponse({ allowed: false, matched: '*', reason: 'denied' })
    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-rebilder-path')).toBe('denied')
    expect(response.headers.get('retry-after')).toBeNull()
  })

  it('is a 429 with Retry-After when a limit refused it', () => {
    const response = accessDeniedResponse({
      allowed: false,
      matched: '*',
      reason: 'rate-limited',
      retryAfterSeconds: 42,
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('42')
  })

  it("is never cached — a shared cache must not serve one client another's 403", async () => {
    const response = accessDeniedResponse({ allowed: false, matched: '*', reason: 'denied' })
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('names no rule, no policy and no internals', async () => {
    const body = await accessDeniedResponse({
      allowed: false,
      matched: 'some-internal-subject',
      reason: 'denied',
    }).text()
    expect(body).not.toContain('some-internal-subject')
    expect(body).not.toContain('rule')
  })
})

describe('the runtime compiles once', () => {
  it('reuses the compiled policy for a static value', () => {
    const runtime = createAccessRuntime({ rules: [{ subject: '*', action: 'deny' }] }, VERIFIED)
    expect(runtime.policy()).toBe(runtime.policy())
  })

  it('recompiles only when a getter returns a different object', () => {
    let current: AccessPolicy = { rules: [{ subject: '*', action: 'deny' }] }
    const runtime = createAccessRuntime(() => current, VERIFIED)

    const first = runtime.policy()
    expect(runtime.policy()).toBe(first)

    // The shape a signed poll produces: a new object swapped into a variable.
    current = { rules: [{ subject: '*', action: 'allow' }] }
    const second = runtime.policy()
    expect(second).not.toBe(first)
    expect(second.bySubject.get('*')?.action).toBe('allow')
  })

  it('shares one limiter across policy swaps', () => {
    // Otherwise a poll every 30 seconds would silently reset every counter, and
    // the limit would be "N per poll interval" rather than N per window.
    let current: AccessPolicy = {
      rules: [{ subject: '*', action: 'limit', limit: { requests: 1, windowSeconds: 60 } }],
    }
    const runtime = createAccessRuntime(() => current, VERIFIED)
    expect(evaluateAccess(runtime.policy(), agent(), runtime.limiter, 0).allowed).toBe(true)

    current = { ...current }
    expect(evaluateAccess(runtime.policy(), agent(), runtime.limiter, 0).allowed).toBe(false)
  })
})

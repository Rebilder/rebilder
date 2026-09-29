/**
 * Agent access control — allow / deny / rate-limit per agent, at the edge.
 *
 * ROADMAP Phase 3, and deliberately sequenced AFTER Web Bot Auth verification:
 * allow/deny keyed on a self-asserted `User-Agent` is not a control, it is a
 * suggestion with a security-sounding name. That sequencing is enforced here
 * rather than remembered — see `compileAccessPolicy`, which refuses a rule that
 * names a platform unless verification is wired.
 *
 * Merchant access policy is independent of Rebilder subscription metering.
 * The published SDK serves without a Rebilder account. The host supplies
 * policy configuration; this module evaluates that configuration locally.
 *
 * ─── NO KV ON THE HOT PATH ──────────────────────────────────────────────────
 *
 * The policy arrives as a plain object and is COMPILED ONCE into an indexed,
 * frozen structure. Evaluation is a Map lookup and an integer comparison. There
 * is no await in the evaluation path and there cannot be one, because
 * `config.access` is typed as a value or a SYNCHRONOUS getter — the Next
 * middleware, Express, Fastify and Shopify adapters have no KV at all, and an
 * adapter that had one would still be adding a network round trip to every
 * request to answer a question the merchant already answered.
 *
 * "Delivered by signed poll" is therefore the HOST's job, not this module's:
 * fetch and verify on your own schedule, then hand the result in through the
 * getter. The SDK reads whatever is currently in memory.
 *
 * ─── THE RATE LIMITER IS PER-INSTANCE, AND SAYS SO ──────────────────────────
 *
 * A token bucket in module memory is the only limiter available to code with no
 * shared state, so an agent hitting ten edge locations gets ten buckets. That is
 * a real limitation and it is documented in the README rather than smoothed
 * over: this is a politeness brake and a defence against one runaway client, not
 * a guarantee about global request volume. A merchant who needs a hard global
 * limit needs a shared counter, which means a network hop, which is the one
 * thing the edge budget forbids.
 */

import type { DetectionResult } from '@rebilder/agent-detect'

// ---------------------------------------------------------------------------
// Policy shape (what a merchant writes)
// ---------------------------------------------------------------------------

/**
 * Who a rule is about.
 *
 * - A platform id (`'chatgpt'`, `'claude'`, …) matches a VERIFIED agent of that
 *   platform, and only a verified one. See `compileAccessPolicy`.
 * - `'unverified'` matches any agent that presented no verifiable identity.
 *   This one is meaningful without verification wired, because it is a rule
 *   about the ABSENCE of proof rather than a rule that trusts a claim.
 * - `'*'` matches every agent, verified or not.
 */
export type AccessSubject = 'unverified' | '*' | (string & {})

export type AccessAction = 'allow' | 'deny' | 'limit'

export interface AccessLimit {
  /** Requests permitted per window, per process instance. */
  requests: number
  /** Window length in seconds. */
  windowSeconds: number
}

export interface AccessRule {
  subject: AccessSubject
  action: AccessAction
  /** Required when `action` is `'limit'`, ignored otherwise. */
  limit?: AccessLimit
}

export interface AccessPolicy {
  /** Applied when no rule matches. Defaults to `'allow'`. */
  default?: Exclude<AccessAction, 'limit'>
  rules?: AccessRule[]
}

/**
 * A policy value, or a synchronous getter for one.
 *
 * Synchronous on purpose: a `Promise` here would be an invitation to fetch, and
 * the point of compiling a static blob is that nothing is fetched per request.
 */
export type AccessPolicySource = AccessPolicy | (() => AccessPolicy)

// ---------------------------------------------------------------------------
// Compiled form (what the hot path reads)
// ---------------------------------------------------------------------------

export interface CompiledAccessPolicy {
  readonly default: Exclude<AccessAction, 'limit'>
  /** Lower-cased subject → rule. `'*'` and `'unverified'` live here too. */
  readonly bySubject: ReadonlyMap<string, AccessRule>
  /** Rules the compiler refused, with the reason. Never silently dropped. */
  readonly rejected: readonly { rule: AccessRule; reason: string }[]
}

export interface CompileOptions {
  /**
   * Whether Web Bot Auth verification is wired on this gateway. When false, a
   * rule naming a platform is REFUSED rather than applied — a deny that can be
   * lifted by editing a header is worse than no deny, because it reads as a
   * control in the Console and is not one.
   */
  verificationConfigured: boolean
}

const MAX_RULES = 100

/**
 * Compile a merchant policy once, at boot.
 *
 * Never throws. A malformed rule is rejected individually and reported in
 * `rejected`; the rest of the policy still applies. A policy that throws at
 * compile time would take the merchant's site down at deploy, which is a much
 * worse failure than one rule not being enforced.
 */
export function compileAccessPolicy(
  policy: AccessPolicy,
  options: CompileOptions,
): CompiledAccessPolicy {
  const bySubject = new Map<string, AccessRule>()
  const rejected: { rule: AccessRule; reason: string }[] = []

  const rules = Array.isArray(policy.rules) ? policy.rules.slice(0, MAX_RULES) : []

  for (const rule of rules) {
    const subject = typeof rule?.subject === 'string' ? rule.subject.trim().toLowerCase() : ''
    if (subject === '') {
      rejected.push({ rule, reason: 'rule has no subject' })
      continue
    }
    if (rule.action !== 'allow' && rule.action !== 'deny' && rule.action !== 'limit') {
      rejected.push({ rule, reason: `unknown action` })
      continue
    }
    if (rule.action === 'limit' && !isUsableLimit(rule.limit)) {
      rejected.push({ rule, reason: 'limit rule needs positive requests and windowSeconds' })
      continue
    }
    // THE SEQUENCING RULE, made structural. A rule naming a platform is a rule
    // about identity, and identity that has not been cryptographically checked
    // is a header anyone can send.
    if (subject !== '*' && subject !== 'unverified' && !options.verificationConfigured) {
      rejected.push({
        rule,
        reason:
          'a rule naming a platform requires Web Bot Auth verification (config.verification); ' +
          'without it the subject is a self-asserted header',
      })
      continue
    }
    if (bySubject.has(subject)) {
      rejected.push({ rule, reason: 'duplicate subject; the first rule wins' })
      continue
    }
    bySubject.set(subject, { ...rule, subject })
  }

  return {
    default: policy.default === 'deny' ? 'deny' : 'allow',
    bySubject,
    rejected,
  }
}

function isUsableLimit(limit: AccessLimit | undefined): limit is AccessLimit {
  return (
    limit !== undefined &&
    Number.isFinite(limit.requests) &&
    limit.requests > 0 &&
    Number.isFinite(limit.windowSeconds) &&
    limit.windowSeconds > 0
  )
}

// ---------------------------------------------------------------------------
// The limiter
// ---------------------------------------------------------------------------

/**
 * Fixed-window counters, per process instance. Not a global limit — see the
 * header. Keyed by subject, which is bounded by the rule count, so this map
 * cannot grow with traffic.
 */
export interface AccessLimiter {
  /** True when this request fits in the window. Advances the counter. */
  take(subject: string, limit: AccessLimit, nowMs: number): boolean
  /** Seconds until the current window rolls over. For `Retry-After`. */
  retryAfter(subject: string, limit: AccessLimit, nowMs: number): number
}

export function createAccessLimiter(): AccessLimiter {
  const windows = new Map<string, { startMs: number; count: number }>()

  const windowFor = (subject: string, limit: AccessLimit, nowMs: number) => {
    const lengthMs = limit.windowSeconds * 1000
    const existing = windows.get(subject)
    if (existing === undefined || nowMs - existing.startMs >= lengthMs) {
      const fresh = { startMs: nowMs, count: 0 }
      windows.set(subject, fresh)
      return fresh
    }
    return existing
  }

  return {
    take(subject, limit, nowMs) {
      const window = windowFor(subject, limit, nowMs)
      if (window.count >= limit.requests) return false
      window.count += 1
      return true
    },
    retryAfter(subject, limit, nowMs) {
      const window = windows.get(subject)
      if (window === undefined) return limit.windowSeconds
      const elapsed = (nowMs - window.startMs) / 1000
      return Math.max(1, Math.ceil(limit.windowSeconds - elapsed))
    },
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /**
   * True when the request classified onto the protocol path. See the note in
   * `evaluateAccess` — the route is what makes it machine traffic, not the UA.
   */
  protocolRoute?: boolean
}

export interface AccessDecision {
  allowed: boolean
  /** Which subject matched, for the event. `null` when the default applied. */
  matched: string | null
  /** Present when a limit rule denied this request. */
  retryAfterSeconds?: number
  /** `'denied'` or `'rate-limited'`. Absent when allowed. */
  reason?: 'denied' | 'rate-limited'
}

const ALLOWED: AccessDecision = { allowed: true, matched: null }

/**
 * Resolve one request against a compiled policy.
 *
 * Pure but for the limiter's counters and the injected clock. Subject
 * resolution is most-specific-first: the verified platform, then `unverified`,
 * then `'*'`, then the policy default.
 *
 * HUMANS AND SEARCH CRAWLERS ARE NEVER SUBJECT TO THIS. A policy about agents
 * that could block Googlebot is a policy that can deindex the merchant's site
 * from the Console, and no merchant means to do that when they tick "deny
 * unverified". consistent source content already guarantees crawlers get canonical HTML;
 * this keeps access control from being the exception to it.
 */
export function evaluateAccess(
  policy: CompiledAccessPolicy,
  detection: DetectionResult,
  limiter: AccessLimiter,
  nowMs: number,
  options: EvaluateOptions = {},
): AccessDecision {
  // consistent source content first, and unconditionally. Nothing below can reach a crawler.
  if (detection.kind === 'crawler') return ALLOWED

  // A protocol route is machine traffic by its address: a browser does not
  // fetch /.well-known/ucp. The classifier reports `kind: 'human'` for a client
  // it cannot identify, so without this a policy would govern every agent
  // EXCEPT the ones talking to the commerce endpoints — the traffic a merchant
  // most wants a say over. An unidentified client on that route is exactly what
  // the `unverified` subject means.
  const subjectToPolicy = detection.kind === 'agent' || options.protocolRoute === true
  if (!subjectToPolicy) return ALLOWED

  const subject = matchSubject(policy, detection)
  const rule = subject === null ? undefined : policy.bySubject.get(subject)

  if (rule === undefined) {
    return policy.default === 'deny' ? { allowed: false, matched: null, reason: 'denied' } : ALLOWED
  }
  if (rule.action === 'allow') return { allowed: true, matched: subject }
  if (rule.action === 'deny') {
    return { allowed: false, matched: subject, reason: 'denied' }
  }

  const limit = rule.limit
  if (limit === undefined) return { allowed: true, matched: subject }
  if (limiter.take(subject as string, limit, nowMs)) {
    return { allowed: true, matched: subject }
  }
  return {
    allowed: false,
    matched: subject,
    reason: 'rate-limited',
    retryAfterSeconds: limiter.retryAfter(subject as string, limit, nowMs),
  }
}

/** Most specific first: verified platform → unverified → `*`. */
function matchSubject(policy: CompiledAccessPolicy, detection: DetectionResult): string | null {
  if (detection.verified && detection.platform !== null) {
    const platform = detection.platform.toLowerCase()
    if (policy.bySubject.has(platform)) return platform
  }
  if (!detection.verified && policy.bySubject.has('unverified')) return 'unverified'
  if (policy.bySubject.has('*')) return '*'
  return null
}

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

/**
 * The 403 (or 429) a denied agent receives.
 *
 * Deliberately a small, machine-readable body rather than an HTML error page:
 * the recipient is a program, and a program that gets a styled 403 learns
 * nothing it can act on. `Retry-After` is a real header a well-behaved client
 * already honours.
 */
export function accessDeniedResponse(decision: AccessDecision): Response {
  const limited = decision.reason === 'rate-limited'
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-rebilder-path': 'denied',
  }
  if (limited && decision.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(decision.retryAfterSeconds)
  }
  return new Response(
    JSON.stringify({
      error: limited ? 'rate_limited' : 'access_denied',
      message: limited
        ? 'This site limits how often automated clients may request it. Retry after the interval given.'
        : 'This site does not permit access by this client.',
    }),
    { status: limited ? 429 : 403, headers },
  )
}

// ---------------------------------------------------------------------------
// Boot-time assembly
// ---------------------------------------------------------------------------

export interface AccessRuntime {
  policy: () => CompiledAccessPolicy
  limiter: AccessLimiter
}

/**
 * Build the runtime once, at module scope, from `config.access`.
 *
 * A static policy compiles exactly once. A getter is re-read per request —
 * which is a Map lookup, not I/O — and recompiled only when the object
 * IDENTITY changes, so a host that swaps the policy after a signed poll pays
 * the compile once per swap rather than once per request.
 */
export function createAccessRuntime(
  source: AccessPolicySource,
  options: CompileOptions,
): AccessRuntime {
  const limiter = createAccessLimiter()

  if (typeof source !== 'function') {
    const compiled = compileAccessPolicy(source, options)
    return { policy: () => compiled, limiter }
  }

  let lastInput: AccessPolicy | null = null
  let lastCompiled: CompiledAccessPolicy | null = null
  return {
    policy: () => {
      const current = source()
      if (current !== lastInput || lastCompiled === null) {
        lastInput = current
        lastCompiled = compileAccessPolicy(current, options)
      }
      return lastCompiled
    },
    limiter,
  }
}

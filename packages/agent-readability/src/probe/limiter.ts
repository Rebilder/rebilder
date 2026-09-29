/**
 * probe/limiter.ts — politeness, as a thing you have to hold rather than a thing
 * you have to remember.
 *
 * WHY IT LIVES IN THE PACKAGE. Every consumer of `./probe` — the hosted scanner,
 * the CLI, the MCP server on a stranger's laptop — puts OUR user agent on OUR
 * domain in front of somebody else's origin. A limiter that each consumer is
 * asked to remember to install is a limiter that one of them ships without.
 * `ProbePolicy.limiter` is therefore required, not optional: there is no code
 * path through `probeStrict` that does not take a lease first.
 *
 * WHY IT IS INJECTED AND NEVER MODULE-GLOBAL. Module state is exactly right in a
 * CLI process — one run, one budget, exit — and exactly wrong in a warm
 * serverless instance, where a module-level counter is shared by every request
 * the container ever serves. A 20-probe soft cap implemented as a module global
 * would work perfectly in testing and then, on the twenty-first scan of an
 * instance's life, start refusing unrelated users with no signal that anything
 * had changed. So the limiter is constructed by the caller, scoped to whatever
 * the caller means by "a run", and passed in.
 *
 * DEFAULTS (design §5.2): 1 concurrent probe per host, 2 globally, ≥1s between
 * probes to the same host, ~20 probes per run and then an explicit override.
 * "Probe" here means one HTTP request, which is the unit an origin experiences.
 * A cold single-URL scan is 5 requests (§3.3: robots, agent, browser, llms.txt,
 * .well-known/ucp), so the default budget is about four cold URLs — a deliberate
 * floor that a multi-URL CLI run raises on purpose by passing `maxProbesPerRun`.
 *
 * NOTHING HERE IS PURE, and it does not have to be: the ESLint purity rule
 * exempts `src/probe/**`. `now` and `sleep` are injectable so the tests do not
 * spend real seconds proving that a one-second gap is a one-second gap.
 */

export interface LimiterLease {
  /** Idempotent. Releases the host and global slots and starts the host's cooldown. */
  release(): void
}

export interface Limiter {
  /** Resolves when it is polite to send. Rejects with `ProbeBudgetExceededError`. */
  acquire(host: string): Promise<LimiterLease>
  /** Requests started in this run, including ones still in flight. */
  readonly used: number
  /** The soft cap this limiter was constructed with. */
  readonly budget: number
}

/**
 * Thrown by `acquire` when the run budget is spent. A distinct type because the
 * caller has to be able to tell "we chose not to send this" from "the origin
 * did not answer" — the CLI maps them to different exit codes (4 vs 3) and
 * confusing the two deletes a CI check within a week (design §5.6).
 */
export class ProbeBudgetExceededError extends Error {
  readonly budget: number

  constructor(budget: number) {
    super(
      `rebilder-ars: probe budget exhausted (${budget} requests this run). ` +
        'Raise it explicitly with createLimiter({ maxProbesPerRun }) — it is a soft cap, not a hard one, ' +
        'and raising it should be a decision someone made on purpose.',
    )
    this.name = 'ProbeBudgetExceededError'
    this.budget = budget
  }
}

export interface LimiterOptions {
  /** Default 1. Two concurrent requests to one origin is not a probe, it is a load test. */
  maxConcurrentPerHost?: number
  /** Default 2. */
  maxConcurrentGlobal?: number
  /** Default 1000ms, measured from the release of the previous lease for that host. */
  minIntervalPerHostMs?: number
  /** Default 20 requests. The explicit override is passing a different number here. */
  maxProbesPerRun?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULTS = {
  maxConcurrentPerHost: 1,
  maxConcurrentGlobal: 2,
  minIntervalPerHostMs: 1_000,
  maxProbesPerRun: 20,
} as const

interface Semaphore {
  acquire(): Promise<void>
  release(): void
}

/**
 * Slot-transferring semaphore. `release` hands the slot straight to the next
 * waiter instead of decrementing and letting a fresh caller race in through the
 * fast path — the classic way a "limit 1" semaphore lets two through.
 */
function semaphore(limit: number): Semaphore {
  let active = 0
  const waiting: (() => void)[] = []
  return {
    acquire(): Promise<void> {
      if (active < limit) {
        active += 1
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => waiting.push(resolve))
    },
    release(): void {
      const next = waiting.shift()
      if (next) next()
      else active = Math.max(0, active - 1)
    },
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Builds a limiter scoped to one "run" — one CLI invocation, one MCP session,
 * one scan job. Acquisition order is global-then-host in every path, so two
 * hosts can never deadlock each other.
 */
export function createLimiter(options: LimiterOptions = {}): Limiter {
  const maxConcurrentPerHost = options.maxConcurrentPerHost ?? DEFAULTS.maxConcurrentPerHost
  const maxConcurrentGlobal = options.maxConcurrentGlobal ?? DEFAULTS.maxConcurrentGlobal
  const minIntervalPerHostMs = options.minIntervalPerHostMs ?? DEFAULTS.minIntervalPerHostMs
  const budget = options.maxProbesPerRun ?? DEFAULTS.maxProbesPerRun
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep

  const global = semaphore(Math.max(1, maxConcurrentGlobal))
  const perHost = new Map<string, Semaphore>()
  const nextAllowedAt = new Map<string, number>()
  let used = 0

  const hostSemaphore = (host: string): Semaphore => {
    const existing = perHost.get(host)
    if (existing) return existing
    const created = semaphore(Math.max(1, maxConcurrentPerHost))
    perHost.set(host, created)
    return created
  }

  return {
    get used() {
      return used
    },
    get budget() {
      return budget
    },
    async acquire(host: string): Promise<LimiterLease> {
      if (used >= budget) throw new ProbeBudgetExceededError(budget)
      used += 1

      const key = host.toLowerCase()
      const host$ = hostSemaphore(key)
      await global.acquire()
      try {
        await host$.acquire()
      } catch (error) {
        global.release()
        throw error
      }

      const wait = (nextAllowedAt.get(key) ?? 0) - now()
      if (wait > 0) await sleep(wait)

      let released = false
      return {
        release(): void {
          if (released) return
          released = true
          nextAllowedAt.set(key, now() + minIntervalPerHostMs)
          host$.release()
          global.release()
        },
      }
    },
  }
}

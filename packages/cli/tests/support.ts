/**
 * tests/support.ts — the fake runtime, and the real fixtures.
 *
 * THE FAKE RUNTIME IS THE POINT OF THE WHOLE `CliRuntime` SEAM. Its `probe`
 * returns a `ProbeOutcome` from an array; it never constructs the real probe,
 * never resolves DNS and never opens a socket. Combined with `tests/telemetry.test.ts`
 * — which asserts no source file imports `node:http`/`node:https`/`node:net` or
 * calls `fetch` — "these tests do not touch the network" is a property of the
 * code rather than a claim in a comment.
 *
 * THE EVIDENCE BUNDLES ARE THE REAL CONFORMANCE CORPUS, read from
 * `packages/agent-readability/conformance/`. Design §5.6 requires that any
 * terminal output in our docs comes from a real fixture and is labelled with its
 * id — the previous mock in the source design shipped "47/100, +20 pts, D → B",
 * which is arithmetically impossible against its own bands. The same rule is
 * worth applying to the tests: a hand-written bundle would let a formatter be
 * green against numbers the scorer never produces.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ArsEvidence } from '@rebilder/agent-readability'
import type { ProbeOutcome, ProbeRejection } from '@rebilder/agent-readability/probe'
import type { CliRuntime, ProbeSetup } from '../src/runtime'

const HERE = dirname(fileURLToPath(import.meta.url))

/** `packages/agent-readability/conformance` — the corpus, not a copy of it. */
const CORPUS = resolve(HERE, '..', '..', 'agent-readability', 'conformance')

/** Fixture ids used across the suite AND in the README. Keep the two in step. */
export const FIXTURES = {
  /** A 90 — gateway-installed PDP with markdown negotiation and JSON-LD. */
  gatewayMd: '001-pdp-gateway-md',
  /** D 54 — the same PDP as raw HTML. The honest before/after pair. */
  rawHtml: '002-pdp-raw-html',
  /** opt-out — a deliberate, well-formed assistant disallow. */
  optOut: '020-robots-deliberate-optout',
  /** unscored / robots-disallow-scanner. */
  scannerBlocked: '025-robots-blocks-our-scanner',
  /** unscored / blocked-at-edge (403). */
  blocked403: '040-blocked-403',
  /** unscored / unreachable (timeout). */
  timeout: '041-timeout',
} as const

export function loadEvidence(fixtureId: string): ArsEvidence {
  const raw = readFileSync(join(CORPUS, fixtureId, 'evidence.json'), 'utf8')
  return JSON.parse(raw) as ArsEvidence
}

export function evidenceOutcome(fixtureId: string): ProbeOutcome {
  return { ok: true, evidence: loadEvidence(fixtureId) }
}

export function rejection(kind: ProbeRejection, detail = 'test'): ProbeOutcome {
  return { ok: false, rejection: kind, detail }
}

export interface FakeRuntimeOptions {
  /** Consumed in order, one per probed URL. */
  outcomes?: readonly ProbeOutcome[]
  /** Overrides `outcomes` entirely. */
  probe?: (target: string) => Promise<ProbeOutcome>
  /** Thrown by the probe factory — models `./probe/local` refusing to load. */
  probeFactoryError?: Error
  env?: Record<string, string | undefined>
  isTty?: boolean
  columns?: number
  /** Virtual working directory for `init`'s framework detection. */
  files?: Record<string, string>
}

export interface FakeRuntime {
  runtime: CliRuntime
  stdout(): string
  stderr(): string
  written: Map<string, string>
  probedUrls: string[]
  probeSetups: ProbeSetup[]
}

export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const out: string[] = []
  const err: string[] = []
  const written = new Map<string, string>()
  const probedUrls: string[] = []
  const probeSetups: ProbeSetup[] = []
  const files = options.files ?? {}
  const outcomes = [...(options.outcomes ?? [])]

  const runtime: CliRuntime = {
    env: options.env ?? { NO_COLOR: '1', LANG: 'en_US.UTF-8' },
    cwd: '/virtual',
    isTty: options.isTty ?? false,
    columns: options.columns ?? 80,
    write: (text) => void out.push(text),
    writeError: (text) => void err.push(text),
    writeFile: async (path, contents) => void written.set(path, contents),
    readFile: async (path) => files[path] ?? null,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    probe: async (setup) => {
      probeSetups.push(setup)
      if (options.probeFactoryError !== undefined) throw options.probeFactoryError
      return async (target) => {
        probedUrls.push(target)
        if (options.probe !== undefined) return options.probe(target)
        const next = outcomes.shift()
        if (next === undefined) {
          throw new Error(`fake runtime: no probe outcome queued for ${target}`)
        }
        return next
      }
    },
  }

  return {
    runtime,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    written,
    probedUrls,
    probeSetups,
  }
}

/**
 * args.ts — `node:util` `parseArgs`, and the validation `parseArgs` does not do.
 *
 * `parseArgs` (stable since Node 20.11, which is the root `engines` floor and
 * therefore ours) gives us tokenisation and `strict: true` gives us "unknown
 * option" for free. Everything below it is ours: an unknown *value* for a known
 * option is the error people actually make — `--format html`, `--fail-on Z`,
 * `--concurrency 0` — and `parseArgs` will hand all three through as strings.
 *
 * EVERY FAILURE HERE IS EXIT 2, and nothing here can produce any other code.
 * That is the point of parsing being a separate phase from running: once we have
 * a `Command`, every remaining outcome is a fact about a website, and the
 * operator's mistakes are already behind us.
 *
 * `--fail-on` DEFAULTS TO NOTHING (§5.6). `rebilder check <url>` reports and
 * exits 0. A tool that fails a build by default gets added with `|| true` on the
 * first day and is then permanently decorative.
 */

import { parseArgs } from 'node:util'
import { UsageError } from './exit'

export const FORMATS = ['pretty', 'json', 'markdown', 'junit'] as const
export type Format = (typeof FORMATS)[number]

export const GRADES = ['A', 'B', 'C', 'D', 'F'] as const
export type Grade = (typeof GRADES)[number]

export const COMMANDS = ['check', 'diff', 'init', 'badge'] as const
export type CommandName = (typeof COMMANDS)[number]

export interface CheckCommand {
  name: 'check'
  urls: string[]
  format: Format
  /** `null` = no threshold, the default. Exit 1 is unreachable when null. */
  failOn: Grade | null
  out: string | null
  allowPrivate: boolean
  allowHttp: boolean
  concurrency: number
}

export interface DiffCommand {
  name: 'diff'
  url: string
  format: Format
  out: string | null
  allowPrivate: boolean
  allowHttp: boolean
}

export interface InitCommand {
  name: 'init'
  /** Framework override; `null` means detect from the working directory. */
  framework: string | null
  out: string | null
  format: Format
}

export interface BadgeCommand {
  name: 'badge'
  domain: string
  format: Format
  out: string | null
}

export type Command = CheckCommand | DiffCommand | InitCommand | BadgeCommand

export type ParseResult =
  | { kind: 'command'; command: Command }
  | { kind: 'help'; topic: CommandName | null }
  | { kind: 'version' }

/* ── option table ─────────────────────────────────────────────────────────── */

const OPTIONS = {
  format: { type: 'string' },
  'fail-on': { type: 'string' },
  out: { type: 'string' },
  'allow-private': { type: 'boolean' },
  'allow-http': { type: 'boolean' },
  concurrency: { type: 'string' },
  framework: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

/* ── validators ───────────────────────────────────────────────────────────── */

function asFormat(value: string | undefined, fallback: Format): Format {
  if (value === undefined) return fallback
  const match = FORMATS.find((format) => format === value)
  if (match === undefined) {
    throw new UsageError(`--format must be one of ${FORMATS.join(', ')} (received "${value}")`)
  }
  return match
}

function asGrade(value: string | undefined): Grade | null {
  if (value === undefined) return null
  // Upper-cased before matching: `--fail-on b` is not a mistake worth an error.
  const upper = value.toUpperCase()
  const match = GRADES.find((grade) => grade === upper)
  if (match === undefined) {
    throw new UsageError(`--fail-on must be one of ${GRADES.join(', ')} (received "${value}")`)
  }
  return match
}

const MAX_CONCURRENCY = 8

function asConcurrency(value: string | undefined): number {
  if (value === undefined) return 1
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(`--concurrency must be a positive integer (received "${value}")`)
  }
  const parsed = Number.parseInt(value, 10)
  if (parsed < 1) throw new UsageError('--concurrency must be at least 1')
  if (parsed > MAX_CONCURRENCY) {
    // Not arbitrary politeness theatre: the probe's limiter caps concurrency per
    // host at 1 and globally at 2 regardless, so a larger number here buys
    // nothing and only reads like a promise we do not keep.
    throw new UsageError(
      `--concurrency is capped at ${MAX_CONCURRENCY}; the probe's politeness limiter allows at most 2 in-flight requests globally in any case`,
    )
  }
  return parsed
}

/**
 * A domain, not a URL and not a path. Validated by syntax before anything else
 * touches it — `rebilder badge "https://x.com/a?b"` should be told what is wrong
 * rather than have a snippet built around a mangled string.
 *
 * Split-and-check rather than one compound regex. The obvious pattern nests a
 * bounded quantifier inside a repeated group, which is a backtracking shape a
 * linter is right to flag; a loop over labels is linear, and it is also easier
 * to read than the lookahead soup the single-regex version needs.
 */
const LABEL_CHARS = /^[a-z0-9-]+$/

function isLabel(label: string): boolean {
  if (label.length < 1 || label.length > 63) return false
  if (label.startsWith('-') || label.endsWith('-')) return false
  return LABEL_CHARS.test(label)
}

function isDomain(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false
  const labels = value.split('.')
  // At least two labels: `localhost` is not a domain, and a single-label host is
  // exactly the shape the probe's SSRF guard refuses anyway.
  if (labels.length < 2) return false
  return labels.every(isLabel)
}

export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase()
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname
    } catch {
      throw new UsageError(`"${input}" is not a domain`)
    }
  }
  value = value.replace(/\/.*$/, '').replace(/\.$/, '')
  if (!isDomain(value)) {
    throw new UsageError(
      `"${input}" is not a domain. Pass a registrable hostname such as example.com — not a URL, not a path.`,
    )
  }
  return value
}

/* ── the parser ───────────────────────────────────────────────────────────── */

export function parseCommandLine(argv: readonly string[]): ParseResult {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    // `parseArgs` throws on unknown options and missing values. Its messages are
    // good; re-wrapping them keeps every parse failure a single error type.
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }

  const { values, positionals } = parsed
  const [first, ...rest] = positionals

  if (values.version === true) return { kind: 'version' }

  if (values.help === true || first === undefined || first === 'help') {
    const topicCandidate = first === 'help' ? rest[0] : first
    const topic = COMMANDS.find((name) => name === topicCandidate) ?? null
    if (first === 'help' && rest[0] !== undefined && topic === null) {
      throw new UsageError(`unknown command "${rest[0]}". Expected one of ${COMMANDS.join(', ')}.`)
    }
    return { kind: 'help', topic }
  }

  const name = COMMANDS.find((command) => command === first)
  if (name === undefined) {
    throw new UsageError(`unknown command "${first}". Expected one of ${COMMANDS.join(', ')}.`)
  }

  const out = values.out ?? null
  const allowPrivate = values['allow-private'] === true
  // `--allow-private` implies plain http: the whole point is a staging host on
  // an internal network, and those are rarely on 443 with a valid certificate.
  // It is still expressible on its own for a public host that only serves http.
  const allowHttp = values['allow-http'] === true || allowPrivate

  switch (name) {
    case 'check': {
      if (rest.length === 0) {
        throw new UsageError('check needs at least one URL. Usage: rebilder check <url...>')
      }
      return {
        kind: 'command',
        command: {
          name: 'check',
          urls: rest,
          format: asFormat(values.format, 'pretty'),
          failOn: asGrade(values['fail-on']),
          out,
          allowPrivate,
          allowHttp,
          concurrency: asConcurrency(values.concurrency),
        },
      }
    }
    case 'diff': {
      if (rest.length === 0) throw new UsageError('diff needs a URL. Usage: rebilder diff <url>')
      if (rest.length > 1) {
        throw new UsageError(
          'diff takes exactly one URL. It is a two-representation comparison of a single page; use `check` for a set.',
        )
      }
      if (values['fail-on'] !== undefined) {
        // Refused rather than ignored: silently dropping a flag someone put in a
        // CI file is how a check that appears to gate stops gating.
        throw new UsageError(
          '--fail-on is not supported by `diff`. diff reports what the two representations contain; it does not grade. Use `rebilder check --fail-on`.',
        )
      }
      const url = rest[0]
      if (url === undefined) throw new UsageError('diff needs a URL. Usage: rebilder diff <url>')
      return {
        kind: 'command',
        command: {
          name: 'diff',
          url,
          format: asFormat(values.format, 'pretty'),
          out,
          allowPrivate,
          allowHttp,
        },
      }
    }
    case 'init': {
      if (rest.length > 0) {
        throw new UsageError(
          `init takes no positional arguments (received "${rest[0]}"). Use --framework to override detection.`,
        )
      }
      return {
        kind: 'command',
        command: {
          name: 'init',
          framework: values.framework ?? null,
          out,
          format: asFormat(values.format, 'pretty'),
        },
      }
    }
    case 'badge': {
      if (rest.length === 0) {
        throw new UsageError('badge needs a domain. Usage: rebilder badge <domain>')
      }
      if (rest.length > 1) throw new UsageError('badge takes exactly one domain.')
      const domain = rest[0]
      if (domain === undefined) throw new UsageError('badge needs a domain.')
      return {
        kind: 'command',
        command: {
          name: 'badge',
          domain: normalizeDomain(domain),
          format: asFormat(values.format, 'pretty'),
          out,
        },
      }
    }
  }
}

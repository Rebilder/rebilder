/**
 * index-client.ts — the one network call this binary makes by default, and the
 * only file in `src/` allowed to reference `fetch` (see `eslint.config.mjs`).
 *
 * It is a READ of our public index: `GET /api/public/index/<domain>`. It sends
 * no scan, no URL the user asked about, no page content, no hostname other than
 * the domain the caller explicitly asked to look up, and no identifier of any
 * kind. That is the zero-telemetry contract stated as code rather than as a
 * paragraph in a README (design §5.6).
 *
 * The index is OPT-IN. A domain that is not listed is not a domain that scored
 * badly — it is a domain whose owner has not verified and opted in (§5.4), and
 * the "not listed" answer says so, because a model that reads "not found" and
 * infers "bad" would be inventing a judgement about a third party out of our
 * silence.
 *
 * WHY THE DOMAIN IS VALIDATED BEFORE THE URL IS BUILT. The path segment comes
 * from a tool argument, which in a prompt-injection scenario comes from a web
 * page. Encoding is not enough on its own: a strict syntactic gate keeps
 * "../../something", a URL, an IP literal or a 4 KB blob from ever becoming a
 * request, and it is exactly the same check the badge endpoint runs before its
 * DB read.
 */

import { parseJson, type JsonObject, type JsonValue } from './json'
import { CLIENT_USER_AGENT } from './version'

export const DEFAULT_INDEX_BASE_URL = 'https://rebilder.com'
export const INDEX_BASE_URL_ENV = 'REBILDER_API_URL'
export const DEFAULT_INDEX_TIMEOUT_MS = 5_000

/** Structural: the subset of `fetch` used here, so tests need no globals. */
export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal; redirect: 'error' },
) => Promise<{ status: number; text(): Promise<string> }>

export type IndexLookup =
  | { kind: 'found'; url: string; entry: JsonObject }
  | { kind: 'not-listed'; url: string }
  | { kind: 'failed'; url: string; detail: string }

export interface IndexClient {
  readonly baseUrl: string
  lookup(domain: string): Promise<IndexLookup>
}

/**
 * A registrable domain and nothing else: labels of 1–63 chars from
 * `[a-z0-9-]` (punycode included, which is how internationalised domains
 * arrive), at least two labels, 253 chars total, no leading/trailing hyphen, and
 * a TLD that is not all digits — the last clause is what rejects an IPv4 literal
 * without a second parser.
 */
export function isValidDomain(value: string): boolean {
  const domain = value.trim().toLowerCase().replace(/\.$/, '')
  if (domain.length === 0 || domain.length > 253) return false
  const labels = domain.split('.')
  if (labels.length < 2) return false
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false
    // Written as three linear checks rather than one anchored pattern with a
    // nested quantifier: same rule, and no backtracking to reason about on a
    // string that arrives from a tool argument.
    if (!/^[a-z0-9-]+$/.test(label)) return false
    if (label.startsWith('-') || label.endsWith('-')) return false
  }
  const tld = labels[labels.length - 1] ?? ''
  return !/^[0-9]+$/.test(tld)
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * Resolves the API base. `REBILDER_API_URL` exists for our own staging and is
 * held to the same rules as anything else that decides where bytes go: https
 * only, no credentials in the URL, no query, no fragment. Anything else falls
 * back to production rather than being honoured quietly.
 */
export function resolveIndexBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INDEX_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return DEFAULT_INDEX_BASE_URL
  }
  if (parsed.protocol !== 'https:') return DEFAULT_INDEX_BASE_URL
  if (parsed.username !== '' || parsed.password !== '') return DEFAULT_INDEX_BASE_URL
  if (parsed.search !== '' || parsed.hash !== '') return DEFAULT_INDEX_BASE_URL
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

export function indexEntryUrl(baseUrl: string, domain: string): string {
  return `${baseUrl}/api/public/index/${encodeURIComponent(normalizeDomain(domain))}`
}

export interface IndexClientOptions {
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** Injected in tests. Defaults to the platform `fetch`. */
  readonly fetchImpl?: FetchLike
}

export function createIndexClient(options: IndexClientOptions = {}): IndexClient {
  const baseUrl = resolveIndexBaseUrl(options.baseUrl)
  const timeoutMs = options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS
  const doFetch: FetchLike = options.fetchImpl ?? (fetch as unknown as FetchLike)

  return {
    baseUrl,
    async lookup(domain: string): Promise<IndexLookup> {
      const url = indexEntryUrl(baseUrl, domain)
      let response: { status: number; text(): Promise<string> }
      try {
        response = await doFetch(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': CLIENT_USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
          // A redirect off our own origin would be a request we did not intend
          // to make; there is nothing to follow here.
          redirect: 'error',
        })
      } catch (error) {
        return {
          kind: 'failed',
          url,
          detail: error instanceof Error ? error.message : String(error),
        }
      }

      if (response.status === 404) return { kind: 'not-listed', url }
      if (response.status !== 200) {
        return { kind: 'failed', url, detail: `the index API answered ${response.status}` }
      }

      let body: string
      try {
        body = await response.text()
      } catch (error) {
        return {
          kind: 'failed',
          url,
          detail: error instanceof Error ? error.message : String(error),
        }
      }

      const parsed = parseJson(body)
      if (!parsed.ok) return { kind: 'failed', url, detail: 'the index API returned invalid JSON' }
      const value: JsonValue = parsed.value
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { kind: 'failed', url, detail: 'the index API returned a non-object' }
      }
      return { kind: 'found', url, entry: value }
    },
  }
}

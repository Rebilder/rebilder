import { detect } from '@rebilder/agent-detect'
import type { GatewayDecision } from './types'

/** Flatten web-standard Headers into the record shape agent-detect consumes. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

/**
 * Classify a web-standard Request into a serving path. Pure compute, no I/O,
 * well under 1ms: a handful of header string scans via @rebilder/agent-detect.
 * The request body is never touched.
 *
 * Path rules (ARCHITECTURE.md § Request classification + § Cloaking guardrail):
 *
 * 1. Crawler → 'html'. **consistent source content (project convention): Googlebot always receives
 *    canonical HTML.** agent-detect already guarantees a known crawler UA
 *    classifies as 'crawler' even when the request sends
 *    `Accept: text/markdown` — the markdown path is unreachable for crawlers.
 * 2. Protocol route (/.well-known/ucp, /mcp, /acp) → 'protocol'. This
 *    includes agent-classified requests on a protocol route that did NOT ask
 *    for markdown: a Web Bot Auth-signed UCP/MCP call carries Signature-Agent
 *    (which detect() ranks above the protocol route, classifying it 'agent'),
 *    and it must reach the protocol handler — and Phase 3 verification —
 *    rather than the markdown renderer. An explicit `Accept: text/markdown`
 *    keeps its documented precedence and takes the markdown path even on a
 *    protocol route.
 * 3. Agent → 'markdown' when the agent either explicitly asked for it
 *    (`Accept: text/markdown`) or is an identified platform (Signature-Agent
 *    or a known agent UA). An unidentified agent that didn't ask for markdown
 *    (e.g. a bare unverified Signature/Signature-Input pair) passes through
 *    to HTML — we never guess a format nobody asked for.
 * 4. Human → 'html' (pass through; variant selection is Phase 4).
 */
export function classifyRequest(req: Request): GatewayDecision {
  const detection = detect({
    headers: headersToRecord(req.headers),
    url: req.url,
    method: req.method,
  })

  switch (detection.kind) {
    case 'crawler':
      // consistent source content — cloaking guardrail: crawlers (Googlebot, bingbot) get
      // canonical HTML, always, even with a markdown Accept header.
      return { path: 'html', detection }
    case 'protocol':
      return { path: 'protocol', detection }
    case 'agent': {
      // Signed agents land here (detect() ranks Signature-Agent above the
      // protocol route). On a protocol route without an explicit markdown
      // Accept, they are protocol clients — route them to the protocol
      // handler so Phase 3 verification can run. detect() records the route
      // hit as a 'protocol:<route>' signal whenever the URL matches.
      const onProtocolRoute = detection.signals.some((signal) => signal.startsWith('protocol:'))
      if (onProtocolRoute && !detection.acceptsMarkdown) {
        return { path: 'protocol', detection }
      }
      const identified = detection.platform !== null && detection.platform !== 'unknown'
      return { path: detection.acceptsMarkdown || identified ? 'markdown' : 'html', detection }
    }
    case 'human':
      return { path: 'html', detection }
  }
}

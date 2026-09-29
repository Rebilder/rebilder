/**
 * help.ts — `--help`.
 *
 * THE ZERO-TELEMETRY CONTRACT IS NOT IN A FOOTER. It prints in the general
 * help, where the person deciding whether to point this at an internal hostname
 * inside their own CI is actually looking. (The conflict-of-interest paragraph
 * that used to sit beside it was removed everywhere in Aug 2026, together with
 * the spec clause that required it.)
 *
 * THE EXIT-CODE TABLE IS IN THE HELP TEXT, not only in the README, because the
 * person wiring this into a pipeline is reading a terminal, and the 1-vs-3 split
 * only protects anything if they know it exists before the first flaky build.
 */

import { FORMATS, GRADES, type CommandName } from './args'
import { TELEMETRY_LINES } from './disclosure'
import { EXIT } from './exit'

const EXIT_TABLE: readonly string[] = [
  `  ${EXIT.OK}  completed; threshold met, or no threshold set`,
  `  ${EXIT.THRESHOLD}  completed; threshold NOT met`,
  `  ${EXIT.USAGE}  usage error`,
  `  ${EXIT.PROBE}  probe failed / target unreachable — infrastructure, not a score failure`,
  `  ${EXIT.POLICY}  blocked by policy (SSRF guard, robots opt-out, probe budget spent)`,
]

const GENERAL = `rebilder — help AI assistants understand your business website.

USAGE
  rebilder check <url...>   [--format ${FORMATS.join('|')}] [--fail-on ${GRADES.join('|')}]
                            [--out <file>] [--allow-private] [--allow-http]
                            [--concurrency <n>]
  rebilder diff <url>       agent view vs browser view
  rebilder init             gateway config scaffold for the detected framework
  rebilder badge <domain>   embed snippet

  rebilder help <command>   detail for one command
  rebilder --version

START HERE
  1. Check an important product, service or location page.
  2. Review the business details and suggested next steps in the report.
  3. Run rebilder init in your project to prepare a website connection.
  4. Update your site and rerun the check to verify the result.

  Share a report: rebilder check <url> --format markdown --out review.md
  A scan measures readability, not AI recommendations, customer demand or sales.

EXIT CODES (a stable contract; never renumbered)
${EXIT_TABLE.join('\n')}

  The 1-vs-3 split is load-bearing. A flaky network exits 3, never 1: if an
  unreachable host failed your build as a score failure, the check would be
  deleted from CI within a week. --fail-on defaults to nothing, so plain
  \`rebilder check <url>\` reports and exits 0.

ZERO TELEMETRY
${TELEMETRY_LINES.map((line) => `  ${line}`).join('\n')}

  Spec: https://rebilder.com/spec/ars   Crawler policy: https://rebilder.com/bots
`

const CHECK = `rebilder check <url...>

  Probes each URL twice — an agent request and a browser control that differ in
  the Accept header and in nothing else — plus /robots.txt, /llms.txt and
  /.well-known/ucp per origin. Nothing else is requested. robots.txt is fetched
  first and obeyed.

OPTIONS
  --format ${FORMATS.join('|')}   default pretty
  --fail-on ${GRADES.join('|')}                default none. "--fail-on C" means C or
                                       better passes; a worse grade exits 1.
  --out <file>                         write the same rendering to a file
  --concurrency <n>                    URLs in flight; default 1, max 8. The
                                       probe's politeness limiter still allows
                                       at most 1 request per host and 2 globally.
  --allow-http                         permit plain http targets
  --allow-private                      permit private, loopback and link-local
                                       targets. Routes through a separate,
                                       import-time-gated entry point; it is opt-in
                                       per invocation, never a config default, and
                                       refuses to load in a hosted runtime.
                                       Implies --allow-http.

  A non-graded outcome — a deliberate robots opt-out, a 403 at the edge, an
  unreachable host — never produces exit 1. Only a real score compared against a
  threshold you set can do that.
`

const DIFF = `rebilder diff <url>

  Shows what the agent request received next to what the browser request
  received: status, content type, decoded bytes, an estimated token count, and
  the D2.4 substance-parity comparison verbatim.

  It shows structure and numbers, never an excerpt of the page. --fail-on is not
  supported: diff reports, it does not grade.

OPTIONS
  --format ${FORMATS.join('|')}   default pretty
  --out <file>                         write the same rendering to a file
  --allow-http, --allow-private        as \`check\`
`

const INIT = `rebilder init

  Writes a @rebilder/gateway config scaffold for the framework it detects in the
  working directory, and prints how it decided. Makes no network request and
  reads nothing outside the working directory.

OPTIONS
  --framework <name>                   override detection: next, node, edge, shopify,
                                       fetch, sveltekit, nuxt, astro, react-router,
                                       remix, hono, bun, deno, netlify, vercel
  --out <file>                         write the scaffold to a file
  --format ${FORMATS.join('|')}        junit is refused: init makes no observations

  The scaffold is a skeleton with TODOs, not a working config. The resolvers
  return YOUR source of truth — every substantive value comes from those fields,
  and the gateway never invents one.
`

const BADGE = `rebilder badge <domain>

  Prints the markdown and HTML embed snippets for a domain's badge. Built
  locally: no network request, so we never learn which domain you asked about.

  A grade renders only for a verified opted-in domain; every other domain gets a
  neutral "not rated" badge at 200, not 404. The badge always names its subject,
  is served live, and degrades to "unverified" after 30 days without a
  successful re-scan.

OPTIONS
  --format ${FORMATS.join('|')}        junit is refused: badge makes no observations
  --out <file>                         write the snippet to a file
`

const TOPICS: Record<CommandName, string> = {
  check: CHECK,
  diff: DIFF,
  init: INIT,
  badge: BADGE,
}

export function helpText(topic: CommandName | null): string {
  if (topic === null) return GENERAL
  return TOPICS[topic]
}

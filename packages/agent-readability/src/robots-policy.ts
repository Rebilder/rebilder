/**
 * robots-policy.ts — the refusal token and the one function that decides
 * whether a site has refused us.
 *
 * WHY THIS IS ITS OWN MODULE RATHER THAN A PRIVATE FUNCTION IN `./probe`.
 *
 * There is now more than one probe. The Node probe fetches over the network; a
 * browser extension probes from inside a page the user is already looking at,
 * and cannot import `./probe` at all (that module carries a connection limiter
 * and DNS-level SSRF guards that have no meaning and no implementation in a
 * browser). Both must answer "has this origin refused us?" identically, because
 * a refusal honoured by one scanner and ignored by another is not a policy, it
 * is a coin flip — and the one being ignored is always the one a site operator
 * actually wrote down.
 *
 * So the decision lives here, at the bottom of the import graph, beside the
 * token it matches on. Pure, no clock, no network, safe under this package's
 * purity rule (`eslint.config.mjs`) and therefore usable from any runtime.
 */
import { parseRobots, pathMatches } from './extract'

/**
 * The robots.txt token this scanner answers to. Matched case-insensitively.
 *
 * IT IS NOT VERSIONED, DELIBERATELY. A site that disallowed us under ARS 0.1 is
 * still refusing us under 0.2. Versioning the refusal token would let a spec
 * bump quietly re-open sites that already said no.
 */
export const ARS_ROBOTS_TOKEN = 'rebilder-ars'

/**
 * Has this origin refused this path, by name? Returns the matching rule as a
 * human-readable string, or `null` when it has not.
 *
 * ONLY A GROUP THAT NAMES THE TOKEN COUNTS. A blanket `User-agent: *` disallow
 * is not a decision about us — it is the accidental case, which §3.7 scores with
 * a `robots-contradiction` flag rather than treating as consent or as refusal.
 * Reading a generic bot block as a refusal would also make the honest thing
 * (asking first) indistinguishable from the useless thing (refusing to look at
 * most of the web), and a scanner nobody can run is not a safer scanner.
 *
 * Rule selection uses `pathMatches`, the same matcher the scorer uses, so the
 * fetch gate and the published audience decision can never disagree about what
 * a pattern means. Longest match wins, `allow` beating `disallow` at equal
 * length by virtue of being tested first.
 */
export function robotsDisallowsScanner(robotsBody: string, path: string): string | null {
  const robots = parseRobots(robotsBody)
  for (const group of robots.groups) {
    if (!group.agents.some((agent) => agent.toLowerCase() === ARS_ROBOTS_TOKEN)) continue
    let best: { field: 'allow' | 'disallow'; value: string } | null = null
    for (const value of group.allow) {
      if (!pathMatches(value, path)) continue
      if (best === null || value.length > best.value.length) best = { field: 'allow', value }
    }
    for (const value of group.disallow) {
      if (!pathMatches(value, path)) continue
      if (best === null || value.length > best.value.length) best = { field: 'disallow', value }
    }
    if (best !== null && best.field === 'disallow') {
      return `User-agent: ${ARS_ROBOTS_TOKEN} / Disallow: ${best.value}`
    }
  }
  return null
}

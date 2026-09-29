/**
 * The two request identities the standard is defined in terms of, in a leaf
 * module so a browser can import them without pulling in the Node probe.
 *
 * D2.4 IS THE REASON THESE ARE NORMATIVE. It compares what an origin serves an
 * agent against what it serves a browser, and the comparison is only meaningful
 * because the two requests differ in exactly one header. A probe that invents
 * its own `Accept` strings is measuring a different thing and reporting it under
 * the same name — which is worse than not measuring it, because the number still
 * looks like an ARS number.
 */
export const AGENT_ACCEPT = 'text/markdown;q=1.0, text/html;q=0.8, text/plain;q=0.5, */*;q=0.1'
export const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
export const ASSET_ACCEPT = 'text/plain,*/*;q=0.5'

/**
 * commands/badge.ts — the embed snippet, generated locally.
 *
 * IT MAKES NO NETWORK CALL, and could not usefully make one. The badge endpoint
 * renders from the stored `index_entries` row and is architecturally incapable
 * of triggering a probe (§5.6); asking it anything from here would only tell us
 * which domains people are curious about, which is a log we have promised not to
 * keep. So this command is string construction, and the honesty lives in the
 * notes it prints rather than in a lookup.
 *
 * WHAT THE NOTES HAVE TO SAY, because a merchant pasting this into a README is
 * about to be surprised by all four:
 *  - The badge only renders a grade for a **verified opted-in** domain. Anything
 *    else gets a neutral "not rated" badge, at 200 rather than 404 (a broken
 *    image on a merchant's site is a support ticket).
 *  - It is served live. The owner captures nothing and freezes nothing, and it
 *    degrades to "unverified" after 30 days without a successful re-scan.
 *  - It always names its subject — `example.com · A · 94 · Mar 2026`. A
 *    domain-less badge is misappropriable, and that one decision is what makes
 *    the whole thing safe.
 *  - No score ever comes from the query string.
 *
 * `alt` text carries the domain and the word "score" for the same reason the
 * image does: an image whose alt text is "Rebilder badge" is one someone can
 * move to a different site and have it still read correctly.
 */

import type { BadgeCommand } from '../args'
import type { BadgeSnippet } from '../payload'

export const BADGE_ORIGIN = 'https://rebilder.com'

export function runBadge(command: BadgeCommand): BadgeSnippet {
  const { domain } = command
  const svgUrl = `${BADGE_ORIGIN}/badge/${domain}.svg`
  const pageUrl = `${BADGE_ORIGIN}/readable/${domain}`
  const alt = `Agent Readability Score for ${domain}`

  return {
    domain,
    svgUrl,
    pageUrl,
    markdown: `[![${alt}](${svgUrl})](${pageUrl})`,
    html: `<a href="${pageUrl}"><img src="${svgUrl}" alt="${alt}" height="20"></a>`,
    notes: [
      'A grade renders only for a verified opted-in domain. Every other domain gets a neutral “not rated” badge, served at 200 so it never shows as a broken image.',
      'Verify by publishing a DNS TXT record `rebilder-verify=<token>`, or by serving `X-Rebilder-Path` from your origin where we can observe it.',
      'The badge is served live from our data: you capture nothing and freeze nothing. It degrades to “unverified” after 30 days without a successful re-scan.',
      'It always names its subject (`example.com · A · 94 · Mar 2026`) and it shows the ruleset hash alongside the spec version — two scores from different rulesets must not render identically.',
      'No score ever comes from the query string. Removal from the index is free, self-serve, permanent, and never purchasable.',
      'This command makes no network request. It builds the snippet locally, so we never learn which domain you asked about.',
    ],
  }
}

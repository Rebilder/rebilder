/**
 * markdown-copy.ts — how a page gives AI assistants a Markdown copy, read off
 * the result.
 *
 * ARS 0.3 pays 6 of D2.1's 9 points for a Markdown copy the page links to at
 * another address, when that copy loads. So "D2.1 earned points" no longer
 * means "the page address sends Markdown". `cost.negotiatedBytes` is still set
 * only when the page address itself answered with a machine copy, so that is
 * the test for negotiation, and D2.1 above zero without it is the linked copy.
 */

import type { ArsResult } from '@rebilder/agent-readability'

export type MarkdownCopy = 'page-address' | 'linked' | 'none'

const NEGOTIATED_RESPONSE = 'machine-representation.negotiated-response'

export function markdownCopyOf(result: ArsResult): MarkdownCopy {
  if (result.cost.negotiatedBytes !== null) return 'page-address'
  for (const dimension of result.dimensions) {
    for (const check of dimension.checks) {
      if (check.id === NEGOTIATED_RESPONSE) return check.earned > 0 ? 'linked' : 'none'
    }
  }
  return 'none'
}

/** Printed wherever a report explains D2.1 for a page with a working linked copy. */
export const LINKED_COPY_NOTE =
  'Your linked Markdown copy works. Send it from the page address too for full credit.'

/** The `diff` parity block, when the comparison used the linked copy. */
export const LINKED_PARITY_NOTE =
  'This page does not send a Markdown copy itself. These facts come from the Markdown copy it links to.'

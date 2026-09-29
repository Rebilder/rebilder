/**
 * The markdown 404 (`config.notFound`).
 *
 * An agent that asks for a page that does not exist gets a real 404 status and
 * a few lines of markdown pointing at the files that list what does exist,
 * instead of a styled HTML error page it has to parse to learn the same thing.
 *
 * TWO WAYS TO KNOW A PAGE IS MISSING, and only one of them is a guess:
 *
 *  1. The site said so. The fetch middleware and the edge handler see the
 *     downstream response; a 404 or 410 returned to a markdown request is
 *     re-bodied here with the SAME status. Nothing is inferred.
 *  2. The merchant said so. The Next.js proxy and the Node middleware run
 *     before the site's routes and cannot see a status, so they ask
 *     `notFound.isMissing(url)`. A predicate that throws, or is absent, is a
 *     "no": the request passes through to the site as it always has.
 *
 * Either way it applies ONLY to a markdown request that no source answered.
 * Humans and crawlers never reach this file; they get the site's own error
 * page, so nothing about how a missing URL looks to a search engine changes.
 *
 * The event is unchanged too. The request is recorded exactly as it was before
 * this option existed, as an Agent Miss (`coverage: 'unsourced'`), so turning
 * the option on does not move any Console number.
 *
 * The body contains the fixed heading and sentence below and the merchant's
 * own links, nothing else. It does not echo the requested path: the agent
 * already knows what it asked for, and reflecting request text into a response
 * served under the merchant's domain is a gift to anyone crafting URLs.
 */
import { classifyRequest } from './classify'
import type { GatewayConfig, GatewayNotFound } from './types'

const HEADING = '# Page not found'
const SENTENCE = 'There is no page at this address.'

/** Links resolved against the request origin; unparseable or non-http(s) links are dropped. */
function resolvedLinks(options: GatewayNotFound, requestUrl: URL): string[] {
  const lines: string[] = []
  for (const link of options.links ?? []) {
    if (typeof link?.title !== 'string' || typeof link.url !== 'string') continue
    let target: URL
    try {
      target = new URL(link.url, requestUrl)
    } catch {
      continue
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') continue
    const title = link.title.replace(/[\r\n]+/g, ' ').replace(/[[\]()]/g, (c) => `\\${c}`)
    const note = typeof link.note === 'string' ? link.note.replace(/[\r\n]+/g, ' ') : undefined
    const line = `- [${title}](${target.href})`
    lines.push(note === undefined || note === '' ? line : `${line}: ${note}`)
  }
  return lines
}

/** The markdown body of the 404. */
export function markdownNotFoundBody(options: GatewayNotFound, requestUrl: URL): string {
  const links = resolvedLinks(options, requestUrl)
  const parts = [HEADING, '', SENTENCE]
  if (links.length > 0) parts.push('', ...links)
  return `${parts.join('\n')}\n`
}

/**
 * The 404 (or 410) response. `noindex` because a not-found body is never a
 * page, and `Vary: Accept` because the same URL returns HTML to a browser.
 */
export function markdownNotFoundResponse(
  options: GatewayNotFound,
  requestUrl: URL,
  status: 404 | 410 = 404,
): Response {
  return new Response(markdownNotFoundBody(options, requestUrl), {
    status,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      vary: 'Accept',
      'x-robots-tag': 'noindex',
      'x-rebilder-path': 'not-found',
    },
  })
}

/**
 * For the adapters that hold the site's own response (fetch middleware, edge
 * handler): a 404 or 410 returned to a markdown request is re-bodied as the
 * markdown 404 with the same status. Anything else, and every request from a
 * person or a crawler, is returned untouched. Classification is re-run rather
 * than threaded through, because it is a few header scans and it only happens
 * on an error status.
 */
export function withMarkdownNotFound(
  config: GatewayConfig,
  request: Request,
  response: Response,
): Response {
  const options = config.notFound
  if (options === undefined) return response
  if (response.status !== 404 && response.status !== 410) return response
  try {
    if (classifyRequest(request).path !== 'markdown') return response
    const replacement = markdownNotFoundResponse(options, new URL(request.url), response.status)
    // The site's HTML error page is not sent; release its body.
    response.body?.cancel().catch(() => {})
    return replacement
  } catch {
    return response
  }
}

/** The merchant's `isMissing` verdict. Absent, throwing or non-boolean: not missing. */
export function isMissingPage(config: GatewayConfig, url: URL): boolean {
  try {
    const predicate = config.notFound?.isMissing
    return typeof predicate === 'function' && predicate(url) === true
  } catch {
    return false
  }
}

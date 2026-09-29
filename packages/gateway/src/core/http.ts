/**
 * Small web-standard plumbing shared by the adapters. Internal to the
 * package — not part of the public root export (README § API is the contract).
 */

/**
 * Strip a route prefix from a pathname on whole-segment boundaries only
 * ('/md' + '/mdx' don't mix). A pathname that doesn't start with the prefix
 * is returned unchanged; stripping the entire pathname yields '/'.
 */
export function stripPathPrefix(pathname: string, prefix: string): string {
  const cleaned = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (cleaned === '' || cleaned === '/') return pathname
  if (pathname === cleaned) return '/'
  if (pathname.startsWith(`${cleaned}/`)) return pathname.slice(cleaned.length)
  return pathname
}

/**
 * The standard adapter JSON error response:
 * `application/json; charset=utf-8`, body `{ error, message }`.
 */
export function jsonErrorResponse(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

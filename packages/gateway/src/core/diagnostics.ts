import type { GatewayConfig, SourceKind } from './types'

export interface GatewayDiagnostic {
  code: string
  level: 'ok' | 'info' | 'warning' | 'error'
  message: string
  nextStep?: string
}

export interface GatewayConfigReport {
  /** Configuration checks only; this does not certify a working deployment. */
  valid: boolean
  sources: SourceKind[]
  checks: GatewayDiagnostic[]
}

const SOURCE_KINDS: readonly SourceKind[] = [
  'product',
  'policies',
  'catalog',
  'document',
  'collection',
]

/** Inspect local wiring without invoking sources, policies, event sinks or protocol handlers.
 * Reports never contain source data, store identifiers, credentials or private policy values.
 */
export function inspectGatewayConfig(config: GatewayConfig): GatewayConfigReport {
  const checks: GatewayDiagnostic[] = []
  const sources = SOURCE_KINDS.filter((kind) => typeof config.sources?.[kind] === 'function')
  if (typeof config.storeId !== 'string' || config.storeId.trim() === '') {
    checks.push({
      code: 'store-id-missing',
      level: 'error',
      message: 'A business identifier is missing.',
      nextStep: 'Set storeId to the identifier used by your event destination.',
    })
  }
  if (sources.length === 0) {
    checks.push({
      code: 'sources-missing',
      level: typeof config.protocols === 'function' ? 'info' : 'warning',
      message: 'No business information sources are connected.',
      nextStep:
        'Connect a document source for services or information pages, or a product source for your catalog. A protocol-only integration can omit these.',
    })
  } else {
    checks.push({
      code: 'sources-configured',
      level: 'ok',
      message: 'Business information resolvers are configured.',
      nextStep: 'Test a real page URL with Accept: text/markdown to confirm a source matches.',
    })
  }
  for (const kind of SOURCE_KINDS) {
    if (config.sources?.[kind] !== undefined && typeof config.sources[kind] !== 'function') {
      checks.push({
        code: `source-${kind}-invalid`,
        level: 'error',
        message: `The ${kind} source must be a function.`,
        nextStep: 'Return matching public source data, or null when the URL does not match.',
      })
    }
    const budget = config.maxBytesBySource?.[kind]
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
      checks.push({
        code: `budget-${kind}-invalid`,
        level: 'error',
        message: `The ${kind} byte budget must be a positive finite number.`,
        nextStep: 'Remove the override to use the default, or set a positive byte budget.',
      })
    }
  }
  if (
    config.maxBytes !== undefined &&
    (!Number.isFinite(config.maxBytes) || config.maxBytes <= 0)
  ) {
    checks.push({
      code: 'budget-invalid',
      level: 'error',
      message: 'The response byte budget must be a positive finite number.',
      nextStep: 'Remove maxBytes to use the default, or set a positive byte budget.',
    })
  }
  if (config.sourceTimeoutMs !== undefined) {
    if (!Number.isFinite(config.sourceTimeoutMs))
      checks.push({
        code: 'timeout-invalid',
        level: 'error',
        message: 'The source timeout must be a finite number.',
        nextStep: 'Remove sourceTimeoutMs to use the default timeout.',
      })
    else if (config.sourceTimeoutMs <= 0)
      checks.push({
        code: 'timeout-disabled',
        level: 'warning',
        message: 'Source timeouts are disabled.',
        nextStep:
          'Set a positive sourceTimeoutMs if a stalled resolver should fall back to your normal website.',
      })
  }
  checks.push(
    typeof config.onEvent === 'function'
      ? {
          code: 'events-configured',
          level: 'ok',
          message: 'An event destination is configured.',
          nextStep:
            'Confirm a test request arrives in your destination; this check does not send an event.',
        }
      : {
          code: 'events-local-only',
          level: 'info',
          message: 'Requests are not being sent to an event destination.',
          nextStep:
            'Self-hosted serving works without one. Configure onEvent if you want request history in your own system or a hosted console.',
        },
  )
  if (config.protocols !== undefined && config.verification === undefined) {
    checks.push({
      code: 'verification-not-configured',
      level: 'warning',
      message: 'The protocol hook has no gateway identity verification configured.',
      nextStep:
        'Keep public reads available as intended. For privileged actions, authenticate in your handler or configure verification and enforce its verdict; never trust caller-supplied verification headers.',
    })
  }
  return { valid: !checks.some((check) => check.level === 'error'), sources, checks }
}

/** Inspect an existing response to an explicit markdown test request.
 * Does not fetch a URL, consume the body or execute a transaction.
 * A null result from handleRequest is a normal fallback, not proof of a broken site.
 */
export function inspectGatewayResponse(response: Response | null): GatewayDiagnostic[] {
  if (response === null)
    return [
      {
        code: 'html-fallback',
        level: 'warning',
        message: 'The gateway passed this request to your normal website.',
        nextStep:
          'For an explicit markdown test, check the Accept header, the source URL mapping and whether the resolver returned public information. A normal browser or crawler request should pass through.',
      },
    ]
  if (response.status === 403 || response.status === 429)
    return [
      {
        code: 'access-limited',
        level: 'warning',
        message: 'An access policy refused or limited the request.',
        nextStep:
          'Review the applicable access rule and retry allowance before changing source resolvers.',
      },
    ]
  if (response.status === 304)
    return [
      {
        code: 'not-modified',
        level: 'info',
        message: 'The server confirmed the cached representation is unchanged.',
        nextStep:
          'Retry without If-None-Match or If-Modified-Since to inspect the current markdown response and its cache headers.',
      },
    ]
  if (!response.ok)
    return [
      {
        code: 'http-error',
        level: 'error',
        message: 'The test response has an unsuccessful HTTP status.',
        nextStep: 'Check your adapter and origin logs for this request.',
      },
    ]
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'text/markdown')
    return [
      {
        code: 'not-markdown',
        level: 'warning',
        message: 'The response is not markdown.',
        nextStep:
          'Send Accept: text/markdown to a connected page URL and check that your middleware runs before the HTML response.',
      },
    ]
  const checks: GatewayDiagnostic[] = [
    {
      code: 'markdown-served',
      level: 'ok',
      message: 'The response is served as markdown.',
      nextStep:
        'Read the response to confirm the business details are accurate and public; format alone does not establish completeness.',
    },
  ]
  const vary =
    response.headers
      .get('vary')
      ?.toLowerCase()
      .split(',')
      .map((part) => part.trim()) ?? []
  if (!vary.includes('accept') && !vary.includes('*'))
    checks.push({
      code: 'vary-accept-missing',
      level: 'warning',
      message: 'The response does not vary its cache by Accept.',
      nextStep:
        'Preserve the gateway Vary header through your adapter and CDN so HTML and markdown are cached separately.',
    })
  return checks
}

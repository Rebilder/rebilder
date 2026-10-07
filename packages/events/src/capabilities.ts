/** Public, versioned capability vocabulary. A declaration never grants authority to act. */
export const CAPABILITY_SCHEMA_VERSION = 1 as const
export const CAPABILITIES = [
  {
    id: 'catalog.search',
    label: 'Search catalog',
    kind: 'information',
    intent: 'product-information',
  },
  {
    id: 'product.read',
    label: 'Read product or service details',
    kind: 'information',
    intent: 'product-information',
  },
  {
    id: 'availability.read',
    label: 'Check availability',
    kind: 'information',
    intent: 'availability',
  },
  { id: 'pricing.read', label: 'Read prices', kind: 'information', intent: 'price' },
  { id: 'policy.read', label: 'Read policies', kind: 'information', intent: 'discovery' },
  { id: 'quote.request', label: 'Request a quote', kind: 'action', intent: 'price' },
  { id: 'booking.create', label: 'Make a booking', kind: 'action', intent: 'booking' },
  { id: 'checkout.create', label: 'Start checkout', kind: 'action', intent: 'checkout' },
  { id: 'terms.negotiate', label: 'Request custom terms', kind: 'action', intent: 'custom-terms' },
  { id: 'support.request', label: 'Request support', kind: 'action', intent: 'support' },
] as const
export type CapabilityId = (typeof CAPABILITIES)[number]['id']
export type CapabilityStatus = 'declared' | 'verified' | 'unavailable' | 'unknown'
export interface CapabilityV1 {
  id: CapabilityId
  status: CapabilityStatus
  /** Public, password-free HTTPS address; not a credential or a private action policy. */
  endpoint?: string
  checked_at?: string
  /** A probe verifies information serving; an event reports an observed action result. */
  evidence_source: 'merchant' | 'probe' | 'event'
}
export interface CapabilitySnapshotV1 {
  schema_version: 1
  domain: string
  generated_at: string
  capabilities: CapabilityV1[]
}

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && CAPABILITIES.some((item) => item.id === value)
}

/** DNS names only. Actual network checks must also validate and pin DNS answers. */
export function isPublicCapabilityDomain(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 253 &&
    value === value.toLowerCase() &&
    !/^[\d.]+$/.test(value) &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(value) &&
    value.split('.').length >= 2 &&
    value
      .split('.')
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z\d-]+$/.test(label) &&
          !label.startsWith('-') &&
          !label.endsWith('-'),
      )
  )
}

export function normalizeCapabilityEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !isPublicCapabilityDomain(url.hostname) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.port && url.port !== '443')
    )
      return null
    return url.href
  } catch {
    return null
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value

/** Strict export boundary: reject unknown fields rather than leaking private metadata. */
export function parseCapabilitySnapshot(value: unknown): CapabilitySnapshotV1 | null {
  if (
    !record(value) ||
    !only(value, ['schema_version', 'domain', 'generated_at', 'capabilities']) ||
    value.schema_version !== 1 ||
    !isPublicCapabilityDomain(value.domain) ||
    !timestamp(value.generated_at) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > CAPABILITIES.length
  )
    return null
  const capabilities: CapabilityV1[] = []
  for (const item of value.capabilities) {
    if (
      !record(item) ||
      !only(item, ['id', 'status', 'endpoint', 'checked_at', 'evidence_source']) ||
      !isCapabilityId(item.id) ||
      capabilities.some((prior) => prior.id === item.id) ||
      !['declared', 'verified', 'unavailable', 'unknown'].includes(String(item.status)) ||
      !['merchant', 'probe', 'event'].includes(String(item.evidence_source)) ||
      (item.endpoint !== undefined &&
        normalizeCapabilityEndpoint(item.endpoint) !== item.endpoint) ||
      (item.checked_at !== undefined &&
        (!timestamp(item.checked_at) ||
          Date.parse(item.checked_at) > Date.parse(value.generated_at))) ||
      (item.status === 'verified' &&
        (!item.endpoint || !item.checked_at || item.evidence_source === 'merchant')) ||
      (item.status === 'verified' &&
        item.evidence_source === 'probe' &&
        CAPABILITIES.find((c) => c.id === item.id)?.kind === 'action')
    )
      return null
    capabilities.push({ ...item } as unknown as CapabilityV1)
  }
  return { schema_version: 1, domain: value.domain, generated_at: value.generated_at, capabilities }
}

export const ACTION_STATUSES = [
  'requested',
  'offered',
  'succeeded',
  'failed',
  'unsupported',
] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

/** Only finite vocabulary is transported. No free text, identifiers, prices or private terms. */
export function capabilitySignals(value: Record<string, unknown>): Record<string, unknown> {
  if (value.capability_version !== 1 || !isCapabilityId(value.requested_capability)) return {}
  if (
    value.missing_capability === value.requested_capability &&
    value.action_status === 'succeeded'
  )
    return {}
  const signals: Record<string, unknown> = {
    capability_version: 1,
    requested_capability: value.requested_capability,
  }
  if (value.missing_capability === value.requested_capability)
    signals.missing_capability = value.missing_capability
  if (
    CAPABILITIES.find((item) => item.id === value.requested_capability)?.kind === 'action' &&
    (ACTION_STATUSES as readonly unknown[]).includes(value.action_status)
  )
    signals.action_status = value.action_status
  return signals
}

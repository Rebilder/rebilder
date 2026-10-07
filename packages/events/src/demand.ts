import { scrubQueryText } from './intent'
import {
  CAPABILITIES,
  capabilitySignals,
  type ActionStatus,
  type CapabilityId,
} from './capabilities'

/** Deterministic, versioned interpretation of observed requests; never purchase attribution. */
export const DEMAND_CLASSIFICATION_VERSION = 2

export type IntentCategory =
  | 'discovery'
  | 'product-information'
  | 'availability'
  | 'price'
  | 'delivery'
  | 'booking'
  | 'comparison'
  | 'custom-terms'
  | 'cancellation'
  | 'support'
  | 'checkout'
  | 'unknown'

export type DemandGap = 'no-results' | 'no-source' | 'missing-capability' | 'action-failed' | null

/** The subset of an event needed to classify demand, also usable with grouped historical rows. */
export interface DemandObservation {
  requesterKind: string
  url: string
  intentSignals: Record<string, unknown>
  responsePath: string
  responseSource?: string | null
  responseCoverage?: string | null
}

export interface DemandClassification {
  version: typeof DEMAND_CLASSIFICATION_VERSION
  category: IntentCategory
  basis: 'capability' | 'tool' | 'query' | 'source' | 'path' | 'none'
  commercial: boolean
  /** An observed response gap or explicitly reported missing capability/action failure. */
  gap: DemandGap
  unfulfilled: boolean
  /** An access-policy denial is reported separately from a fulfillment gap. */
  denied: boolean
  requestedCapability: CapabilityId | null
  missingCapability: CapabilityId | null
  actionStatus: ActionStatus | null
}

const TOOL_CATEGORIES: Readonly<Record<string, IntentCategory>> = {
  'ucp.discovery': 'discovery',
  'ucp.catalog': 'product-information',
  'ucp.checkout': 'checkout',
  'acp.feed': 'product-information',
  'mcp.search_catalog': 'product-information',
  'mcp.get_product': 'product-information',
  'mcp.get_policies': 'discovery',
}

// Specific terms precede generic information. These are heuristics, not a model's inference.
const QUERY_CATEGORIES: readonly (readonly [RegExp, IntentCategory])[] = [
  [/\b(checkout|check out|payment link|buy now)\b/i, 'checkout'],
  [
    /\b(bundle|discount|negotiate|negotiation|custom terms|payment terms|bulk pric\w*)\b/i,
    'custom-terms',
  ],
  [/\b(book|booking|reserve|reservation|schedule|appointment)\b/i, 'booking'],
  [/\b(available|availability|in stock|inventory|stock level)\b/i, 'availability'],
  [/\b(price|pricing|cost|quote|how much)\b/i, 'price'],
  [/\b(ship|shipping|delivery|deliver)\b/i, 'delivery'],
  [/\b(cancel|cancellation|refund|returns?)\b/i, 'cancellation'],
  [/\b(compare|comparison|versus|alternatives?)\b/i, 'comparison'],
  [/\b(support|troubleshoot|broken|help desk)\b/i, 'support'],
]

const COMMERCIAL = new Set<IntentCategory>([
  'product-information',
  'availability',
  'price',
  'delivery',
  'booking',
  'comparison',
  'custom-terms',
  'checkout',
])

export function classifyDemand(observation: DemandObservation): DemandClassification {
  let category: IntentCategory = 'unknown'
  let basis: DemandClassification['basis'] = 'none'
  const agent =
    (observation.requesterKind === 'agent' || observation.requesterKind === 'protocol') &&
    observation.intentSignals.diagnostic !== 'install-check'
  const explicit = agent ? capabilitySignals(observation.intentSignals) : {}
  const requestedCapability = (explicit.requested_capability as CapabilityId | undefined) ?? null
  const missingCapability = (explicit.missing_capability as CapabilityId | undefined) ?? null
  const actionStatus = (explicit.action_status as ActionStatus | undefined) ?? null
  if (agent) {
    const tool = observation.intentSignals['tool']
    const query = observation.intentSignals['query']
    const safeQuery = typeof query === 'string' ? scrubQueryText(query) : null
    // A concrete search question refines a general catalog operation.
    const queryMatch =
      safeQuery === null ? undefined : QUERY_CATEGORIES.find(([pattern]) => pattern.test(safeQuery))
    const toolCategory =
      typeof tool === 'string' && Object.hasOwn(TOOL_CATEGORIES, tool)
        ? TOOL_CATEGORIES[tool]
        : undefined
    if (requestedCapability === 'catalog.search' && queryMatch !== undefined) {
      category = queryMatch[1]
      basis = 'query'
    } else if (requestedCapability !== null) {
      category = CAPABILITIES.find((item) => item.id === requestedCapability)!.intent
      basis = 'capability'
    } else if (toolCategory === 'checkout') {
      category = toolCategory
      basis = 'tool'
    } else if (queryMatch !== undefined) {
      category = queryMatch[1]
      basis = 'query'
    } else if (toolCategory !== undefined) {
      category = toolCategory
      basis = 'tool'
    } else if (['product', 'catalog'].includes(observation.responseSource ?? '')) {
      category = 'product-information'
      basis = 'source'
    } else {
      let path = ''
      try {
        path = new URL(observation.url).pathname.toLowerCase()
      } catch {
        /* Unknown URL. */
      }
      if (/^\/(products?|catalog|collections?)(\/|$)/.test(path)) {
        category = 'product-information'
        basis = 'path'
      } else if (/^\/(pricing|prices)(\/|$)/.test(path)) {
        category = 'price'
        basis = 'path'
      } else if (/^\/(checkout|cart)(\/|$)/.test(path)) {
        category = 'checkout'
        basis = 'path'
      }
    }
  }
  const commercial = agent && COMMERCIAL.has(category)
  const denied = agent && observation.responsePath === 'denied'
  // Zero is accepted only as a number, on the protocol response that supplied it.
  // Generic HTML pass-through and unknown coverage are not evidence of failure.
  const gap: DemandGap =
    !commercial || denied
      ? null
      : missingCapability !== null || actionStatus === 'unsupported'
        ? 'missing-capability'
        : actionStatus === 'failed'
          ? 'action-failed'
          : observation.responsePath === 'protocol' &&
              observation.intentSignals['result_count'] === 0
            ? 'no-results'
            : observation.responseCoverage === 'unsourced'
              ? 'no-source'
              : null
  return {
    version: DEMAND_CLASSIFICATION_VERSION,
    category,
    basis,
    commercial,
    gap,
    unfulfilled: gap !== null,
    denied,
    requestedCapability,
    missingCapability,
    actionStatus,
  }
}

/** Hosted ingest overwrites any caller-supplied derived fields with this shared interpretation. */
export function demandSignals(observation: DemandObservation): Record<string, unknown> {
  const demand = classifyDemand(observation)
  return {
    demand_version: demand.version,
    intent_category: demand.category,
    intent_basis: demand.basis,
    commercial_intent: demand.commercial,
    unfulfilled_demand: demand.unfulfilled,
    demand_gap: demand.gap,
  }
}

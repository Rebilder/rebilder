/**
 * schema.ts — the declared input and output schemas for the five tools.
 *
 * `outputSchema` is not decoration. A client that knows the shape of a result
 * can render it, diff it, and validate it; a model that gets `structuredContent`
 * alongside a declared schema stops re-parsing prose. Design §5.6 requires it,
 * and `tests/schema.test.ts` asserts that a REAL `ArsResult` — produced by
 * running the real probe over an injected transport and scoring the result —
 * validates against `ARS_RESULT_SCHEMA` key for key. That test is the point: the
 * schema is checked against the package, not against our memory of it, so a
 * MINOR bump in `@rebilder/agent-readability` that adds a field fails here
 * instead of silently shipping a lying schema.
 *
 * INPUT SCHEMAS ARE CLOSED (`additionalProperties: false`) AND SMALL. There is
 * deliberately no argument anywhere in this file that touches the politeness
 * limiter, the robots gate, the redirect cap, the byte cap, or private-host
 * access. Those are not knobs a model in a conversation gets to turn: the whole
 * reason `probeLocal` lives behind a separate entry point is that a config flag
 * eventually gets set to `true` by something reading attacker-controlled text
 * (design §5.2). A test asserts this file contains no such property name.
 */

import { CHECK_META } from '@rebilder/agent-readability'
import type { JsonObject, JsonValue } from './json'
import { ARS_LABEL } from './version'

export type JsonSchema = JsonObject

const CHECK_IDS: JsonValue[] = Object.keys(CHECK_META).sort()

/* ── shared fragments ─────────────────────────────────────────────────────── */

const BASIS: JsonSchema = {
  type: 'string',
  enum: ['measured', 'heuristic'],
  description:
    'Whether the points came from an observation or an inference. Never render a heuristic value without this label (scorer determinism).',
}

const CHECK_EVIDENCE: JsonSchema = {
  type: 'object',
  properties: { label: { type: 'string' }, value: { type: 'string' }, basis: BASIS },
  required: ['label', 'value', 'basis'],
}

/* ── ArsResult ────────────────────────────────────────────────────────────── */

export const ARS_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  title: 'ArsResult',
  description: `The ${ARS_LABEL} result, exactly as \`score()\` returns it. Determinism is stated in terms of three hashes: a number without rulesetHash, corpusHash and evidenceHash is not an ARS score.`,
  properties: {
    spec: { const: 'ars' },
    specVersion: { type: 'string' },
    rulesetHash: { type: 'string' },
    corpusHash: { type: 'string' },
    evidenceHash: { type: 'string' },
    vantage: { type: 'string', enum: ['public', 'authenticated', 'self'] },
    target: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        finalUrl: { type: 'string' },
        origin: { type: 'string' },
      },
      required: ['url', 'finalUrl', 'origin'],
    },
    outcome: {
      type: 'object',
      description:
        "kind 'scored' carries grade+score; 'opt-out' carries the audience the site excluded; 'unscored' carries a reason.",
      properties: {
        kind: { type: 'string', enum: ['scored', 'opt-out', 'unscored'] },
        grade: { type: 'string' },
        score: { type: 'integer' },
        audience: { type: 'string' },
        wellFormed: { type: 'boolean' },
        reason: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['kind'],
    },
    score: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
    grade: { type: ['string', 'null'], enum: ['A', 'B', 'C', 'D', 'F', null] },
    bandLabel: { type: ['string', 'null'] },
    pageKind: {
      type: 'string',
      enum: ['product', 'collection', 'article', 'place', 'service', 'faq', 'document', 'unknown'],
    },
    pageKindBasis: BASIS,
    pageKindConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    factProfile: {
      type: 'object',
      properties: {
        pageKind: { type: 'string' },
        core: { type: 'array', items: { type: 'string' } },
        extended: { type: 'array', items: { type: 'string' } },
        byteReference: { type: 'integer' },
      },
      required: ['pageKind', 'core', 'extended', 'byteReference'],
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          normalized: { type: 'string' },
          source: {
            type: 'string',
            enum: ['json-ld', 'microdata', 'meta', 'html-text', 'negotiated'],
          },
          offset: { type: 'integer' },
          corroborated: { type: 'boolean' },
        },
        required: ['kind', 'normalized', 'source', 'offset', 'corroborated'],
      },
    },
    dimensions: {
      type: 'array',
      description: 'Always 6 entries; weights always sum to 100.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          weight: { type: 'integer' },
          earned: { type: 'integer' },
          basis: BASIS,
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', enum: CHECK_IDS },
                label: { type: 'string' },
                basis: BASIS,
                weight: { type: 'integer' },
                earned: { type: 'integer' },
                evidence: { type: 'array', items: CHECK_EVIDENCE },
                remedy: { type: 'string' },
              },
              required: ['id', 'label', 'basis', 'weight', 'earned', 'evidence'],
            },
          },
        },
        required: ['id', 'label', 'weight', 'earned', 'basis', 'checks'],
      },
    },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warn'] },
          basis: BASIS,
          message: { type: 'string' },
          evidence: { type: 'array', items: CHECK_EVIDENCE },
        },
        required: ['id', 'severity', 'basis', 'message', 'evidence'],
      },
    },
    policy: {
      type: 'object',
      properties: {
        robotsTxtStatus: { type: 'string', enum: ['ok', 'missing', 'error', 'unparseable'] },
        audiences: { type: 'object' },
        deliberateOptOut: { type: 'boolean' },
        trainingOptOut: {
          type: 'boolean',
          description: 'Strictly neutral. Blocking training crawlers never lowers the score.',
        },
        sitemapDeclared: { type: 'boolean' },
      },
      required: [
        'robotsTxtStatus',
        'audiences',
        'deliberateOptOut',
        'trainingOptOut',
        'sitemapDeclared',
      ],
    },
    cost: {
      type: 'object',
      properties: {
        htmlBytes: { type: 'integer' },
        negotiatedBytes: { type: ['integer', 'null'] },
        approxHtmlTokens: {
          type: 'integer',
          description: 'HEURISTIC (chars/4). Always render with ≈ and an "est." label.',
        },
        approxNegotiatedTokens: { type: ['integer', 'null'] },
        reductionRatio: { type: ['number', 'null'] },
        firstCoreFactOffset: { type: ['integer', 'null'] },
        truncated: {
          type: 'boolean',
          description: 'When true the byte figures are floors — render them as "≥ N bytes".',
        },
      },
      required: [
        'htmlBytes',
        'negotiatedBytes',
        'approxHtmlTokens',
        'approxNegotiatedTokens',
        'reductionRatio',
        'firstCoreFactOffset',
        'truncated',
      ],
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          pointsAvailable: { type: 'integer' },
          effort: { type: 'string', enum: ['config', 'template', 'engineering'] },
          detail: { type: 'string' },
          checks: { type: 'array', items: { type: 'string' } },
          unlocks: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'pointsAvailable', 'effort', 'detail', 'checks', 'unlocks'],
      },
    },
    measuredWeight: { type: 'integer' },
    heuristicWeight: { type: 'integer' },
  },
  required: [
    'spec',
    'specVersion',
    'rulesetHash',
    'corpusHash',
    'evidenceHash',
    'vantage',
    'target',
    'outcome',
    'score',
    'grade',
    'bandLabel',
    'pageKind',
    'pageKindBasis',
    'pageKindConfidence',
    'factProfile',
    'facts',
    'dimensions',
    'flags',
    'policy',
    'cost',
    'recommendations',
    'measuredWeight',
    'heuristicWeight',
  ],
}

/* ── per-tool input schemas ───────────────────────────────────────────────── */

const URL_PROPERTY: JsonSchema = {
  type: 'string',
  description:
    'Absolute https URL of the page to fetch, e.g. "https://example.com/products/kettle". http is refused, and so is any host that resolves to a private, loopback, link-local or otherwise reserved address.',
}

const VANTAGE_PROPERTY: JsonSchema = {
  type: 'string',
  enum: ['public', 'self'],
  default: 'public',
  description:
    "'public' obeys the rebilder-ars robots.txt token and does not fetch a page it forbids. Use 'self' ONLY when the person running this server operates the origin being scanned: it is a claim about consent, and it bypasses that gate.",
}

export const SCAN_URL_INPUT: JsonSchema = {
  type: 'object',
  properties: { url: URL_PROPERTY, vantage: VANTAGE_PROPERTY },
  required: ['url'],
  additionalProperties: false,
}

export const COMPARE_AGENT_VIEW_INPUT: JsonSchema = {
  type: 'object',
  properties: {
    url: URL_PROPERTY,
    vantage: VANTAGE_PROPERTY,
    excerpt_chars: {
      type: 'integer',
      minimum: 0,
      maximum: 1200,
      default: 600,
      description:
        'Characters of each representation to quote, capped at 1200. Excerpts are quarantined as untrusted content.',
    },
  },
  required: ['url'],
  additionalProperties: false,
}

export const EXPLAIN_CHECK_INPUT: JsonSchema = {
  type: 'object',
  properties: {
    check_id: {
      type: 'string',
      enum: CHECK_IDS,
      description: `An ${ARS_LABEL} check id, e.g. "machine-representation.negotiated-response".`,
    },
  },
  required: ['check_id'],
  additionalProperties: false,
}

export const GET_INDEX_ENTRY_INPUT: JsonSchema = {
  type: 'object',
  properties: {
    domain: {
      type: 'string',
      description:
        'A registrable domain, e.g. "example.com". No scheme, no path. Only domains whose owner has verified and opted in appear in the index; everything else answers "not listed", which is not a judgement about the site.',
    },
  },
  required: ['domain'],
  additionalProperties: false,
}

export const INSTALL_SNIPPET_INPUT: JsonSchema = {
  type: 'object',
  properties: {
    framework: {
      type: 'string',
      enum: ['next', 'node', 'edge', 'shopify'],
      description:
        'next = Next.js proxy/middleware; node = Express/Fastify; edge = Cloudflare Worker or any WinterCG runtime; shopify = Shopify App Proxy.',
    },
    store_id: {
      type: 'string',
      description:
        'The store id stamped on emitted events. [A-Za-z0-9_-], 1–64 chars. Defaults to a placeholder.',
    },
    package_manager: {
      type: 'string',
      enum: ['npm', 'pnpm', 'yarn', 'bun'],
      default: 'npm',
    },
  },
  required: ['framework'],
  additionalProperties: false,
}

/* ── per-tool output schemas ──────────────────────────────────────────────── */

export const COMPARE_AGENT_VIEW_OUTPUT: JsonSchema = {
  type: 'object',
  title: 'AgentViewComparison',
  properties: {
    target: { type: 'object' },
    agent: { type: 'object' },
    browser: { type: 'object' },
    cost: { type: 'object' },
    negotiated: { type: 'boolean' },
    markdownCopy: { type: 'string', enum: ['page-address', 'linked', 'none'] },
    linkedCopyUrl: { type: ['string', 'null'] },
    divergence: { type: 'array', items: { type: 'object' } },
    untrustedContentNotice: { type: 'string' },
  },
  required: ['target', 'agent', 'browser', 'negotiated', 'untrustedContentNotice'],
}

export const EXPLAIN_CHECK_OUTPUT: JsonSchema = {
  type: 'object',
  title: 'CheckExplanation',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    basis: BASIS,
    weight: { type: 'integer' },
    dimension: { type: 'string' },
    dimensionLabel: { type: 'string' },
    dimensionWeight: { type: 'integer' },
    specVersion: { type: 'string' },
    rulesetHash: { type: 'string' },
    remedy: { type: ['object', 'null'] },
    specUrl: { type: 'string' },
  },
  required: [
    'id',
    'label',
    'basis',
    'weight',
    'dimension',
    'dimensionLabel',
    'dimensionWeight',
    'specVersion',
    'rulesetHash',
    'remedy',
    'specUrl',
  ],
}

export const GET_INDEX_ENTRY_OUTPUT: JsonSchema = {
  type: 'object',
  title: 'IndexEntryLookup',
  properties: {
    domain: { type: 'string' },
    found: { type: 'boolean' },
    source: { type: 'string' },
    entry: { type: ['object', 'null'] },
    note: { type: 'string' },
    untrustedContentNotice: { type: 'string' },
  },
  required: ['domain', 'found', 'source', 'entry', 'untrustedContentNotice'],
}

export const INSTALL_SNIPPET_OUTPUT: JsonSchema = {
  type: 'object',
  title: 'InstallSnippet',
  properties: {
    framework: { type: 'string' },
    packageManager: { type: 'string' },
    packageName: { type: 'string' },
    installCommand: { type: 'string' },
    storeId: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          language: { type: 'string' },
          contents: { type: 'string' },
        },
        required: ['path', 'language', 'contents'],
      },
    },
    verify: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    generatedOffline: { const: true },
  },
  required: [
    'framework',
    'packageManager',
    'packageName',
    'installCommand',
    'storeId',
    'files',
    'verify',
    'notes',
    'generatedOffline',
  ],
}

import { describe, expect, it } from 'vitest'
import type { CollectionSource, DocumentSource, Fact, FactValue } from '../src/index'
import { formatMoney, renderCollectionMarkdown, renderDocumentMarkdown } from '../src/index'
import {
  dentistLocation,
  governmentService,
  guideIndex,
  lawPracticeArea,
  newsArticle,
  saasPlans,
} from './fixtures/documents'

/**
 * Injected-field integrity for the universal path — structural, not a corpus
 * scan.
 *
 * WHY NOT A SCAN. The commerce integrity test scans for price-like tokens and
 * checks each against the source. That works because a price has a
 * recognisable shape. It does not generalise: a `number` fact renders through
 * `String(value)`, so a fact of `3` renders `3`, and from that moment any `3`
 * anywhere in the output satisfies a bare-number scan — including a fabricated
 * one. A scan over a universal fact vocabulary reports "clean" on output that
 * invented half its content.
 *
 * So this file asserts two structural properties instead.
 *
 * 1. EXACT LINES. For every `Fact` in every fixture, the rendered line is
 *    exactly `- **<label>:** <expected>`, where `expected` is computed here
 *    from the `FactValue` by the same fixed label maps the renderer uses. This
 *    catches a value that is rendered wrongly, not merely one that is absent.
 *
 * 2. SUBSEQUENCE. Strip the scaffolding whitelist from the output, and what
 *    remains must be a token-for-token SUBSEQUENCE of the source strings
 *    concatenated in block order. Subsequence, not subset: a token the source
 *    does not contain fails, and so does a token the source contains in the
 *    wrong place. That is what makes it a check on the renderer rather than on
 *    the fixture's vocabulary.
 *
 * The scaffolding whitelist below is written out as literals on purpose. It
 * would be shorter to import the constants from `src/documents/facts.ts`, and
 * that version would pass forever: new renderer-authored text would whitelist
 * itself the moment it was added. The duplication IS the tripwire — if you add
 * a renderer-authored string and this file fails, that is the test working.
 */

/* ---------------------------------------------------------------- *
 * The scaffolding whitelist, restated as literals (see above).
 * ---------------------------------------------------------------- */

/** Multi-word scaffolding, removed before tokenising. */
const SCAFFOLD_PHRASES = [
  '*Truncated to fit size budget; remaining content omitted.*',
  '*Full text is not served to agents at this URL (access: free).*',
  '*Full text is not served to agents at this URL (access: registration required).*',
  '*Full text is not served to agents at this URL (access: metered).*',
  '*Full text is not served to agents at this URL (access: subscription required).*',
  'All times are local to',
  'Not stated',
  'See page',
  'one-time',
  'per hour',
  'per day',
  'per week',
  'per month',
  'per quarter',
  'per year',
]

/** Single-token scaffolding, removed after tokenising. */
const SCAFFOLD_TOKENS = new Set([
  // headings
  'Exceptions',
  'Contact',
  'Actions',
  'Related',
  'Contents',
  // labels
  'Updated',
  'Phone',
  'Email',
  'Address',
  'Yes',
  'No',
  'Closed',
  'Day',
  'Date',
  'Hours',
  'Note',
  'Title',
  // weekday labels
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
])

/* ---------------------------------------------------------------- *
 * Tokenising.
 * ---------------------------------------------------------------- */

/** `[label](url)` → `label url`, so a link's two source strings both survive. */
const MD_LINK = /\[((?:[^[\]\\]|\\.)*)\]\(([^)\s]*)\)/g

function flatten(markdown: string): string {
  let text = markdown.replace(MD_LINK, '$1 $2')
  text = text.replace(/\\(.)/g, '$1') // undo label escaping
  for (const phrase of SCAFFOLD_PHRASES) text = text.split(phrase).join(' ')
  return text
}

function tokenise(text: string): string[] {
  return text
    .split(/\s+/)
    // Trailing `.` goes too: the fixed timezone sentence ends in one, and the
    // same rule is applied to both sides so prose is unaffected.
    .map((word) => word.replace(/^[#>|*-]+/, '').replace(/[*|:,.]+$/, ''))
    .filter((word) => word.length > 0)
}

/** Output tokens with all scaffolding removed. */
function renderedTokens(markdown: string): string[] {
  return tokenise(flatten(markdown)).filter((token) => !SCAFFOLD_TOKENS.has(token))
}

/** Source tokens: the same normalisation, applied to raw source strings. */
function sourceTokens(...values: (string | undefined)[]): string[] {
  return values
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => tokenise(v))
    .filter((token) => !SCAFFOLD_TOKENS.has(token))
}

function firstUnmatched(needle: string[], haystack: string[]): string | null {
  let i = 0
  for (const token of needle) {
    while (i < haystack.length && haystack[i] !== token) i += 1
    if (i >= haystack.length) return token
    i += 1
  }
  return null
}

/* ---------------------------------------------------------------- *
 * Independent value rendering — the same fixed maps, composed here.
 * ---------------------------------------------------------------- */

const PERIOD_SUFFIX: Record<string, string> = {
  one_time: 'one-time',
  hour: 'per hour',
  day: 'per day',
  week: 'per week',
  month: 'per month',
  quarter: 'per quarter',
  year: 'per year',
}
const BOOLEAN_LABELS: Record<'true' | 'false', string> = { true: 'Yes', false: 'No' }
const WEEKDAY_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

/** `expected` for the exact-line assertion. `null` when the fact is dropped. */
function expectedValueText(value: FactValue): string | null {
  switch (value.type) {
    case 'text':
      return value.value.replace(/\s*\r?\n\s*/g, ' ')
    case 'list':
      return value.value.length > 0 ? value.value.join(', ') : null
    case 'number': {
      if (!Number.isFinite(value.value) || String(value.value).match(/e/i) !== null) return null
      return value.unit !== undefined ? `${String(value.value)} ${value.unit}` : String(value.value)
    }
    case 'boolean':
      return BOOLEAN_LABELS[value.value ? 'true' : 'false']
    case 'money': {
      let text = formatMoney(value.value)
      if (value.maxValue !== undefined) text = `${text}-${formatMoney(value.maxValue)}`
      if (value.period !== undefined) text = `${text} ${PERIOD_SUFFIX[value.period] ?? ''}`
      if (value.per !== undefined) text = `${text} ${value.per}`
      return text
    }
    case 'date':
      return value.value
    case 'url':
      return null // asserted separately; the link form has its own escaping
    case 'hours':
      return null
  }
}

/** Tokens a fact value contributes to the source stream, in rendered order. */
function factValueTokens(value: FactValue): string[] {
  switch (value.type) {
    case 'text':
      return sourceTokens(value.value)
    case 'list':
      return sourceTokens(...value.value)
    case 'number':
      return Number.isFinite(value.value) && String(value.value).match(/e/i) === null
        ? sourceTokens(String(value.value), value.unit)
        : []
    case 'boolean':
      return [] // Yes / No are scaffolding
    case 'money': {
      let text = formatMoney(value.value)
      if (value.maxValue !== undefined) text = `${text}-${formatMoney(value.maxValue)}`
      return sourceTokens(text, value.per)
    }
    case 'date':
      return sourceTokens(value.value)
    case 'url':
      return sourceTokens(value.label, value.value)
    case 'hours': {
      const spec = value.value
      const byDay = new Map(spec.weekly.map((r) => [r.day, r.intervals]))
      const tokens = sourceTokens(spec.timeZone)
      for (const day of WEEKDAY_ORDER) {
        const intervals = byDay.get(day)
        if (intervals === undefined || intervals.length === 0) continue
        tokens.push(...sourceTokens(intervals.map((i) => `${i.opens}-${i.closes}`).join(', ')))
      }
      tokens.push(...sourceTokens(spec.note))
      for (const e of spec.exceptions ?? []) {
        tokens.push(...sourceTokens(e.date))
        if (e.intervals !== undefined && e.intervals.length > 0) {
          tokens.push(...sourceTokens(e.intervals.map((i) => `${i.opens}-${i.closes}`).join(', ')))
        }
        tokens.push(...sourceTokens(e.note))
      }
      return tokens
    }
  }
}

const ALLOWED_SCHEMES = ['https:', 'http:', 'mailto:', 'tel:']
function allowed(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

function isScalar(fact: Fact): boolean {
  return fact.value.type !== 'hours'
}

/**
 * The source token stream, walked in the block order documented in
 * `src/documents/markdown.ts`. Written independently of the renderer: this is
 * the second opinion the subsequence assertion compares against.
 */
function documentSourceTokens(doc: DocumentSource): string[] {
  const access = doc.access ?? 'free'
  const facts = (doc.facts ?? []).slice(0, 60)
  const hasUpdated = doc.updated !== undefined
  const tokens: string[] = []

  tokens.push(...sourceTokens(doc.title))
  if (allowed(doc.url)) tokens.push(...sourceTokens(doc.url))
  tokens.push(...sourceTokens(doc.summary))
  if (hasUpdated) tokens.push(...sourceTokens(doc.updated))

  for (const fact of facts) {
    if (!isScalar(fact)) continue
    if (hasUpdated && fact.label.trim().toLowerCase() === 'updated') continue
    if (fact.value.type === 'url' && !allowed(fact.value.value)) continue
    const valueTokens = factValueTokens(fact.value)
    if (valueTokens.length === 0 && fact.value.type !== 'boolean') continue
    tokens.push(...sourceTokens(fact.label), ...valueTokens, ...sourceTokens(fact.note))
  }
  for (const fact of facts) {
    if (isScalar(fact)) continue
    tokens.push(...sourceTokens(fact.label), ...factValueTokens(fact.value))
  }

  const contact = doc.contact
  if (contact !== undefined) {
    tokens.push(...sourceTokens(contact.phone, contact.email, ...(contact.address ?? [])))
    if (contact.url !== undefined && allowed(contact.url)) tokens.push(...sourceTokens(contact.url))
  }

  for (const action of (doc.actions ?? []).slice(0, 20)) {
    if (!allowed(action.url)) continue
    tokens.push(...sourceTokens(action.label, action.url, action.note))
  }

  if (access === 'free') {
    for (const section of doc.sections ?? []) {
      tokens.push(...sourceTokens(section.heading, section.body))
    }
  }

  for (const link of doc.related ?? []) {
    if (!allowed(link.url)) continue
    tokens.push(...sourceTokens(link.title, link.url, link.note))
  }

  return tokens
}

/* ---------------------------------------------------------------- *
 * Tests.
 * ---------------------------------------------------------------- */

const DOCUMENTS: [string, DocumentSource][] = [
  ['dentistLocation', dentistLocation],
  ['lawPracticeArea', lawPracticeArea],
  ['newsArticle', newsArticle],
  ['governmentService', governmentService],
]

describe('every fact renders as exactly `- **label:** expected`', () => {
  for (const [name, doc] of DOCUMENTS) {
    it(name, () => {
      const out = renderDocumentMarkdown(doc, { maxBytes: 1_000_000 })
      let asserted = 0
      for (const fact of doc.facts ?? []) {
        if (doc.updated !== undefined && fact.label.trim().toLowerCase() === 'updated') continue
        const expected = expectedValueText(fact.value)
        if (expected === null) continue
        expect(out, `${name}: ${fact.label}`).toContain(`- **${fact.label}:** ${expected}`)
        asserted += 1
      }
      expect(asserted).toBeGreaterThan(0)
    })
  }

  it('renders a url fact as an escaped link, label first', () => {
    const out = renderDocumentMarkdown(governmentService, { maxBytes: 1_000_000 })
    expect(out).toContain(
      '- **Application form:** [Form RPP-1 \\(PDF\\)](https://city.example.gov/forms/rpp-1)',
    )
  })

  it('is not satisfied by a value the source does not carry', () => {
    // The exact-line form has teeth precisely because it pins the whole line.
    const out = renderDocumentMarkdown(governmentService, { maxBytes: 1_000_000 })
    expect(out).not.toContain('- **Annual fee:** $46.00 per year')
    expect(out).not.toContain('- **Permits per household:** 3')
  })
})

describe('output minus scaffolding is a subsequence of the source', () => {
  for (const [name, doc] of DOCUMENTS) {
    it(name, () => {
      const out = renderDocumentMarkdown(doc, { maxBytes: 1_000_000 })
      const rendered = renderedTokens(out)
      expect(rendered.length).toBeGreaterThan(10)
      expect(firstUnmatched(rendered, documentSourceTokens(doc))).toBeNull()
    })
  }

  it('catches a fabricated token', () => {
    const out = renderDocumentMarkdown(lawPracticeArea, { maxBytes: 1_000_000 })
    const tampered = `${out}\n$499.00`
    expect(firstUnmatched(renderedTokens(tampered), documentSourceTokens(lawPracticeArea))).toBe(
      '$499.00',
    )
  })

  it('catches a fabricated bare number, which a membership scan would not', () => {
    // This is the case the file header is about. `String(value)` renders `2`
    // for the permits fact, so `2` is a legitimate token of this document and
    // any membership test — set, regex, "does the source contain it" — passes
    // a `2` fabricated anywhere else. The subsequence check is order-
    // sensitive, so a `2` appended past the last source token still fails.
    const out = renderDocumentMarkdown(governmentService, { maxBytes: 1_000_000 })
    const tampered = `${out}\n2`
    const source = documentSourceTokens(governmentService)

    expect(new Set(source).has('2')).toBe(true) // a membership scan says "clean"
    expect(firstUnmatched(renderedTokens(tampered), source)).toBe('2')
  })

  it('catches reordered content', () => {
    const out = renderDocumentMarkdown(lawPracticeArea, { maxBytes: 1_000_000 })
    const lines = out.split('\n')
    const reordered = [...lines.slice(-3), ...lines.slice(0, -3)].join('\n')
    expect(
      firstUnmatched(renderedTokens(reordered), documentSourceTokens(lawPracticeArea)),
    ).not.toBeNull()
  })
})

describe('collection integrity', () => {
  function collectionSourceTokens(collection: CollectionSource): Set<string> {
    const tokens = new Set(sourceTokens(collection.title, collection.url))
    for (const item of collection.items) {
      for (const token of sourceTokens(item.title, item.url, item.summary)) tokens.add(token)
      for (const fact of item.facts ?? []) {
        for (const token of sourceTokens(fact.label)) tokens.add(token)
        for (const token of factValueTokens(fact.value)) tokens.add(token)
      }
    }
    return tokens
  }

  for (const [name, collection] of [
    ['saasPlans', saasPlans],
    ['guideIndex', guideIndex],
  ] as [string, CollectionSource][]) {
    it(`${name}: every non-scaffolding token traces to the source`, () => {
      const out = renderCollectionMarkdown(collection, { maxBytes: 1_000_000 })
      const allowedTokens = collectionSourceTokens(collection)
      const foreign = renderedTokens(out).filter((token) => !allowedTokens.has(token))
      expect(foreign).toEqual([])
    })
  }

  it('renders each cell exactly as the fixed maps prescribe', () => {
    const out = renderCollectionMarkdown(saasPlans, { maxBytes: 1_000_000 })
    expect(out).toContain('| $0.00 per month | 1 | No |')
    expect(out).toContain('| $29.00 per month per seat | 25 | Yes | Email, 1 business day |')
    expect(out).toContain('| $900.00-$2,500.00 per year |  | Yes | Named contact |')
  })

  it('catches a fabricated cell value', () => {
    const out = renderCollectionMarkdown(saasPlans, { maxBytes: 1_000_000 })
    const tampered = out.replace('$29.00', '$19.00')
    const allowedTokens = collectionSourceTokens(saasPlans)
    expect(renderedTokens(tampered).filter((t) => !allowedTokens.has(t))).toEqual([
      '$19.00',
    ])
  })
})

describe('price-like tokens (the commerce scan, retained where it applies)', () => {
  const CURRENCY_TOKEN = /(?:[$€£¥]\s?|\b[A-Z]{3} )\d[\d,]*(?:\.\d+)?/g

  it('every currency token in a document traces to a money fact', () => {
    const out = renderDocumentMarkdown(governmentService, { maxBytes: 1_000_000 })
    const allowedTokens = new Set(
      (governmentService.facts ?? []).flatMap((f) =>
        f.value.type === 'money'
          ? [formatMoney(f.value.value), ...(f.value.maxValue ? [formatMoney(f.value.maxValue)] : [])]
          : [],
      ),
    )
    const found = out.match(CURRENCY_TOKEN) ?? []
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((t) => !allowedTokens.has(t))).toEqual([])
  })

  it('every currency token in a collection traces to a money fact', () => {
    const out = renderCollectionMarkdown(saasPlans, { maxBytes: 1_000_000 })
    const allowedTokens = new Set(
      saasPlans.items
        .flatMap((item) => item.facts ?? [])
        .flatMap((f) =>
          f.value.type === 'money'
            ? [
                formatMoney(f.value.value),
                ...(f.value.maxValue ? [formatMoney(f.value.maxValue)] : []),
              ]
            : [],
        ),
    )
    const found = out.match(CURRENCY_TOKEN) ?? []
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((t) => !allowedTokens.has(t))).toEqual([])
  })
})

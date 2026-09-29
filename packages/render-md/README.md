# @rebilder/render-md

Render your product, policy and page data as clean markdown and schema.org JSON-LD for AI agents. It covers commerce pages (products, policies, catalogs) and everything else: services, locations, plans, articles, listings and profiles.

This is the renderer behind `@rebilder/gateway`. Use it directly to produce the same agent-ready markdown anywhere else.

## Install

```sh
npm install @rebilder/render-md
```

```ts
import { renderDocumentMarkdown } from '@rebilder/render-md'

const markdown = renderDocumentMarkdown({
  url: 'https://example.com/services/bike-fitting',
  title: 'Bike fitting',
  facts: [
    { label: 'Price', value: { type: 'money', value: { amount: 18000, currency: 'GBP' } } },
    { label: 'Booking required', value: { type: 'boolean', value: true } },
  ],
})
// # [Bike fitting](https://example.com/services/bike-fitting)
//
// - **Price:** £180.00
// - **Booking required:** Yes
```

## Contract

**Pure format transformation.** Framework-agnostic, zero runtime dependencies, pure functions, fully deterministic: same input → same output, everywhere, every time. No LLM, no network, no clock, no locale (`Intl` is not used).

**Source-based rendering.** Every substantive value in the output (prices, availability, discounts, shipping and returns text, policy bodies, attributes, facts, hours, contact details, prose) is injected verbatim from the source object. This package never invents, estimates, or rewords a price, stock state, claim, or policy. The only text it adds is structural scaffolding, and that scaffolding is enumerated in full below. Non-integer money amounts throw rather than round: silently altering a price is never acceptable.

**Same substance across formats (consistent offer representations).** Markdown output is a format transformation of the same substance as the canonical HTML page. Rendering must never produce different prices, claims, or availability than the page a human sees; the renderer has no inputs (requester identity, headers, UA) that could even make that possible.

**Malformed input is dropped, never repaired.** A malformed date, a non-finite number, a wrapping time interval, a URL with a scheme we do not allow: each is omitted from the output. Repairing a value invents one the merchant never stated; dropping it only loses information, which the agent can still get from the canonical page.

## API

```ts
import {
  // commerce
  renderProductMarkdown, // ProductSource → markdown PDP (facts first, variants table, description, attributes, image links)
  renderProductJsonLd,   // ProductSource → schema.org Product with offers (decimal price strings, schema.org availability URLs)
  renderPolicyMarkdown,  // PolicySource[] → linked headings + verbatim bodies
  renderCatalogMarkdown, // CatalogItemSource[] → markdown table (linked title, price, availability)
  // universal
  renderDocumentMarkdown,   // DocumentSource   → any single page: facts, hours, contact, actions, prose
  renderCollectionMarkdown, // CollectionSource → any listing page: link list or fact table
  renderCollectionJsonLd,   // CollectionSource → schema.org ItemList of positioned ListItems
  formatMoney,           // { amount: 8900, currency: 'USD' } → "$89.00" (minor units in, deterministic, zero-decimal aware: ¥4,900)
  // optional
  renderFrontmatter,     // { title, description, canonicalUrl, lastUpdated } → YAML frontmatter block, or ''
} from '@rebilder/render-md'
```

Options for all `render*Markdown` functions: `{ maxBytes?: number; headingLevel?: number }`.

Source types: `ProductSource`, `ProductVariantSource`, `ShippingSource`, `ReturnsSource`, `PolicySource`, `CatalogItemSource`, `DocumentSource`, `CollectionSource`, `CollectionItemSource`, `Fact`, `FactValue`, `HoursSpec`, `ContactSource`, `ActionSource`, `LinkSource`, `Money`, `Availability`. Only fields present in the source appear in the output; absent optionals render nothing.

The fixed label maps (`BOOLEAN_LABELS`, `WEEKDAY_LABELS`, `PERIOD_SUFFIX`, `ACCESS_LABELS`, `CLOSED_LABEL`, `NOT_STATED_LABEL`, `SEE_PAGE_LABEL`, `WEEKDAY_ORDER`, `ALLOWED_URL_SCHEMES`) are exported. They are part of the contract: a consumer rendering the same source objects on another surface must be able to reproduce our output exactly.

## Rendering order (product)

Title (linked to canonical URL) → brand → price (`~~$120.00~~ $89.00` when a compare-at price exists in source) → availability → shipping → returns → `- **Updated:**` → variants table (id / title / options / price / availability) → description → attributes → images as markdown links. An agent reading top-down gets every buying fact in the first ~15 lines.

`updated` sits at the end of the fact block rather than the start on purpose: it is metadata *about* the buying facts rather than one of them, and every line above `- **Availability:**` pushes a core fact further from the top of the document, which is a position the Agent Readability Score measures.

## Freshness and language

| Source type | `updated` | `language` |
|---|---|---|
| `ProductSource` | `dateModified` in JSON-LD, `- **Updated:**` in markdown | `inLanguage` in JSON-LD |
| `CollectionSource` | `dateModified` in JSON-LD | `inLanguage` in JSON-LD |
| `DocumentSource` | `- **Updated:**` in markdown | not supported |

`updated` is an ISO 8601 date or datetime; `language` is a BCP 47 tag (`en`, `pt-BR`, `zh-Hant`, `zh-Hant-TW`, `es-419`).

**`DocumentSource` has no `language` field on purpose.** There is no document JSON-LD renderer, so the only thing that consumes `language` would never see it, and a source field that silently renders nothing is a worse contract than an absent one. It arrives with `renderDocumentJsonLd`, which is unbuilt because choosing a schema.org `@type` per `DocumentKind` is an inference this package does not make: `DocumentKind` is an open union of merchant-supplied strings.

Both are **gates, never transforms.** A value that passes is emitted byte-for-byte as supplied, casing included, because BCP 47 is case-insensitive and re-casing a merchant's tag would make our JSON-LD disagree with their own `<html lang>`. A value that fails is dropped from *every* representation at once, so a fact can never be good enough for the markdown and not the JSON-LD.

The date check is a real-calendar check, not a `Date.parse` call: `Date.parse` rolls a day-of-month overflow silently forward (`2026-02-31` → March 3, `2026-02-29` → March 1 in a non-leap year), which is tolerable in a markdown line and not tolerable as `dateModified` in a product feed.

`renderProductJsonLd` feeds `/acp/v0/feed` and the MCP product tool as well as the canonical page, so anything it emits is published as an authoritative fact about the catalog.

## Collections as structured data

`renderCollectionJsonLd` renders a `CollectionSource` as a schema.org `ItemList` of positioned `ListItem`s. Three refusals are part of the contract:

- **`name` is omitted when the source has no title.** The markdown renderer falls back to the fixed `Contents` heading because a markdown document needs a heading; JSON-LD does not, and emitting the fallback would assert a name the merchant never wrote.
- **Item URLs pass the same scheme allowlist as the markdown path.** A rejected URL drops the link, not the item. The item still renders with its name, because dropping it would misreport the length of the listing.
- **`numberOfItems` counts what was emitted**, not `items.length`. Past the 500-row cap, a list announcing 900 while carrying 500 would send a paging agent after items that are not in the document.

Item facts are deliberately not projected into the list: `ListItem` has no honest slot for an arbitrary labelled fact, and inventing property names for merchant labels is the kind of inference this package does not do. The facts are in the markdown table.

## The universal surface

Every non-commerce vertical evaluated reduces to *document with facts*. A dentist's location page, a SaaS plan, a law firm's practice area, a news article, and a government service record differ in vocabulary, not in structure, so they share two types and two renderers.

### Block order and truncation (document)

| # | Block | Truncatable |
|---|---|---|
| 1 | `# [title](url)` | no |
| 2 | `> summary` | no |
| 3 | `- **Updated:**` + scalar facts (text/list/number/boolean/money/date/url) | no |
| 4 | `## <fact label>` hours table per `hours` fact, in fact order | no |
| 5 | `## Contact` | no |
| 6 | `## Actions` | no |
| 7 | `## <section heading>` prose, **only when `access === 'free'`** | **yes** |
| 8 | `## Related` | **yes, first to go** |

Truncation is strictly from the bottom and always on whole lines, so `related` drops before prose and prose is never cut mid-sentence. A truncated document ends with the fixed truncation note and nothing renders after it.

Two ceilings, not one. `maxBytes` (default **5120**) governs the truncatable tail. An absolute ceiling at **4 × `maxBytes`** governs the required blocks: "facts are never sacrificed" is a safe promise for a PDP with a dozen fields and an unbounded one for a government page with sixty, and without the second ceiling the merchant's data shape decides our response size. Further hard caps: **60** facts, **20** actions, **500** collection rows, **12** collection fact columns.

### Fact values

| `FactValue.type` | Rendered as | Dropped when |
|---|---|---|
| `text` | verbatim, newlines collapsed to spaces | never |
| `list` | items joined with `, ` | empty |
| `number` | `String(value)`, `unit` appended verbatim | non-finite, or exponential form (`1e+21`) |
| `boolean` | `Yes` / `No` | never |
| `money` | `formatMoney`; `maxValue` → `$900.00-$2,500.00`; `period` → fixed suffix; `per` → verbatim | never; a contradictory range (currency mismatch, `maxValue < value`) **throws** |
| `date` | verbatim | not a valid ISO 8601 date/datetime |
| `url` | `[label](url)`, or the bare URL when there is no label | scheme not allowlisted |
| `hours` | its own `## <fact label>` block with a weekday table | missing/blank `timeZone`, or any malformed interval |

`Fact.note` renders as an indented bullet under its fact line.

**Hours.** All seven weekdays always render. A weekday absent from `weekly` is `Not stated`; a weekday present with `intervals: []` is `Closed`. Those are different facts and collapsing them would assert a closure the merchant never stated. An interval where `closes <= opens` is malformed (overnight spans are expressed as two intervals on two days), and one malformed interval drops the whole hours fact, because a table missing exactly the day that was broken reads as authoritative and is not. Nothing here computes "open now": that needs a clock and a timezone database, and a wrong answer to "are they open" is worse than no answer.

**Access gate.** `sections` is emitted **only** when `access === 'free'`. `registered`, `metered`, and `subscriber` emit summary + facts + contact + actions + a fixed access notice, and never touch `sections`. This is mechanical, not a prose rule: the renderer omits those bodies on the tested restricted-access paths.

**Dedup.** If `DocumentSource.updated` is set and valid, a fact labelled `Updated` is dropped. Two "Updated" lines disagreeing is worse than one that might be stale.

### Collections

Two deterministic modes and no third:

- **No item carries facts** → a link list, one bullet per item, `summary` indented beneath.
- **Any item carries facts** → a table. Columns are `Title` + the ordered union of fact labels by first appearance, plus a `Note` column carrying item summaries. The union is accumulated in the **same streaming pass that spends the byte budget**, so the header can never advertise a column belonging only to rows the budget then dropped. If not one row fits, no table is emitted at all.

An `hours` fact is not a valid table cell; it renders as `See page` linked to the item's own URL.

### URL scheme allowlist

`https:`, `http:`, `mailto:`, `tel:`. Anything else, and any relative URL (this package has no base URL to resolve one against), **drops the item**: the action, the related link, or the url fact. The commerce path only ever emitted merchant-controlled product and policy URLs; the universal path emits arbitrary merchant-supplied link targets, and `[Click here](javascript:…)` handed to an agent under our formatting authority is a phishing primitive. A document whose own `url` fails the allowlist still renders, with an unlinked title.

### Escaping

`]`, `(`, and `)` are escaped in every markdown link label; without it, source text can close the label early and forge a link target. `|` and newlines are escaped in every table cell **and in every column header derived from a `Fact.label`**. A `|` inside a fact *line* is left alone; it only breaks tables.

### Scaffolding whitelist

The complete list of renderer-authored text. Nothing else is ever added to the output.

- **Structure:** `**<label>:**` bolding, `#` headings, `-` bullets, `>` blockquote markers, table pipes and `---` separators, `, ` between list items, `-` between the two ends of a money or time range.
- **Headings:** `Exceptions`, `Contact`, `Actions`, `Related`, `Contents`.
- **Labels:** `Updated`, `Phone`, `Email`, `Address`, `Yes`, `No`, `Closed`, `Not stated`, `Day`, `Date`, `Hours`, `Note`, `Title`, `See page`.
- **Fixed enum mappings:** weekday names `Monday`…`Sunday`; billing-period suffixes `one-time`, `per hour`, `per day`, `per week`, `per month`, `per quarter`, `per year`; access words `free`, `registration required`, `metered`, `subscription required` (used only inside the access notice). These are format mappings of closed enums, the same class as `Yes`/`No` and the commerce path's `In stock`.
- **Fixed sentences:** `All times are local to <timeZone>.`, `*Full text is not served to agents at this URL (access: <level>).*`, and the truncation note.

`ContactSource.url` is rendered as a bare bullet with no label, because there is no whitelisted word for "the contact URL" and inventing one would put renderer prose in the output. `DocumentKind` and `ActionKind` are advisory routing/telemetry labels and are **never** rendered.

## Security and privacy notes

**A snapshot is not a source of truth.** `DocumentSource.provenance` is set by hosted extraction only. When present, the gateway refuses to serve the document past `ttlSeconds` and falls through to HTML, and a scheduled recrawl auto-unpublishes on content drift. Without that, a merchant changes their hours and agents keep receiving the approved bundle: different substance to agents and humans at the same URL, the exact mismatch this package exists to prevent. This package renders `provenance` documents like any other; **enforcement is the gateway's job**, and extraction integrations need to validate that behavior.

**Prompt injection.** `DocumentSectionSource.body` is untrusted third-party prose delivered inside our structured envelope. A merchant page, or anything a merchant's CMS lets a third party publish, can contain text addressed to the agent reading it. We do not sanitise it, because rewriting merchant prose is exactly what this package must never do; we render it verbatim and it stays the consuming agent's responsibility to treat page content as data, not instructions. Consumers should preserve that trust boundary.

**PII.** `ContactSource`, combined with `kind: 'profile'` or `'job'`, makes it trivial to serve named individuals' contact details in bulk and in a machine-readable form. The merchant is the data controller. Do not use `render-md` to expose contact data that is not already public on the canonical page.

## Frontmatter

`renderFrontmatter` builds an optional YAML block to put in front of any rendered markdown. No renderer adds it on its own, so the outputs above are unchanged.

```ts
import { renderFrontmatter } from '@rebilder/render-md'

renderFrontmatter({
  title: 'Bike fitting',
  description: 'A 90-minute fit on your own bike, with a written report.',
  canonicalUrl: 'https://example.com/services/bike-fitting',
  lastUpdated: '2026-09-28',
})
// ---
// title: Bike fitting
// description: A 90-minute fit on your own bike, with a written report.
// canonical_url: https://example.com/services/bike-fitting
// last_updated: "2026-09-28"
// ---
```

The four keys and the `---` fences are the only text it adds; every value is yours. A value is written bare when YAML reads it back as the same string, and quoted otherwise (a `: `, a leading symbol, a word or number YAML would convert, a line break), so source text cannot end the block early. A `canonicalUrl` that is not absolute `http(s)` and a `lastUpdated` that is not a real ISO 8601 date are dropped. A block over 2 KB drops `description`, then everything. Join it to your markdown with a blank line: `block + '\n' + markdown`. The block moves every fact down by its own length, so position-based measurements such as the Agent Readability Score can change when you add it.

## Versioned compatibility profiles

`applyCompatibilityProfile` accepts `baseline`, `source-envelope`, or
`section-index` at version 1. The latter two add source orientation or existing
heading navigation while preserving all baseline markdown bytes. Additions are
bounded to 1,024 bytes and fall back to baseline when the caller's byte budget
would be exceeded. The returned `profile` identifies what was actually rendered.
These are conservative evaluation candidates, with no claim of empirical model
improvement. See [SDK updates](https://rebilder.com/docs/sdk-updates).

Full docs: [rebilder.com/docs/sources](https://rebilder.com/docs/sources). Release notes are in `CHANGELOG.md` in this package. Licensed under Apache-2.0. Source, issues and pull requests: [GitHub](https://github.com/rebilder/rebilder/tree/main/packages/render-md).

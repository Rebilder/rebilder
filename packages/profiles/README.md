# @rebilder/profiles

**An open, versioned vocabulary of the facts a given kind of page should expose to an AI agent.**

This package is data. Eight JSON documents, one per kind of page, each listing the facts an agent needs from that page and, in one sentence per fact, what the agent does with it.

**Free and unencumbered.** These profiles are published so that they can be used, copied, embedded, disagreed with, and re-implemented by anyone, including people building things that compete with Rebilder. There is no key, no account, no attribution requirement, and no usage limit. We would rather the vocabulary win than own it.

```sh
npm install @rebilder/profiles
```

**Zero runtime dependencies. JSON is the distribution format**, precisely so a Go, Python, Ruby, or PHP implementation can read `profiles/place.json` with its standard library and never touch this package's TypeScript. The TypeScript export is a convenience for JavaScript consumers, not the privileged reading of the spec.

---

## What a profile is

A profile answers one question: *given that this page is a product page (or a location, or an FAQ), which facts does a calling agent need, and which merely help?*

```jsonc
{
  "id": "place",
  "version": "0.1.0",
  "label": "Place or location page",
  "required": [
    {
      "name": "hours",
      "label": "Opening hours",
      "types": ["hours"],
      "why": "The agent answers \"are they open\" from the hours table; a graphic of the same hours answers nothing."
    }
    // …
  ],
  "recommended": [ /* … */ ],
  "actions": ["book", "contact"],
  "jsonLdType": "LocalBusiness"
}
```

| Field | Meaning |
|---|---|
| `id` | Stable, unique, kebab-case. For the eight launch profiles this is also an ARS page kind. |
| `version` | SemVer of **this profile document alone**. Profiles version independently of each other and of the package. |
| `label` | Human-facing name of the page kind. |
| `extends` | *(optional)* Id of a profile this one builds on. Unused by the launch eight; see below. |
| `required` | Facts an agent needs to use the page at all. A missing one is a real failure. |
| `recommended` | Facts that materially improve the answer an agent can give. A missing one is a gap, not a failure. |
| `actions` | Action kinds this page kind should offer, from the `ActionSource.kind` vocabulary in `@rebilder/render-md`. Empty is meaningful: a collection page has no call to action of its own; the items it links to carry theirs. |
| `jsonLdType` | *(optional)* The schema.org type that best fits this page kind. Absent on `unknown`, deliberately. |

Each entry in `required` / `recommended` is a **`FactSpec`**:

| Field | Meaning |
|---|---|
| `name` | Stable machine name, kebab-case. The join key: what a scanner reports as observed, what a consumer diffs a page against. |
| `label` | Human-facing display label, e.g. `Opening hours`. Never a machine key. |
| `types` | Value shapes this fact may legitimately take, most typical first. More than one entry means the fact is genuinely polymorphic (an address is one string or a list of lines), not that we were undecided. |
| `why` | **One sentence: what the calling agent does with this fact.** |

### `why` is the point

A list of field names is a chore. `why` is the argument. Every sentence is about the caller, present tense, and says what breaks without the fact: *"a bare number is not a price, and the agent cannot compare it to anything without the ISO currency code"* rather than *"currency is recommended for completeness"*. A test enforces one sentence per fact; if a `why` has grown into a paragraph it has stopped being an argument and become documentation.

### A profile is a recommendation, never a schema

Nothing validates a page against a profile. Nothing is rejected for failing one. A profile exists so that *"make this page readable by agents"* is a finite, checkable list instead of a feeling.

---

## The eight launch profiles

| Profile | Required facts | Recommended facts |
|---|---|---|
| `product` | title, price, currency, availability | brand, sku, shipping, returns, description |
| `collection` | title, item-count, item-link | price, availability, description |
| `article` | title, author, published | updated, section, description |
| `place` | org-name, address, hours, phone | email, service-area, primary-action-url, description |
| `service` | title, price, primary-action-url | duration, eligibility, service-area, description, updated |
| `faq` | title, question-answer | updated, description |
| `document` | title, updated, authority | description, primary-action-url, section |
| `unknown` | title, description, primary-action-url | updated, org-name |

These eight are the page kinds the **Agent Readability Score** classifies into, and the `required` / `recommended` split here is exactly the `core` / `extended` split ARS scores against. That is not a coincidence to be maintained by care: tests compare the shipped JSON with the ARS scorer's own profiles on both names and order, so the vocabulary and the score cannot silently diverge.

`unknown` is not an escape hatch. It carries three required facts of its own, and a page that hides its kind gains nothing.

## Usage

```ts
import { getProfile, ALL_PROFILES } from '@rebilder/profiles'
import type { SiteProfile, FactSpec, FactName, FactValueType } from '@rebilder/profiles'

const place = getProfile('place')       // SiteProfile | undefined
for (const fact of place?.required ?? []) {
  console.log(`${fact.label}: ${fact.why}`)
}
```

`getProfile` returns `undefined` for an id we do not ship, rather than throwing: an unrecognised page kind is a normal outcome, and the caller decides whether to fall back to `unknown` or to skip fact checking entirely.

From anywhere else, read the JSON directly:

```bash
cat node_modules/@rebilder/profiles/profiles/place.json
```

There is no resolution, validation, or merging in this package, by design. Anything that computes over a profile belongs in the consumer.

---

## Versioning rule

Each profile document carries its own SemVer in `version`, and profiles version independently: adding a fact to `service` does not touch `article`.

| Change | Bump |
|---|---|
| Reword a `label`, a `why`, or the profile `label` | **PATCH** |
| Add a fact to `recommended`; add a value type to a fact's `types`; add an action; add `jsonLdType` where there was none | **MINOR** |
| Add a fact to `required`; promote a fact from `recommended` to `required`; remove or rename any fact; remove a value type; change `jsonLdType`; change `id` | **MAJOR** |

The rule behind the table: **a change is MAJOR when a page that satisfied the old profile no longer satisfies the new one.** Adding a required fact does that; adding a recommended one does not.

A profile id, once published, is never reused for a different page kind. Retiring a profile means publishing a MAJOR that says so, not deleting the file.

The package version is not the profile version and carries no promise about any individual profile. Read `version` in the JSON.

**Scores computed under different profile versions are not comparable.** If you publish a number derived from these profiles, publish the profile version next to it.

## How to propose a new profile

Send a proposal to [support@rebilder.com](mailto:support@rebilder.com) with:

1. **The JSON.** One file, `profiles/<id>.json`, matching the shape above, starting at `version: "0.1.0"`.
2. **A real page.** A link to at least one live page of this kind that is not ours. A profile derived from an imagined page encodes an imagined problem.
3. **A `why` per fact** that survives the test in the first paragraph of this section: one sentence, about what the agent does with the fact, not about why it is nice to have.
4. **The case for a new profile rather than facts on an existing one.** Most proposals are not new page kinds. A dentist's location page is a `place`; a SaaS pricing page is a `collection` of `service`. Reach for `extends` first.

Third-party profiles are not restricted to the exported `FactName` union. That closed set exists because the eight launch profiles are scored by ARS, and a name ARS does not know is a name it cannot count. A proposed profile that needs a new fact name should say so explicitly; adding one is a decision about the score as much as about the vocabulary.

### `extends`

A profile may name another profile in `extends`. The merge rule for consumers that implement it: **parent facts first, then the child's, deduplicating by `name`, with the child's entry winning.**

None of the eight launch profiles use it. They are the base vocabulary and must be readable with a single JSON parse and no resolution step, so that a consumer in another language can start with zero merge logic. `extends` exists so a vertical profile can add facts without restating the base (`dentist` extends `place`), and it is checked by test the moment one appears.

## Relationship to the rest of Rebilder

- **`@rebilder/render-md`** renders facts into agent-facing markdown. `FactValueType` here is deliberately identical to the `type` discriminants of its `FactValue` union; it is restated rather than imported so that this package keeps zero dependencies.
- **`@rebilder/agent-readability`** scores a page against the profile for its detected page kind. The dependency direction is one-way: it may read this package; this package depends on nothing.
- **`@rebilder/gateway`** never reads profiles. Nothing on the serving hot path does: a profile is advice to a merchant, not a runtime input.

Full specification: [rebilder.com/spec/ars](https://rebilder.com/spec/ars). Release notes are in `CHANGELOG.md` in this package. Licensed under Apache-2.0. Source, issues and pull requests: [GitHub](https://github.com/rebilder/rebilder/tree/main/packages/profiles).

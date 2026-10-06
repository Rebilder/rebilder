# @rebilder/render-md changelog

Notable changes to `@rebilder/render-md`. Dates are the day each version reached npm.

## Unreleased

## 0.4.1 (2026-10-06)

- The source code is public at https://github.com/rebilder/rebilder/tree/main/packages/render-md. `repository` and `bugs` point there, and issues and pull requests are welcome.

## 0.4.0 (2026-09-28)

- `renderFrontmatter(fields)` renders an optional YAML frontmatter block (`title`, `description`, `canonical_url`, `last_updated`) from values you pass. Invalid URLs and dates are dropped. A value is written bare when YAML reads it back as the same string and double-quoted otherwise, so source text cannot end the block. The block is capped at 2 KB. No renderer calls it, so every existing output is byte-for-byte unchanged.
- **Requires Node.js 22 or later.** `engines.node` moves from `>=20.11.0` to `>=22`; Node.js 20 reached end of life in April 2026. Edge runtimes are unaffected.
- README: an install example whose output is tested, absolute links, and no internal references. Better package description and keywords. This changelog now ships in the package.

## 0.3.0 (2026-09-13)

- `applyCompatibilityProfile` with three compiled-in, versioned presentation profiles: `baseline`, `source-envelope` and `section-index`. The candidates add bounded source orientation or heading navigation while keeping every baseline byte, and fall back to the baseline when invalid or over the caller's byte budget. The returned `profile` names what was actually rendered. Existing renderers and source facts are unchanged.

## 0.2.0 (2026-08-26)

- `renderCollectionJsonLd`: a collection as a schema.org `ItemList` of positioned `ListItem`s.
- Optional `updated` and `language` on `ProductSource` (and `CollectionSource`), emitted as `dateModified` and `inLanguage` in JSON-LD and as an `Updated` line in markdown. Invalid values are dropped from every representation, never repaired.
- The frozen commerce output is byte-for-byte unchanged.

## 0.1.1 (2026-08-11)

- Package metadata points at rebilder.com for help instead of a private repository. No code change.

## 0.1.0 (2026-08-10)

First release.

- Deterministic markdown and JSON-LD renderers for products, policies and catalogs, and for any other page through `DocumentSource` and `CollectionSource`: typed facts, opening hours, contact details, actions and prose, facts first.
- Every substantive value is copied from the source; the only added text is a fixed, documented scaffolding set. Malformed values are dropped, never repaired, and non-integer money throws rather than rounds.
- A byte budget truncates from the bottom on whole lines, and restricted-access documents never emit their prose.

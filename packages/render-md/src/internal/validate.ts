/**
 * Value-shape validators shared by the commerce and document renderers.
 *
 * `isIsoDate` was moved here verbatim from `documents/facts.ts` when the
 * commerce renderers gained `updated`. Same reasoning as `internal/budget.ts`:
 * a date the document renderer accepts and the product renderer rejects is two
 * validation behaviours that will drift, and the two now serve the same field
 * name on two source types. `documents/facts.ts` re-exports it so its existing
 * importers are unchanged.
 *
 * Every validator here is a **gate, not a transform**. A value that passes is
 * emitted byte-for-byte as the merchant supplied it; a value that fails is
 * dropped, never corrected, normalised, or re-cased. Correcting a malformed
 * value would make this package originate one (source validation), and re-casing a
 * language tag would mean the JSON-LD disagreed with the merchant's own page.
 *
 * Package-internal. Nothing here is part of the public contract.
 */

/** ISO 8601 date or datetime. Structure first, then real-calendar check. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/

/**
 * `Date.parse` alone does NOT implement the real-calendar half this function
 * has always claimed. It rejects a month above 12 and a day above 31, but a
 * day that overflows its own month rolls silently forward:
 *
 *     Date.parse('2026-02-31')  → March 3      (not NaN)
 *     Date.parse('2026-02-29')  → March 1      (2026 is not a leap year)
 *     Date.parse('2026-04-31')  → May 1        (April has 30 days)
 *
 * So the pre-existing check passed three dates that do not exist, and the
 * renderers emitted them verbatim. Harmless-looking in a markdown line; not
 * harmless as `dateModified` in a product feed, where a date is a fact a
 * caller may act on. Round-tripping the calendar portion is what actually
 * enforces the docstring: build the date from its parts and require that the
 * parts survive.
 *
 * `setUTCFullYear` rather than `Date.UTC` because the latter maps years 0–99
 * onto 1900–1999, which would false-reject a four-digit year like `0026`.
 */
function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number]
  const probe = new Date(0)
  probe.setUTCFullYear(year, month - 1, day)
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) && isRealCalendarDate(value)
}

/**
 * BCP 47 language tag, restricted to the forms that actually appear on
 * commerce and content pages: language, optional script, optional region.
 *
 * `en` · `en-US` · `pt-BR` · `zh-Hant` · `zh-Hant-TW` · `es-419`
 *
 * Deliberately NOT the full grammar (RFC 5646 admits extensions, private-use
 * subtags and grandfathered tags). A tag this regex rejects is dropped rather
 * than guessed at, and the page simply declares no language — which is the
 * status quo for every page served before this field existed. Widening the
 * grammar later is additive; emitting a malformed `inLanguage` into a product
 * feed is not something a later release can retract.
 *
 * Case is validated leniently and preserved exactly: BCP 47 is
 * case-insensitive, so `EN-us` is a valid tag and rejecting it would punish a
 * merchant for a spelling the standard allows.
 */
const BCP_47 = /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-(?:[A-Za-z]{2}|\d{3}))?$/

export function isLanguageTag(value: string): boolean {
  return BCP_47.test(value)
}

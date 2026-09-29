/** Conservative, compiled-in presentation strategies. No remote code or prose. */
export interface CompatibilityProfile {
  id: 'baseline' | 'source-envelope' | 'section-index'
  version: 1
}

export const BASELINE_PROFILE: Readonly<CompatibilityProfile> = Object.freeze({
  id: 'baseline',
  version: 1,
})
export const COMPATIBILITY_RUNTIME_VERSION = 1

export function validateCompatibilityProfile(value: unknown): CompatibilityProfile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const profile = value as Record<string, unknown>
  if (Object.keys(profile).some((key) => key !== 'id' && key !== 'version')) return null
  if (
    profile.version !== 1 ||
    typeof profile.id !== 'string' ||
    !['baseline', 'source-envelope', 'section-index'].includes(profile.id)
  )
    return null
  return { id: profile.id as CompatibilityProfile['id'], version: 1 }
}

export interface CompatibilityRendering {
  markdown: string
  /** Actual presentation served, including budget/invalid-selection fallback. */
  profile: CompatibilityProfile
}

/**
 * Baseline markdown stays a contiguous, byte-identical substring. Candidates
 * add orientation only; they cannot rewrite, remove or reorder any source fact
 * or qualification. Existing renderer truncation still applies. If additions
 * do not fit the caller's budget, use the baseline and report that honestly.
 */
export function applyCompatibilityProfile(
  markdown: string,
  selected: unknown,
  options: { canonicalUrl: string; maxBytes?: number },
): CompatibilityRendering {
  const profile = validateCompatibilityProfile(selected) ?? BASELINE_PROFILE
  const baseline = { markdown, profile: { ...BASELINE_PROFILE } }
  if (profile.id === 'baseline') return baseline
  let prefix = ''
  if (profile.id === 'source-envelope') {
    let canonical: URL
    try {
      canonical = new URL(options.canonicalUrl)
    } catch {
      return baseline
    }
    if (
      !['https:', 'http:'].includes(canonical.protocol) ||
      canonical.username ||
      canonical.password
    )
      return baseline
    // JSON encoding makes line breaks and markdown delimiters inert metadata.
    prefix = `Source: ${JSON.stringify(canonical.href)}\n\n`
  } else {
    // Navigation duplicates only existing headings; merchant text remains intact.
    const headings = markdown
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .slice(0, 12)
    if (headings.length < 2) return baseline
    prefix = `Sections on this page:\n${headings.map((line) => `- ${line.replace(/^#{1,6} /, '')}`).join('\n')}\n\n`
  }
  const output = prefix + markdown
  const bytes = new TextEncoder().encode(output).byteLength
  if (new TextEncoder().encode(prefix).byteLength > 1024 || bytes > (options.maxBytes ?? 5120))
    return baseline
  return { markdown: output, profile }
}

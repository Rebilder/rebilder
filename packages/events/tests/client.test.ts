/**
 * ClientEventV0 — the Rebilder Tag wire contract (src/client.ts, 0.5.0).
 *
 * The module is type-only, so what a test can pin is the SHAPE: the exact
 * wire field names the tag serializes (a rename here silently orphans every
 * embedded tag in the wild — the tag has no version negotiation), which
 * fields are optional, and that the type reaches consumers through the
 * package root rather than a deep import.
 */
import { describe, expect, it } from 'vitest'
import type { ClientEventV0 } from '../src/index'

describe('ClientEventV0', () => {
  it('describes the beacon payload: store + path required, ref + wd optional', () => {
    const minimal: ClientEventV0 = {
      store: 'aaaaaaaa-0000-4000-8000-000000000042',
      path: '/',
    }
    const full: ClientEventV0 = {
      store: 'aaaaaaaa-0000-4000-8000-000000000042',
      path: '/products/pack',
      ref: 'https://chatgpt.com/c/abc',
      wd: true,
    }
    // The wire field names, exactly — the tag serializes these keys and the
    // endpoint parses them; neither can move without the other.
    expect(Object.keys(full).sort()).toEqual(['path', 'ref', 'store', 'wd'])
    expect(minimal.ref).toBeUndefined()
    expect(minimal.wd).toBeUndefined()
  })

  it('serializes to the compact body the tag actually sends', () => {
    const event: ClientEventV0 = { store: 's', path: '/p', wd: false }
    // text/plain JSON, no envelope, no schema_version field on the wire —
    // versioning lives in this package and the endpoint, not in every beacon.
    expect(JSON.parse(JSON.stringify(event))).toEqual({ store: 's', path: '/p', wd: false })
  })
})

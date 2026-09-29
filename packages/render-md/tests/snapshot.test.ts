import { describe, expect, it } from 'vitest'
import {
  renderCatalogMarkdown,
  renderPolicyMarkdown,
  renderProductJsonLd,
  renderProductMarkdown,
} from '../src/index'
import { catalog, pdp, policies } from './fixtures/pdp'

/**
 * Snapshot coverage for a full realistic PDP. The renderers are pure and
 * deterministic, so any diff here is a deliberate contract change.
 */
describe('snapshots', () => {
  it('full PDP markdown', () => {
    expect(renderProductMarkdown(pdp)).toMatchSnapshot()
  })

  it('full PDP JSON-LD', () => {
    expect(JSON.stringify(renderProductJsonLd(pdp), null, 2)).toMatchSnapshot()
  })

  it('policies markdown', () => {
    expect(renderPolicyMarkdown(policies)).toMatchSnapshot()
  })

  it('catalog markdown', () => {
    expect(renderCatalogMarkdown(catalog)).toMatchSnapshot()
  })
})

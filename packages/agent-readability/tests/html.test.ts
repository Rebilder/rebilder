import { describe, expect, it } from 'vitest'
import {
  attr,
  countedText,
  decodeEntities,
  elementText,
  tokenizeHtml,
  type HtmlDocument,
} from '../src/html'

/** UTF-8 byte length, computed independently of the tokenizer's own cursor. */
const encoder = new TextEncoder()
const utf8 = (s: string): number => encoder.encode(s).length

const tagsOf = (doc: HtmlDocument): string[] => doc.elements.map((e) => e.tag)
const countedNodes = (doc: HtmlDocument): string[] =>
  doc.texts.filter((t) => t.excludedBy === null).map((t) => t.text)

describe('tags and attributes', () => {
  it('lowercases tag and attribute names and keeps value case', () => {
    const doc = tokenizeHtml('<DIV CLASS="Hero" data-Test="A">x</DIV>')
    expect(tagsOf(doc)).toEqual(['div'])
    expect(doc.elements[0]?.attrs).toEqual({ class: 'Hero', 'data-test': 'A' })
  })

  it('accepts single-quoted, unquoted and valueless attributes', () => {
    const doc = tokenizeHtml("<a href='/x' target=_blank download>go</a>")
    expect(doc.elements[0]?.attrs).toEqual({ href: '/x', target: '_blank', download: '' })
  })

  it('keeps the first occurrence of a duplicated attribute (HTML5 rule)', () => {
    const doc = tokenizeHtml('<p id="first" id="second">x</p>')
    expect(attr(doc.elements[0]!, 'id')).toBe('first')
  })

  it('decodes entities in attribute values', () => {
    const doc = tokenizeHtml('<a href="/s?a=1&amp;b=2" title="Caf&eacute;">x</a>')
    expect(attr(doc.elements[0]!, 'href')).toBe('/s?a=1&b=2')
    // `eacute` is outside the pinned table: left verbatim rather than guessed.
    expect(attr(doc.elements[0]!, 'title')).toBe('Caf&eacute;')
  })

  it('does not treat void elements as containers', () => {
    const doc = tokenizeHtml('<div><br><img src="a.png">after</div>')
    const text = doc.texts.find((t) => t.text.includes('after'))
    expect(doc.elements[text!.parent]?.tag).toBe('div')
  })

  it('records parent and depth', () => {
    const doc = tokenizeHtml('<main><section><h1>Title</h1></section></main>')
    expect(doc.elements.map((e) => e.depth)).toEqual([0, 1, 2])
    expect(doc.elements[2]?.parent).toBe(1)
  })
})

describe('byte offsets', () => {
  it('reports UTF-8 byte offsets, not string indices', () => {
    // The em dash and the euro sign are 3 bytes each in UTF-8; a naive string
    // index would put the price 4 bytes earlier than it really is.
    const html = '<p>Café — the price is</p><span>€49,00</span>'
    const doc = tokenizeHtml(html)
    const price = doc.texts.find((t) => t.text.includes('49'))
    expect(price?.offset).toBe(utf8(html.slice(0, html.indexOf('€49,00'))))
    expect(price?.offset).not.toBe(html.indexOf('€49,00'))
  })

  it('reports the total decoded byte length', () => {
    const html = '<p>¥4,900 — 送料無料</p>'
    expect(tokenizeHtml(html).bytes).toBe(utf8(html))
  })

  it('measures a text node in raw source bytes, before entity decoding', () => {
    const html = '<p>a&amp;b</p>'
    const node = tokenizeHtml(html).texts[0]
    expect(node?.text).toBe('a&b')
    expect(node?.bytes).toBe(utf8('a&amp;b'))
  })

  it('handles astral characters and lone surrogates without drifting', () => {
    const html = '<p>\u{1F600}</p><p>\ud800</p><p>end</p>'
    const doc = tokenizeHtml(html)
    expect(doc.bytes).toBe(utf8(html))
    const end = doc.texts.find((t) => t.text === 'end')
    expect(end?.offset).toBe(utf8(html.slice(0, html.lastIndexOf('end'))))
  })

  it('gives element offsets at the opening angle bracket', () => {
    const html = '<div>—</div><span>x</span>'
    const doc = tokenizeHtml(html)
    expect(doc.elements[1]?.offset).toBe(utf8('<div>—</div>'))
  })
})

describe('normative counted-text rule (§3.6)', () => {
  it('counts ordinary text', () => {
    const doc = tokenizeHtml('<h1>Merino Crew</h1><p>$148.00</p>')
    expect(countedText(doc)).toBe('Merino Crew $148.00')
  })

  it('excludes script, style and template', () => {
    const doc = tokenizeHtml(
      '<script>var price = 1</script><style>.a{color:red}</style>' +
        '<template><p>tpl</p></template><p>real</p>',
    )
    expect(countedText(doc)).toBe('real')
    expect(doc.texts.map((t) => t.excludedBy)).toContain('script')
    expect(doc.texts.map((t) => t.excludedBy)).toContain('style')
    expect(doc.texts.map((t) => t.excludedBy)).toContain('template')
  })

  it('excludes the hidden attribute, whatever its value', () => {
    const doc = tokenizeHtml('<p hidden>a</p><p hidden="until-found">b</p><p>c</p>')
    expect(countedText(doc)).toBe('c')
  })

  it('excludes inline display:none in its spacing variants', () => {
    const doc = tokenizeHtml(
      '<p style="display:none">a</p>' +
        '<p style="DISPLAY : NONE">b</p>' +
        '<p style="color:red;display:none !important;">c</p>' +
        '<p style="display:block">d</p>',
    )
    expect(countedText(doc)).toBe('d')
  })

  it('does no CSS resolution — a class that hides an element does not', () => {
    const doc = tokenizeHtml('<style>.hide{display:none}</style><p class="hide">still counted</p>')
    expect(countedText(doc)).toBe('still counted')
  })

  it('inherits exclusion into descendants', () => {
    const doc = tokenizeHtml('<div hidden><section><p>deep</p></section></div><p>shown</p>')
    expect(countedText(doc)).toBe('shown')
  })

  it('does not count JSON-LD as visible text, and surfaces it separately', () => {
    const html = '<script type="application/ld+json">{"price":"148.00"}</script><p>$198.00</p>'
    const doc = tokenizeHtml(html)
    expect(countedText(doc)).toBe('$198.00')
    expect(doc.jsonLd).toHaveLength(1)
    expect(doc.jsonLd[0]?.text).toBe('{"price":"148.00"}')
    expect(doc.jsonLd[0]?.offset).toBe(utf8(html.slice(0, html.indexOf('{"price"'))))
    expect(doc.texts[0]?.excludedBy).toBe('script-ld-json')
  })

  it('joins adjacent inline elements with a space rather than concatenating', () => {
    expect(countedText(tokenizeHtml('<p><b>Blue</b><i>Shirt</i></p>'))).toBe('Blue Shirt')
  })
})

describe('raw text and RCDATA', () => {
  it('does not decode entities inside script (raw text)', () => {
    const doc = tokenizeHtml('<script type="application/ld+json">{"n":"a&amp;b"}</script>')
    expect(doc.jsonLd[0]?.text).toBe('{"n":"a&amp;b"}')
  })

  it('decodes entities inside title (RCDATA)', () => {
    const doc = tokenizeHtml('<title>Caf&amp;Bar</title>')
    expect(countedNodes(doc)).toEqual(['Caf&Bar'])
  })

  it('does not treat markup inside script as tags', () => {
    const doc = tokenizeHtml('<script>if (a < b) { x("</p>") }</script><p>after</p>')
    expect(tagsOf(doc)).toEqual(['script', 'p'])
    expect(countedText(doc)).toBe('after')
  })

  it('handles a JSON-LD type parameter on the content type', () => {
    const doc = tokenizeHtml('<script type="application/ld+json; charset=utf-8">{}</script>')
    expect(doc.jsonLd).toHaveLength(1)
  })

  it('recovers from an unterminated script', () => {
    const doc = tokenizeHtml('<p>a</p><script>never closed')
    expect(countedText(doc)).toBe('a')
  })
})

describe('meta and link extraction', () => {
  it('reads the meta variants ARS scores against', () => {
    const doc = tokenizeHtml(
      '<meta charset="UTF-8">' +
        '<meta name="Author" content="Ada">' +
        '<meta property="og:type" content="product">' +
        '<meta http-equiv="Content-Type" content="text/html">' +
        '<meta itemprop="name" content="Acme">',
    )
    expect(doc.metas.map((m) => m.charset)).toContain('utf-8')
    expect(doc.metas.find((m) => m.name === 'author')?.content).toBe('Ada')
    expect(doc.metas.find((m) => m.property === 'og:type')?.content).toBe('product')
    expect(doc.metas.find((m) => m.httpEquiv === 'content-type')).toBeDefined()
    expect(doc.metas.find((m) => m.itemprop === 'name')?.content).toBe('Acme')
  })

  it('splits a multi-value rel into a deduplicated token list', () => {
    const doc = tokenizeHtml(
      '<link rel="Alternate  CANONICAL alternate" href="/p.md" type="text/markdown">',
    )
    expect(doc.links[0]?.rel).toEqual(['alternate', 'canonical'])
    expect(doc.links[0]?.type).toBe('text/markdown')
    expect(doc.links[0]?.href).toBe('/p.md')
  })

  it('reports rel as an empty list when absent', () => {
    expect(tokenizeHtml('<link href="/x">').links[0]?.rel).toEqual([])
  })
})

describe('elementText', () => {
  it('returns the counted text of one subtree', () => {
    const doc = tokenizeHtml('<nav><a href="/buy"><span>Buy</span> now</a></nav><p>other</p>')
    const anchor = doc.elements.findIndex((e) => e.tag === 'a')
    expect(elementText(doc, anchor)).toBe('Buy now')
  })

  it('omits hidden text unless asked for it', () => {
    const doc = tokenizeHtml('<div><span hidden>$1.00</span><span>$2.00</span></div>')
    const div = doc.elements.findIndex((e) => e.tag === 'div')
    expect(elementText(doc, div)).toBe('$2.00')
    expect(elementText(doc, div, true)).toBe('$1.00 $2.00')
  })
})

describe('tolerant recovery', () => {
  it('closes implied end tags for list and table items', () => {
    const doc = tokenizeHtml('<ul><li>a<li>b</ul>')
    const items = doc.elements.filter((e) => e.tag === 'li')
    expect(items).toHaveLength(2)
    expect(items[1]?.depth).toBe(items[0]?.depth)
  })

  it('does not nest a dd inside its dt', () => {
    const doc = tokenizeHtml('<dl><dt>Q<dd>A</dl>')
    const dt = doc.elements.find((e) => e.tag === 'dt')
    const dd = doc.elements.find((e) => e.tag === 'dd')
    expect(dd?.parent).toBe(dt?.parent)
  })

  it('closes an open p at a block start', () => {
    const doc = tokenizeHtml('<p>one<div>two</div>')
    const div = doc.elements.find((e) => e.tag === 'div')
    expect(div?.depth).toBe(0)
  })

  it('ignores a stray end tag', () => {
    const doc = tokenizeHtml('</span><p>ok</p>')
    expect(countedText(doc)).toBe('ok')
  })

  it('treats a bare < as text', () => {
    expect(countedText(tokenizeHtml('<p>a < b and 3<4</p>'))).toBe('a < b and 3<4')
  })

  it('skips comments, doctypes and bogus comments', () => {
    const doc = tokenizeHtml('<!DOCTYPE html><!-- hidden --><![CDATA[x]]><p>shown</p>')
    expect(countedText(doc)).toBe('shown')
  })

  it('recovers from an unterminated comment and an unterminated tag', () => {
    expect(() => tokenizeHtml('<p>a</p><!-- never closed')).not.toThrow()
    expect(() => tokenizeHtml('<div class="x')).not.toThrow()
  })

  it('caps open-element depth without losing elements', () => {
    const doc = tokenizeHtml('<div>'.repeat(2000) + 'deep')
    expect(doc.elements).toHaveLength(2000)
    expect(countedText(doc)).toBe('deep')
  })
})

describe('robustness: it never throws (fixture 057-tokenizer-fuzz)', () => {
  /** Deterministic 32-bit LCG. No Math.random: this file must be reproducible. */
  function lcg(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x100000000
    }
  }

  const ALPHABET = [
    '<',
    '>',
    '/',
    '=',
    '"',
    "'",
    '&',
    ';',
    '#',
    '!',
    '-',
    ' ',
    '\n',
    '\t',
    'a',
    'z',
    '0',
    '9',
    'div',
    'script',
    'style',
    'template',
    'hidden',
    '<!--',
    '-->',
    '</',
    '<![CDATA[',
    ']]>',
    '&#',
    '&amp;',
    '€',
    '—',
    '\u{1F600}',
    '\ud800',
    '\udfff',
    'type="application/ld+json"',
    'style="display:none"',
  ]

  it('survives 2000 pseudo-random documents', () => {
    const random = lcg(0x5eed)
    for (let iteration = 0; iteration < 2000; iteration++) {
      const length = 1 + Math.floor(random() * 60)
      let source = ''
      for (let i = 0; i < length; i++) {
        source += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? ''
      }
      expect(
        () => {
          const doc = tokenizeHtml(source)
          countedText(doc)
          if (doc.elements.length > 0) elementText(doc, 0)
        },
        `seeded input: ${JSON.stringify(source)}`,
      ).not.toThrow()
    }
  })

  it('survives targeted truncations of a well-formed document', () => {
    const full =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<script type="application/ld+json">{"@type":"Product","offers":{"price":"148.00"}}</script>' +
      '<link rel="alternate canonical" href="/p.md"></head>' +
      '<body><h1>Merino Crew</h1><p style="display:none">hidden</p>' +
      '<p>$148.00 — in stock</p></body></html>'
    for (let cut = 0; cut <= full.length; cut++) {
      expect(() => countedText(tokenizeHtml(full.slice(0, cut))), `cut at ${cut}`).not.toThrow()
    }
  })

  it('reports byte totals that match TextEncoder for every truncation', () => {
    const source = '<p>€1,00 — \u{1F600}</p>'
    for (let cut = 0; cut <= source.length; cut++) {
      const slice = source.slice(0, cut)
      expect(tokenizeHtml(slice).bytes, `cut at ${cut}`).toBe(utf8(slice))
    }
  })

  it('is deterministic: the same input yields the same output', () => {
    const source = '<div><p>$1,499.00</p><script>x</script></div>'
    expect(JSON.stringify(tokenizeHtml(source))).toBe(JSON.stringify(tokenizeHtml(source)))
  })
})

describe('decodeEntities', () => {
  it('decodes the pinned named references', () => {
    expect(decodeEntities('&pound;5 &amp; &euro;6&nbsp;each')).toBe('£5 & €6 each')
  })

  it('decodes decimal and hex numeric references', () => {
    expect(decodeEntities('&#36;5 &#x24;6 &#8364;7')).toBe('$5 $6 €7')
  })

  it('applies the windows-1252 override for C1 numeric references', () => {
    expect(decodeEntities('It&#146;s')).toBe('It’s')
  })

  it('replaces invalid code points with U+FFFD', () => {
    expect(decodeEntities('&#0;&#xD800;')).toBe('��')
  })

  it('requires the trailing semicolon, so query strings survive', () => {
    expect(decodeEntities('/s?a=1&copy=2')).toBe('/s?a=1&copy=2')
  })

  it('leaves unknown named references verbatim', () => {
    expect(decodeEntities('&hearts;')).toBe('&hearts;')
  })
})

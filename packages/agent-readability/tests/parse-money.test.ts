import { describe, expect, it } from 'vitest'
import { minorUnitDigits, parseMoneyText } from '../src/parse-money'

/** Compact assertion helper: text (+ hints) → amount in minor units and currency. */
const money = (amount: number, currency: string, qualified = false) => ({
  amount,
  currency,
  qualified,
})

describe('leading and trailing symbols (§3.11 format list)', () => {
  it('parses a leading symbol with group and decimal separators', () => {
    expect(parseMoneyText('$1,499.00')).toEqual(money(149900, 'USD'))
  })

  it('parses a trailing symbol with the European separator convention', () => {
    expect(parseMoneyText('1.499,00 €')).toEqual(money(149900, 'EUR'))
  })

  it('parses a zero-decimal currency without inventing minor units', () => {
    expect(parseMoneyText('¥4,900')).toEqual(money(4900, 'JPY'))
  })

  it('parses the remaining single-character symbols', () => {
    expect(parseMoneyText('€49')).toEqual(money(4900, 'EUR'))
    expect(parseMoneyText('£5.50')).toEqual(money(550, 'GBP'))
    expect(parseMoneyText('₹1,200')).toEqual(money(120000, 'INR'))
    expect(parseMoneyText('49 zł')).toEqual(money(4900, 'PLN'))
  })

  it('prefers the longest matching symbol', () => {
    expect(parseMoneyText('CA$5.00')).toEqual(money(500, 'CAD'))
    expect(parseMoneyText('US$5.00')).toEqual(money(500, 'USD'))
    expect(parseMoneyText('A$5.00')).toEqual(money(500, 'AUD'))
  })

  it('tolerates surrounding label text as long as there is one number', () => {
    expect(parseMoneyText('Price: $49.00')).toEqual(money(4900, 'USD'))
    expect(parseMoneyText('Sale price $49.00')).toEqual(money(4900, 'USD'))
  })

  it('parses negatives in both positions', () => {
    expect(parseMoneyText('-£5.50')).toEqual(money(-550, 'GBP'))
    expect(parseMoneyText('$-5.00')).toEqual(money(-500, 'USD'))
  })
})

describe('ISO code prefix and suffix', () => {
  it('parses a code before and after the number', () => {
    expect(parseMoneyText('USD 1499')).toEqual(money(149900, 'USD'))
    expect(parseMoneyText('1499 USD')).toEqual(money(149900, 'USD'))
  })

  it('accepts a code and a symbol that agree', () => {
    expect(parseMoneyText('$5.00 CAD')).toEqual(money(500, 'CAD'))
  })

  it('rejects a code and a symbol that disagree', () => {
    expect(parseMoneyText('$49.00 EUR')).toBeNull()
  })

  it('rejects a three-letter token that is not an ISO 4217 code', () => {
    expect(parseMoneyText('50 OFF')).toBeNull()
    expect(parseMoneyText('OFF 50')).toBeNull()
  })

  it('requires the code to be adjacent to the number', () => {
    expect(parseMoneyText('USD is the currency; price 1499')).toBeNull()
  })
})

describe('separator disambiguation', () => {
  it('reads the last of two separator kinds as the decimal point', () => {
    expect(parseMoneyText('$1,234,567.89')).toEqual(money(123456789, 'USD'))
    expect(parseMoneyText('€1.234.567,89')).toEqual(money(123456789, 'EUR'))
  })

  it('reads a repeated separator as a group separator', () => {
    expect(parseMoneyText('$1.234.567')).toEqual(money(123456700, 'USD'))
  })

  it('reads a lone separator with three digits after it as a group separator for 2-digit currencies', () => {
    expect(parseMoneyText('$1,500')).toEqual(money(150000, 'USD'))
    expect(parseMoneyText('1.500 €')).toEqual(money(150000, 'EUR'))
  })

  it('reads a lone separator with three digits after it as a group separator for zero-decimal currencies', () => {
    expect(parseMoneyText('¥4,900')).toEqual(money(4900, 'JPY'))
  })

  it('reads a lone separator with a non-three-digit tail as a decimal point', () => {
    expect(parseMoneyText('$1,4')).toEqual(money(140, 'USD'))
    expect(parseMoneyText('$1.5')).toEqual(money(150, 'USD'))
  })

  it('does not read a leading zero as a digit group', () => {
    expect(parseMoneyText('$0.500')).toEqual(money(50, 'USD'))
  })

  it('accepts space, NBSP, narrow NBSP and apostrophe group separators', () => {
    expect(parseMoneyText('1 499,00 €')).toEqual(money(149900, 'EUR'))
    expect(parseMoneyText('1 499,00 €')).toEqual(money(149900, 'EUR'))
    expect(parseMoneyText('1 499,00 €')).toEqual(money(149900, 'EUR'))
    expect(parseMoneyText("1'499.00 CHF")).toEqual(money(149900, 'CHF'))
  })

  it('rejects space-separated digits that are not valid groups', () => {
    expect(parseMoneyText('12 34', { currency: 'USD' })).toBeNull()
    expect(parseMoneyText('1 2 3', { currency: 'USD' })).toBeNull()
    expect(parseMoneyText('1234 567', { currency: 'USD' })).toBeNull()
  })

  it('rejects mixed separator systems', () => {
    expect(parseMoneyText('$1,23.456')).toBeNull()
    expect(parseMoneyText('$1.2.3,45')).toBeNull()
  })
})

describe('minor units', () => {
  it('pads a short fraction to the currency width', () => {
    expect(parseMoneyText('$1.5')).toEqual(money(150, 'USD'))
    expect(parseMoneyText('KWD 1.5')).toEqual(money(1500, 'KWD'))
  })

  it('accepts extra precision only when it is all zeros', () => {
    expect(parseMoneyText('JPY 4900.00')).toEqual(money(4900, 'JPY'))
    expect(parseMoneyText('$1.5000')).toEqual(money(150, 'USD'))
    expect(parseMoneyText('JPY 4900.50')).toBeNull()
    expect(parseMoneyText('$1.4990')).toBeNull()
  })

  it('exposes the minor-unit table', () => {
    expect(minorUnitDigits('JPY')).toBe(0)
    expect(minorUnitDigits('usd')).toBe(2)
    expect(minorUnitDigits('KWD')).toBe(3)
    expect(minorUnitDigits('ZZZ')).toBe(2)
  })

  it('rejects a value too large to represent exactly', () => {
    expect(parseMoneyText('$12345678901234567890')).toBeNull()
  })
})

describe('ambiguity → null (§3.11: fails closed, like formatMoney)', () => {
  it('rejects a bare number with no currency anywhere', () => {
    expect(parseMoneyText('1499')).toBeNull()
    expect(parseMoneyText('1,499.00')).toBeNull()
  })

  it('rejects a lone separator + three digits for a three-decimal currency', () => {
    // 1,500 is one thousand five hundred fils, or 1.500 dinar. Both are valid.
    expect(parseMoneyText('KWD 1,500')).toBeNull()
    expect(parseMoneyText('BHD 1.500')).toBeNull()
    expect(parseMoneyText('1,500', { currency: 'KWD' })).toBeNull()
  })

  it('rejects text containing more than one number', () => {
    expect(parseMoneyText('Save $10 on orders over $50')).toBeNull()
    expect(parseMoneyText('$49.00 (was $79.00)')).toBeNull()
  })

  it('rejects percentages', () => {
    expect(parseMoneyText('20% off')).toBeNull()
    expect(parseMoneyText('$50 (50% off)')).toBeNull()
  })

  it('rejects an unresolvable shared symbol', () => {
    expect(parseMoneyText('kr 199')).toBeNull()
    expect(parseMoneyText('199 kr')).toBeNull()
  })

  it('rejects text with no digits', () => {
    expect(parseMoneyText('Free')).toBeNull()
    expect(parseMoneyText('Contact us for pricing')).toBeNull()
    expect(parseMoneyText('')).toBeNull()
  })

  it('rejects phone numbers and dates that look like ranges', () => {
    expect(parseMoneyText('1-800-555-1212', { currency: 'USD' })).toBeNull()
    expect(parseMoneyText('2024-01-15', { currency: 'USD' })).toBeNull()
  })

  it('rejects input longer than the cap', () => {
    expect(parseMoneyText(`$49.00${' '.repeat(300)}`)).toBeNull()
  })

  it('rejects two disagreeing symbols', () => {
    expect(parseMoneyText('$49.00 €')).toBeNull()
  })
})

describe('hints.currency', () => {
  it('supplies a currency for a bare number', () => {
    expect(parseMoneyText('1499', { currency: 'USD' })).toEqual(money(149900, 'USD'))
    expect(parseMoneyText('4900', { currency: 'JPY' })).toEqual(money(4900, 'JPY'))
  })

  it('refuses to supply one when the text carries other words', () => {
    // With a USD hint, `4.5 stars` would otherwise parse as $4.50.
    expect(parseMoneyText('4.5 stars', { currency: 'USD' })).toBeNull()
    expect(parseMoneyText('Price: 1499', { currency: 'USD' })).toBeNull()
  })

  it('resolves a shared symbol', () => {
    expect(parseMoneyText('$5.00', { currency: 'CAD' })).toEqual(money(500, 'CAD'))
    expect(parseMoneyText('kr 199', { currency: 'SEK' })).toEqual(money(19900, 'SEK'))
    expect(parseMoneyText('kr 199', { currency: 'ISK' })).toEqual(money(199, 'ISK'))
    expect(parseMoneyText('¥4,900', { currency: 'CNY' })).toEqual(money(490000, 'CNY'))
  })

  it('is ignored when it cannot denote the symbol shown', () => {
    // A `£` is not a CAD sign; the hint does not override an unambiguous symbol.
    expect(parseMoneyText('£5.00', { currency: 'CAD' })).toEqual(money(500, 'GBP'))
  })

  it('changes separator disambiguation via the minor-unit width', () => {
    expect(parseMoneyText('$1,500')).toEqual(money(150000, 'USD'))
    expect(parseMoneyText('1,500', { currency: 'JPY' })).toEqual(money(1500, 'JPY'))
    expect(parseMoneyText('1,500', { currency: 'KWD' })).toBeNull()
  })

  it('ignores a hint that is not an ISO 4217 code', () => {
    expect(parseMoneyText('1499', { currency: 'NOPE' })).toBeNull()
  })
})

describe('ranges → lower bound, qualified', () => {
  it('parses a spaced en-dash range', () => {
    expect(parseMoneyText('$148.00 – $198.00')).toEqual(money(14800, 'USD', true))
  })

  it('parses an unspaced hyphen range', () => {
    expect(parseMoneyText('$148-$198')).toEqual(money(14800, 'USD', true))
  })

  it('parses a word range', () => {
    expect(parseMoneyText('$148 to $198')).toEqual(money(14800, 'USD', true))
  })

  it('returns the numerically lower end regardless of order', () => {
    expect(parseMoneyText('$198 – $148')).toEqual(money(14800, 'USD', true))
  })

  it('carries the currency across from whichever end declares it', () => {
    expect(parseMoneyText('$148 – 198')).toEqual(money(14800, 'USD', true))
    expect(parseMoneyText('148 to 198 USD')).toEqual(money(14800, 'USD', true))
  })

  it('rejects a range whose ends disagree on currency', () => {
    expect(parseMoneyText('$148 – €198')).toBeNull()
  })
})

describe('qualifiers → the stated bound, qualified', () => {
  it('parses prefix qualifiers', () => {
    expect(parseMoneyText('From $9')).toEqual(money(900, 'USD', true))
    expect(parseMoneyText('Starting at $9.99')).toEqual(money(999, 'USD', true))
    expect(parseMoneyText('as low as $9')).toEqual(money(900, 'USD', true))
    expect(parseMoneyText('Up to $500')).toEqual(money(50000, 'USD', true))
  })

  it('parses suffix qualifiers', () => {
    expect(parseMoneyText('$9+')).toEqual(money(900, 'USD', true))
    expect(parseMoneyText('$9 and up')).toEqual(money(900, 'USD', true))
    expect(parseMoneyText('$500 or less')).toEqual(money(50000, 'USD', true))
  })

  it('does not treat a word merely starting with a qualifier as one', () => {
    // "Fromage" is not "From": the qualifier must be followed by a non-letter.
    expect(parseMoneyText('Fromage $9')).toEqual(money(900, 'USD'))
  })

  it('leaves an unqualified price unqualified', () => {
    expect(parseMoneyText('$9')?.qualified).toBe(false)
  })
})

describe('purity', () => {
  it('is a pure function of its arguments', () => {
    const inputs = ['$1,499.00', '1.499,00 €', 'From $9', '$148 – $198', 'nonsense']
    for (const input of inputs) {
      expect(parseMoneyText(input)).toEqual(parseMoneyText(input))
    }
  })

  it('never throws, for any of a wide spread of malformed inputs', () => {
    const soup = [
      ',',
      '.',
      '$',
      '$.',
      '$,',
      '$..',
      '$,,,,,,,,,,',
      '1,',
      ',1',
      '1.',
      '.1',
      '$1..2',
      '- -',
      '– –',
      '$1 – ',
      ' – $1',
      '  ',
      "'''",
      '\u{1F600}$5',
      '$5\u{1F600}',
      '\ud800$5',
      '0'.repeat(300),
      '$0',
      '$00.00',
      '000',
    ]
    for (const input of soup) {
      expect(() => parseMoneyText(input), JSON.stringify(input)).not.toThrow()
      expect(() => parseMoneyText(input, { currency: 'USD' }), JSON.stringify(input)).not.toThrow()
    }
  })

  it('parses a genuine zero', () => {
    expect(parseMoneyText('$0')).toEqual(money(0, 'USD'))
    expect(parseMoneyText('$0.00')).toEqual(money(0, 'USD'))
  })
})

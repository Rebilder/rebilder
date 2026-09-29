import { describe, expect, it } from 'vitest'
import { formatMoney } from '../src/index'

describe('formatMoney', () => {
  it('formats USD with symbol and two decimals', () => {
    expect(formatMoney({ amount: 4900, currency: 'USD' })).toBe('$49.00')
    expect(formatMoney({ amount: 5, currency: 'USD' })).toBe('$0.05')
    expect(formatMoney({ amount: 0, currency: 'USD' })).toBe('$0.00')
  })

  it('formats EUR and GBP with their symbols', () => {
    expect(formatMoney({ amount: 4900, currency: 'EUR' })).toBe('€49.00')
    expect(formatMoney({ amount: 550, currency: 'GBP' })).toBe('£5.50')
  })

  it('treats JPY as zero-decimal', () => {
    expect(formatMoney({ amount: 4900, currency: 'JPY' })).toBe('¥4,900')
    expect(formatMoney({ amount: 500, currency: 'JPY' })).toBe('¥500')
  })

  it('groups thousands deterministically', () => {
    expect(formatMoney({ amount: 123456789, currency: 'USD' })).toBe('$1,234,567.89')
    expect(formatMoney({ amount: 100000, currency: 'USD' })).toBe('$1,000.00')
  })

  it('falls back to an explicit code prefix for other currencies', () => {
    expect(formatMoney({ amount: 4900, currency: 'CAD' })).toBe('CAD 49.00')
    expect(formatMoney({ amount: 123456, currency: 'SEK' })).toBe('SEK 1,234.56')
  })

  it('handles three-decimal currencies', () => {
    expect(formatMoney({ amount: 49123, currency: 'KWD' })).toBe('KWD 49.123')
  })

  it('formats negative amounts with a leading sign', () => {
    expect(formatMoney({ amount: -4900, currency: 'USD' })).toBe('-$49.00')
    expect(formatMoney({ amount: -4900, currency: 'CAD' })).toBe('-CAD 49.00')
  })

  it('fails closed on non-integer amounts rather than rounding a price', () => {
    expect(() => formatMoney({ amount: 49.5, currency: 'USD' })).toThrow(TypeError)
    expect(() => formatMoney({ amount: Number.NaN, currency: 'USD' })).toThrow(TypeError)
  })

  it('is deterministic', () => {
    expect(formatMoney({ amount: 8900, currency: 'USD' })).toBe(
      formatMoney({ amount: 8900, currency: 'USD' }),
    )
  })
})

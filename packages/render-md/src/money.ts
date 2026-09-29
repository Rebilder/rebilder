import type { Money } from './types'

/**
 * ISO 4217 currencies with no minor unit — `Money.amount` is already whole
 * currency units for these (e.g. JPY 4900 = ¥4,900).
 */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
])

/** ISO 4217 currencies with three-digit minor units. */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'])

/**
 * Unambiguous symbol prefixes. Deliberately conservative: currencies whose
 * common symbol is shared across currencies (e.g. "$" for CAD/AUD) fall back
 * to the explicit "CODE 49.00" form instead of guessing.
 */
const SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
}

function minorUnitDigits(code: string): number {
  if (ZERO_DECIMAL.has(code)) return 0
  if (THREE_DECIMAL.has(code)) return 3
  return 2
}

function splitAmount(m: Money): { sign: string; major: string; frac: string } {
  if (!Number.isInteger(m.amount)) {
    // Fail closed: silently rounding would alter a price (source validation).
    throw new TypeError(
      `Money.amount must be an integer number of minor units, got: ${String(m.amount)}`,
    )
  }
  const digits = minorUnitDigits(m.currency.toUpperCase())
  const sign = m.amount < 0 ? '-' : ''
  const abs = Math.abs(m.amount)
  const factor = 10 ** digits
  const major = Math.floor(abs / factor).toString()
  const frac = digits === 0 ? '' : `.${(abs % factor).toString().padStart(digits, '0')}`
  return { sign, major, frac }
}

/**
 * Decimal string for machine consumption (JSON-LD `price`): "89.00", "4900"
 * (zero-decimal), "49.123" (three-decimal). No grouping, no symbol.
 */
export function toDecimalString(m: Money): string {
  const { sign, major, frac } = splitAmount(m)
  return `${sign}${major}${frac}`
}

/**
 * Human-readable, deterministic money formatting: "$49.00", "€49.00",
 * "¥4,900", "-£5.50". Unknown/ambiguous currencies render as "CAD 49.00".
 * Pure function — no Intl, no locale, same input → same output everywhere.
 */
export function formatMoney(m: Money): string {
  const { sign, major, frac } = splitAmount(m)
  const code = m.currency.toUpperCase()
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const symbol = SYMBOLS[code]
  return symbol !== undefined
    ? `${sign}${symbol}${grouped}${frac}`
    : `${sign}${code} ${grouped}${frac}`
}

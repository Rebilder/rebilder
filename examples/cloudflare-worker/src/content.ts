/**
 * THIS IS THE FILE YOU EDIT.
 *
 * Everything else in this template is wiring you can deploy unchanged. This
 * file is your site's facts, and it is the only place substantive values come
 * from — prices, hours, eligibility, availability. Nothing downstream invents
 * one: `@rebilder/render-md` is a pure transformation of what is written here
 * into markdown an agent can read.
 *
 * The example content below describes a fictional business, so that
 * `wrangler dev` shows you a real markdown response the first time you run it.
 * Delete it and describe your own pages.
 *
 * WHY DECLARE FACTS RATHER THAN SCRAPE YOUR HTML. An agent that has to infer
 * your opening hours from a styled `<div>` gets them wrong some of the time,
 * and you never find out which time. A fact stated once, in a typed field, is
 * the same fact in every representation — which is also the rule the gateway
 * holds you to: markdown and HTML must never disagree about substance.
 */
import type { CollectionSource, DocumentSource } from '@rebilder/gateway'

/**
 * Your site's canonical origin. Used to build the absolute URLs in the
 * rendered output — agents cite URLs, and a relative one cites nothing.
 */
export const SITE_ORIGIN = 'https://example.com'

const at = (pathname: string): string => `${SITE_ORIGIN}${pathname}`

/**
 * MONEY IS IN MINOR UNITS. `{ amount: 180, currency: 'GBP' }` is £1.80, not
 * £180 — the same convention Stripe and every payments API uses, and the same
 * trap. This helper takes pounds so the numbers below read like prices, and it
 * is the only place the conversion happens.
 *
 * Currencies with no minor unit (JPY, KRW, ISK, …) take whole units directly:
 * use `{ amount: 4900, currency: 'JPY' }` for ¥4,900 and do not multiply.
 */
const pounds = (value: number) => ({ amount: Math.round(value * 100), currency: 'GBP' })

// ---------------------------------------------------------------------------
// Documents — one per page worth serving to an agent
// ---------------------------------------------------------------------------

/**
 * Keyed by pathname, so the lookup is a `Map.get` and nothing else. That
 * matters: this runs on the edge hot path, where the budget is p95 < 50ms of
 * compute and no network calls at all.
 */
export const DOCUMENTS: ReadonlyMap<string, DocumentSource> = new Map([
  [
    '/services/bike-fitting',
    {
      url: at('/services/bike-fitting'),
      title: 'Bike fitting',
      kind: 'service',
      summary:
        'A two-hour dynamic fit session on your own bike, including cleat alignment and a written position report.',
      facts: [
        { label: 'Price', value: { type: 'money', value: pounds(180) } },
        { label: 'Duration', value: { type: 'text', value: '2 hours' } },
        { label: 'Booking required', value: { type: 'boolean', value: true } },
        {
          label: 'Includes',
          value: {
            type: 'list',
            value: [
              'Pre-session mobility assessment',
              'Dynamic fit on your own bike',
              'Cleat alignment',
              'Written position report',
              'One free follow-up adjustment within 90 days',
            ],
          },
        },
      ],
      contact: {
        phone: '+44 20 7946 0000',
        email: 'workshop@example.com',
        address: ['14 Example Street', 'London', 'EC1A 1AA'],
      },
      actions: [{ label: 'Book a fitting', url: at('/book/bike-fitting'), kind: 'book' }],
      sections: [
        {
          body:
            'Fittings run Tuesday to Saturday. Bring the shoes and pedals you ride in — the ' +
            'session adjusts your position on the bike you actually own, not a jig.',
        },
      ],
    },
  ],
  [
    '/services/servicing',
    {
      url: at('/services/servicing'),
      title: 'Bike servicing',
      kind: 'service',
      summary: 'Three service tiers, all with a same-week turnaround.',
      facts: [
        { label: 'Essential service', value: { type: 'money', value: pounds(65) } },
        { label: 'Full service', value: { type: 'money', value: pounds(145) } },
        {
          label: 'Turnaround',
          value: { type: 'text', value: 'Same week, usually 2 to 3 days' },
        },
        { label: 'Collection available', value: { type: 'boolean', value: true } },
      ],
      contact: { phone: '+44 20 7946 0000', email: 'workshop@example.com' },
      actions: [{ label: 'Book a service', url: at('/book/servicing'), kind: 'book' }],
    },
  ],
  [
    '/visit',
    {
      url: at('/visit'),
      title: 'Visit the workshop',
      kind: 'location',
      facts: [
        {
          label: 'Opening hours',
          value: {
            type: 'hours',
            value: {
              // A weekday absent from `weekly` renders as "Not stated", which is
              // a different fact from "Closed" — `intervals: []` says closed.
              weekly: [
                { day: 'monday', intervals: [] },
                { day: 'tuesday', intervals: [{ opens: '09:00', closes: '18:00' }] },
                { day: 'wednesday', intervals: [{ opens: '09:00', closes: '18:00' }] },
                { day: 'thursday', intervals: [{ opens: '09:00', closes: '20:00' }] },
                { day: 'friday', intervals: [{ opens: '09:00', closes: '18:00' }] },
                { day: 'saturday', intervals: [{ opens: '10:00', closes: '17:00' }] },
                { day: 'sunday', intervals: [] },
              ],
              timeZone: 'Europe/London',
            },
          },
        },
        { label: 'Step-free access', value: { type: 'boolean', value: true } },
        {
          label: 'Nearest station',
          value: { type: 'text', value: 'Farringdon, 6 minutes on foot' },
        },
      ],
      contact: {
        phone: '+44 20 7946 0000',
        address: ['14 Example Street', 'London', 'EC1A 1AA'],
      },
    },
  ],
])

// ---------------------------------------------------------------------------
// Collections — index pages that list documents
// ---------------------------------------------------------------------------

export const COLLECTIONS: ReadonlyMap<string, CollectionSource> = new Map([
  [
    '/services',
    {
      url: at('/services'),
      title: 'Services',
      items: [
        {
          url: at('/services/bike-fitting'),
          title: 'Bike fitting',
          summary: 'Two-hour dynamic fit on your own bike.',
          facts: [{ label: 'From', value: { type: 'money', value: pounds(180) } }],
        },
        {
          url: at('/services/servicing'),
          title: 'Bike servicing',
          summary: 'Essential, full, and overhaul tiers.',
          facts: [{ label: 'From', value: { type: 'money', value: pounds(65) } }],
        },
      ],
    },
  ],
])

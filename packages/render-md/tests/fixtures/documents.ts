/**
 * Fixtures for the universal document/collection renderers.
 *
 * Five verticals, chosen because each one stresses a different part of the
 * contract rather than because five is a nice number:
 *
 * - `dentistLocation` — hours (including a closed day, a split day, a missing
 *   day, and exceptions), contact, and actions. The canonical "no product API
 *   anywhere" merchant.
 * - `saasPlans` — a collection whose items carry facts, so it renders as a
 *   table: money with a period, a money range, booleans, numbers with units,
 *   and a fact that only some items have (a column the union must still fill).
 * - `lawPracticeArea` — a compact document that fits in a small budget, with
 *   prose sections and related links so truncation order is observable.
 * - `newsArticle` — `access: 'metered'`. Its `sections` must never appear.
 * - `governmentService` — the fact-heavy, list-heavy page the hard ceiling
 *   exists for, plus a deliberately hostile URL scheme and a `|` in a label.
 */

import type { CollectionSource, DocumentSource } from '../../src/index'

export const dentistLocation: DocumentSource = {
  url: 'https://riverside-dental.example.com/locations/eastside',
  title: 'Riverside Dental — Eastside',
  kind: 'location',
  summary: 'General and cosmetic dentistry, accepting new patients.',
  updated: '2026-07-14',
  facts: [
    { label: 'Accepting new patients', value: { type: 'boolean', value: true } },
    {
      label: 'Services',
      value: {
        type: 'list',
        value: ['Cleanings', 'Fillings', 'Crowns', 'Whitening', 'Emergency care'],
      },
    },
    {
      label: 'New patient exam',
      value: { type: 'money', value: { amount: 12500, currency: 'USD' } },
      note: 'Includes x-rays.',
    },
    { label: 'Parking spaces', value: { type: 'number', value: 24 } },
    {
      label: 'Office hours',
      value: {
        type: 'hours',
        value: {
          timeZone: 'America/Los_Angeles',
          // Tuesday is split, Sunday is explicitly closed, Saturday is absent
          // entirely — three different facts that must render three ways.
          weekly: [
            { day: 'monday', intervals: [{ opens: '08:00', closes: '17:00' }] },
            {
              day: 'tuesday',
              intervals: [
                { opens: '08:00', closes: '12:00' },
                { opens: '13:00', closes: '17:00' },
              ],
            },
            { day: 'wednesday', intervals: [{ opens: '08:00', closes: '17:00' }] },
            { day: 'thursday', intervals: [{ opens: '08:00', closes: '17:00' }] },
            { day: 'friday', intervals: [{ opens: '08:00', closes: '14:00' }] },
            { day: 'sunday', intervals: [] },
          ],
          exceptions: [
            { date: '2026-11-26', closed: true, note: 'Thanksgiving' },
            { date: '2026-12-24', intervals: [{ opens: '08:00', closes: '12:00' }] },
          ],
          note: 'Emergency line answered outside office hours.',
        },
      },
    },
  ],
  contact: {
    phone: '+1 555 0100',
    email: 'eastside@riverside-dental.example.com',
    url: 'https://riverside-dental.example.com/contact',
    address: ['1200 Eastside Ave', 'Suite 210', 'Portland, OR 97214'],
  },
  actions: [
    {
      label: 'Book an appointment',
      url: 'https://riverside-dental.example.com/book',
      kind: 'book',
      note: 'Online booking, no account required.',
    },
    { label: 'Call the office', url: 'tel:+15550100', kind: 'contact' },
  ],
  sections: [
    {
      heading: 'Insurance',
      body: 'We are in-network with Delta Dental and Cigna.\n\nOut-of-network claims are filed on your behalf.',
    },
  ],
  related: [
    {
      title: 'Westside location',
      url: 'https://riverside-dental.example.com/locations/westside',
    },
  ],
}

export const saasPlans: CollectionSource = {
  url: 'https://ledgerly.example.com/pricing',
  title: 'Plans',
  items: [
    {
      url: 'https://ledgerly.example.com/pricing/free',
      title: 'Free',
      summary: 'For solo bookkeeping.',
      facts: [
        {
          label: 'Price',
          value: { type: 'money', value: { amount: 0, currency: 'USD' }, period: 'month' },
        },
        { label: 'Seats', value: { type: 'number', value: 1 } },
        { label: 'SSO', value: { type: 'boolean', value: false } },
      ],
    },
    {
      url: 'https://ledgerly.example.com/pricing/team',
      title: 'Team',
      facts: [
        {
          label: 'Price',
          value: {
            type: 'money',
            value: { amount: 2900, currency: 'USD' },
            period: 'month',
            per: 'per seat',
          },
        },
        { label: 'Seats', value: { type: 'number', value: 25 } },
        { label: 'SSO', value: { type: 'boolean', value: true } },
        // Only this item has a support fact: the column union must include it
        // and the other rows must render an empty cell, not a shifted row.
        { label: 'Support', value: { type: 'text', value: 'Email, 1 business day' } },
      ],
    },
    {
      url: 'https://ledgerly.example.com/pricing/enterprise',
      title: 'Enterprise',
      facts: [
        {
          label: 'Price',
          value: {
            type: 'money',
            value: { amount: 90000, currency: 'USD' },
            maxValue: { amount: 250000, currency: 'USD' },
            period: 'year',
          },
        },
        { label: 'SSO', value: { type: 'boolean', value: true } },
        { label: 'Support', value: { type: 'text', value: 'Named contact' } },
      ],
    },
  ],
}

/** No item carries facts → link-list mode. */
export const guideIndex: CollectionSource = {
  url: 'https://ledgerly.example.com/guides',
  items: [
    {
      url: 'https://ledgerly.example.com/guides/vat',
      title: 'Filing VAT',
      summary: 'What to file and when.',
    },
    { url: 'https://ledgerly.example.com/guides/payroll', title: 'Running payroll' },
  ],
}

export const lawPracticeArea: DocumentSource = {
  url: 'https://harbor-law.example.com/practice/employment',
  title: 'Employment law',
  kind: 'service',
  facts: [
    { label: 'Free consultation', value: { type: 'boolean', value: true } },
    {
      label: 'Consultation fee',
      value: { type: 'money', value: { amount: 0, currency: 'USD' } },
    },
  ],
  sections: [
    {
      heading: 'What we handle',
      body: 'Wrongful termination, wage and hour disputes, and severance review.',
    },
    {
      heading: 'How matters start',
      body: 'An intake call, then a written engagement letter before any work begins.',
    },
  ],
  related: [
    { title: 'Our attorneys', url: 'https://harbor-law.example.com/attorneys' },
    { title: 'Fees', url: 'https://harbor-law.example.com/fees' },
  ],
}

export const newsArticle: DocumentSource = {
  url: 'https://dispatch.example.com/2026/07/port-expansion',
  title: 'Port expansion clears final review',
  kind: 'article',
  summary: 'The council approved the third berth after a two-year review.',
  updated: '2026-07-30T09:15:00Z',
  access: 'metered',
  facts: [
    { label: 'Byline', value: { type: 'text', value: 'A. Okonkwo' } },
    { label: 'Published', value: { type: 'date', value: '2026-07-29' } },
    { label: 'Reading time', value: { type: 'number', value: 6, unit: 'minutes' } },
  ],
  sections: [
    {
      heading: 'The vote',
      body: 'PAYWALLED BODY — if this string ever appears in rendered output, the access gate has failed.',
    },
    { body: 'PAYWALLED LEDE — same.' },
  ],
  related: [{ title: 'Council coverage', url: 'https://dispatch.example.com/tag/council' }],
}

export const governmentService: DocumentSource = {
  url: 'https://city.example.gov/services/residential-parking-permit',
  title: 'Residential parking permit',
  kind: 'service',
  summary: 'Annual permit for on-street parking in a designated zone.',
  updated: '2026-06-01',
  facts: [
    {
      label: 'Annual fee',
      value: { type: 'money', value: { amount: 4500, currency: 'USD' }, period: 'year' },
    },
    { label: 'Permits per household', value: { type: 'number', value: 2 } },
    { label: 'Processing time', value: { type: 'number', value: 10, unit: 'business days' } },
    { label: 'Renewable online', value: { type: 'boolean', value: true } },
    {
      // A pipe in a label: it must be escaped wherever the label reaches a
      // table header, and left alone in a fact line.
      label: 'Zones A|B',
      value: { type: 'text', value: 'Eligible' },
    },
    {
      label: 'Required documents',
      value: {
        type: 'list',
        value: [
          'Proof of residency dated within 60 days',
          'Vehicle registration listing the permit address',
          "Driver's licence",
          'Lease or deed',
        ],
      },
    },
    {
      label: 'Application form',
      value: {
        type: 'url',
        value: 'https://city.example.gov/forms/rpp-1',
        label: 'Form RPP-1 (PDF)',
      },
    },
    {
      // Dropped: not an allowlisted scheme.
      label: 'Legacy tool',
      value: { type: 'url', value: 'javascript:alert(1)', label: 'Open the legacy tool' },
    },
    {
      // Dropped: `updated` at the top level wins.
      label: 'Updated',
      value: { type: 'date', value: '1999-01-01' },
    },
  ],
  actions: [
    { label: 'Apply online', url: 'https://city.example.gov/apply/rpp', kind: 'apply' },
    // Dropped: not an allowlisted scheme.
    { label: 'Open the desktop app', url: 'app://city/rpp', kind: 'other' },
  ],
  contact: {
    phone: '311',
    address: ['City Hall', '1 Civic Plaza'],
  },
  sections: [
    {
      heading: 'Eligibility',
      body: 'You must be a resident of the zone and the vehicle must be registered to the permit address.',
    },
    {
      heading: 'Appeals',
      body: 'A denied application may be appealed within 30 days in writing.',
    },
  ],
  related: [
    { title: 'Parking zones map', url: 'https://city.example.gov/parking/zones' },
    // Dropped: not an allowlisted scheme.
    { title: 'Internal notes', url: 'file:///var/notes.txt' },
  ],
}

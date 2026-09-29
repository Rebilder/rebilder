// gateway-config.ts
import type { DocumentSource, GatewayConfig } from '@rebilder/gateway'

// Your source of truth. Here it is a Map; in your app it is your CMS, database or catalog.
const pages = new Map<string, DocumentSource>([
  [
    '/services/bike-fitting',
    {
      url: 'https://example.com/services/bike-fitting',
      title: 'Bike fitting',
      summary: 'A 90-minute fit on your own bike, with a written report.',
      facts: [
        { label: 'Price', value: { type: 'money', value: { amount: 18000, currency: 'GBP' } } },
        { label: 'Booking required', value: { type: 'boolean', value: true } },
      ],
    },
  ],
])

export const gatewayConfig: GatewayConfig = {
  storeId: 'my-site',
  sources: {
    // Return the page's facts, or null to serve your normal HTML.
    document: (url) => pages.get(url.pathname) ?? null,
  },
}

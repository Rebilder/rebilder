import type { CatalogItemSource, PolicySource, ProductSource } from '../../src/index'

/**
 * Realistic PDP fixture. Note the shipping summary intentionally contains
 * merchant-authored price tokens ("$50", "$5.95") so the injected-field
 * integrity test exercises verbatim source text, not just structured fields.
 */
export const pdp: ProductSource = {
  url: 'https://store.example.com/products/trail-runner-2',
  title: 'Trail Runner 2',
  brand: 'Acme Outdoors',
  description: [
    'The Trail Runner 2 is built for long days on technical terrain.',
    '',
    'A recycled mesh upper keeps weight down while the 6 mm drop keeps your',
    'stride natural. Lugs are re-profiled from the original Trail Runner for',
    'better grip in mud without collecting debris on hardpack.',
  ].join('\n'),
  price: { amount: 8900, currency: 'USD' },
  compareAtPrice: { amount: 12000, currency: 'USD' },
  availability: 'in_stock',
  variants: [
    {
      id: 'v-8',
      title: 'Size 8',
      price: { amount: 8900, currency: 'USD' },
      availability: 'in_stock',
      sku: 'TR2-8',
      options: { size: '8' },
    },
    {
      id: 'v-9',
      title: 'Size 9',
      price: { amount: 8900, currency: 'USD' },
      availability: 'in_stock',
      sku: 'TR2-9',
      options: { size: '9' },
    },
    {
      id: 'v-10',
      title: 'Size 10',
      price: { amount: 9400, currency: 'USD' },
      availability: 'out_of_stock',
      sku: 'TR2-10',
      options: { size: '10' },
    },
  ],
  shipping: {
    summary: 'Free standard shipping on orders over $50. Standard shipping is $5.95.',
    freeThreshold: { amount: 5000, currency: 'USD' },
    regions: ['US', 'CA'],
    etaDays: [3, 5],
  },
  returns: {
    summary: '30-day returns on unworn shoes in original packaging.',
    windowDays: 30,
    url: 'https://store.example.com/policies/returns',
  },
  images: [
    { url: 'https://cdn.example.com/tr2-hero.jpg', alt: 'Trail Runner 2, side view' },
    { url: 'https://cdn.example.com/tr2-sole.jpg' },
  ],
  attributes: {
    Material: 'Recycled mesh upper',
    Drop: '6 mm',
    Weight: '280 g (size 9)',
  },
}

/** Minimal product: only required fields, all optionals absent. */
export const minimalProduct: ProductSource = {
  url: 'https://store.example.com/products/basic',
  title: 'Basic Tee',
  price: { amount: 1900, currency: 'USD' },
  availability: 'preorder',
}

export const policies: PolicySource[] = [
  {
    title: 'Shipping Policy',
    url: 'https://store.example.com/policies/shipping',
    body: 'Orders placed before 2pm ET ship the same business day. Free standard shipping on orders over $50; otherwise standard shipping is $5.95 flat.',
  },
  {
    title: 'Returns Policy',
    url: 'https://store.example.com/policies/returns',
    body: 'Returns are accepted within 30 days of delivery for unworn items in original packaging. Refunds are issued to the original payment method within 5 business days of receipt.',
  },
  {
    title: 'Privacy Policy',
    url: 'https://store.example.com/policies/privacy',
    body: 'We collect only the information required to fulfil your order. We never sell customer data.',
  },
]

export const catalog: CatalogItemSource[] = [
  {
    url: 'https://store.example.com/products/trail-runner-2',
    title: 'Trail Runner 2',
    price: { amount: 8900, currency: 'USD' },
    availability: 'in_stock',
  },
  {
    url: 'https://store.example.com/products/basic',
    title: 'Basic Tee',
    price: { amount: 1900, currency: 'USD' },
    availability: 'preorder',
  },
  {
    url: 'https://store.example.com/products/wool-socks',
    title: 'Wool Socks (3-pack)',
    price: { amount: 2400, currency: 'USD' },
    availability: 'backorder',
  },
]

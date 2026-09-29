import {
  renderDocumentMarkdown,
  renderPolicyMarkdown,
  renderProductMarkdown,
} from '@rebilder/render-md'
import type { CompatibilityEvaluationCase } from '../src/core/compatibility-evaluation'

/** Synthetic businesses only. Holdout categories are not used in development. */
export const DATASET_VERSION = 'synthetic-commercial-pages-2026-09-13-v1'
const products = [
  ['Induction skillet', 'Induction compatible', 'Hand wash only'],
  ['Trail jacket', 'Water resistant', 'Not waterproof'],
  ['Desk lamp', 'USB powered', 'Power adapter sold separately'],
  ['Travel bottle', 'Dishwasher safe', 'Top rack only'],
  ['Office chair', 'Height adjustable', 'Indoor use only'],
  ['Bike light', 'Rechargeable battery', 'Charging cable included'],
  ['Garden planter', 'Frost resistant', 'Drain before freezing'],
  ['Standing desk', 'Motorized height adjustment', 'Assembly required'],
  ['Air purifier', 'Replaceable filter', 'Replacement filters sold separately'],
  ['Floor mat', 'Machine washable', 'Cold wash only'],
]
const services = [
  ['Bike fitting', '60 minute appointment', 'Appointment required'],
  ['Home cleaning', 'Kitchen and bathroom cleaning', 'Supplies provided by customer'],
  ['Piano tuning', 'Acoustic piano tuning', 'Digital pianos excluded'],
  ['Garden consultation', 'Written planting plan', 'Plants sold separately'],
  ['Language lesson', 'Individual tuition', 'Adults only'],
  ['Portrait session', 'Ten edited photographs', 'Prints sold separately'],
  ['Roof inspection', 'Visual exterior inspection', 'Structural engineering excluded'],
  ['EV installation', 'Site survey included', 'Electrical upgrades quoted separately'],
  ['Pet grooming', 'Bath and nail trimming', 'Vaccination record required'],
  ['Remote accounting', 'Monthly bookkeeping', 'Tax filing excluded'],
]
const policies = [
  ['Returns', '30 days', 'Unused items only'],
  ['Warranty', 'Two years', 'Manufacturing defects only'],
  ['Delivery', 'Three business days', 'Mainland addresses only'],
  ['Cancellation', '24 hours notice', 'Late cancellations are charged'],
  ['Collection', 'Seven days', 'Photo identification required'],
  ['Repairs', 'Inspection included', 'Parts charged separately'],
  ['Subscriptions', 'Cancel any month', 'Current period is not refunded'],
  ['Custom orders', 'Six weeks', 'Custom orders cannot be returned'],
  ['International delivery', 'Ten business days', 'Import duties paid by recipient'],
  ['Installation warranty', 'One year', 'Third party alterations excluded'],
]
function common(kind: string, index: number, title: string) {
  return {
    id: `${kind}-${index + 1}`,
    split: (index >= 6 ? 'holdout' : 'development') as 'holdout' | 'development',
    canonicalUrl: `https://synthetic-${kind}-${index + 1}.example/page`,
    title,
  }
}
export const compatibilityCases: CompatibilityEvaluationCase[] = [
  ...products.map(([title = '', feature = '', qualification = ''], index) => {
    const c = common('product', index, title)
    return {
      ...c,
      markdown: renderProductMarkdown(
        {
          title,
          url: c.canonicalUrl,
          price: { amount: 9900 + index * 100, currency: 'USD' },
          availability: index === 8 ? 'preorder' : 'in_stock',
          description: `${feature}. ${qualification}.`,
          attributes: { Feature: feature, Conditions: qualification },
          shipping: { summary: 'Delivery to mainland addresses only' },
          returns: { summary: 'Unused items may be returned within 30 days' },
        },
        { maxBytes: 12000 },
      ),
      questions: [
        {
          id: 'feature',
          question: `What should a customer know about ${title}, including restrictions or requirements? Quote the relevant facts and conditions.`,
          facts: [feature],
          qualifications: [qualification],
        },
        {
          id: 'delivery',
          question: 'Where can this product be delivered? Include every geographic qualification.',
          facts: ['mainland addresses'],
          qualifications: ['only'],
        },
      ],
    }
  }),
  ...services.map(([title = '', feature = '', qualification = ''], index) => {
    const c = common('service', index, title)
    return {
      ...c,
      markdown: renderDocumentMarkdown(
        {
          kind: 'service',
          title,
          url: c.canonicalUrl,
          summary: `${feature}. ${qualification}.`,
          facts: [
            { label: 'Includes', value: { type: 'text', value: feature } },
            { label: 'Conditions', value: { type: 'text', value: qualification } },
          ],
          sections: [
            {
              heading: 'Booking',
              body: 'Bookings are confirmed by email. Service is available on weekdays only.',
            },
          ],
        },
        { maxBytes: 12000 },
      ),
      questions: [
        {
          id: 'scope',
          question: `What does ${title} include, and what conditions or exclusions apply? Quote the relevant information.`,
          facts: [feature],
          qualifications: [qualification],
        },
        {
          id: 'schedule',
          question: 'When is this service available? Include restrictions.',
          facts: ['weekdays'],
          qualifications: ['only'],
        },
      ],
    }
  }),
  ...policies.map(([title = '', feature = '', qualification = ''], index) => {
    const c = common('policy', index, title)
    return {
      ...c,
      markdown: renderPolicyMarkdown(
        [
          {
            title,
            url: c.canonicalUrl,
            body: `${title}: ${feature}. ${qualification}.\n\n## Contact\nContact the business for a written confirmation before making special arrangements.`,
          },
        ],
        { maxBytes: 12000 },
      ),
      questions: [
        {
          id: 'terms',
          question: `What are the ${title.toLowerCase()} terms? Quote the timeframe and every condition or exclusion.`,
          facts: [feature],
          qualifications: [qualification],
        },
      ],
    }
  }),
]

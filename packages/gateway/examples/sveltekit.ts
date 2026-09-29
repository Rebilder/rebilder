// src/hooks.server.ts in SvelteKit. Astro, React Router, Hono and Netlify mount it the same way.
import type { Handle } from '@sveltejs/kit'
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config'

const gateway = createFetchMiddleware(gatewayConfig)

export const handle: Handle = ({ event, resolve }) => gateway(event.request, () => resolve(event))

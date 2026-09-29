// worker.ts: deploy on a route in front of your site, e.g. example.com/*
import { createGatewayFetchHandler } from '@rebilder/gateway/edge'
import { gatewayConfig } from './gateway-config'

export default { fetch: createGatewayFetchHandler(gatewayConfig) }

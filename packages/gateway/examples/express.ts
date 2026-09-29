import express from 'express'
import { createGatewayMiddleware } from '@rebilder/gateway/node'
import { gatewayConfig } from './gateway-config'   // same GatewayConfig as every adapter

const app = express()
app.use(createGatewayMiddleware(gatewayConfig))    // before your routes
// ... your existing routes serve HTML exactly as before

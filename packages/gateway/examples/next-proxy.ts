// proxy.ts on Next 16, middleware.ts on Next 15 and earlier
import { NextResponse } from 'next/server'
import { createGatewayProxy } from '@rebilder/gateway/next'
import { gatewayConfig } from './gateway-config'

export default createGatewayProxy(gatewayConfig, () => NextResponse.next())

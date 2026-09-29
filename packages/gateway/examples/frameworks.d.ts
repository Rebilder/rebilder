/**
 * Minimal stand-ins for the framework modules the README examples import, so
 * `tsc` checks how every example calls the gateway without installing Next.js,
 * Express or SvelteKit into this package. Each declares only what the examples
 * touch, shaped after the framework's documented signature. What this proves
 * is our half of each example: the imports exist, the arguments type-check,
 * and the return value fits where the framework expects a handler.
 */

declare module 'next/server' {
  export const NextResponse: { next(): Response }
}

declare module 'express' {
  interface Application {
    use(handler: (req: never, res: never, next: never) => unknown): Application
  }
  export default function express(): Application
}

declare module '@sveltejs/kit' {
  export interface RequestEvent {
    request: Request
  }
  export type Handle = (input: {
    event: RequestEvent
    resolve: (event: RequestEvent) => Response | Promise<Response>
  }) => Response | Promise<Response>
}

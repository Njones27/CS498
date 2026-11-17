/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The web app always calls `<base>api/...`. In dev, Vite forwards that to the API service
// (HDD §7.1) and strips the prefix, so the API serves the HDD §6.1 paths at its root.
// On AWS (Phase 2) CloudFront serves the app and forwards /api to the API on the same origin, so nothing
// is set there either. VITE_API_BASE is only for pointing a build at an API on another origin.
//
// Behind code-server's port proxy, run with VITE_BASE=/proxy/5173/: the app is then served
// under that prefix and HMR connects back through the proxy on 443 (`npm run dev:proxy`).
// Without it, base is '/'.
const rawBase = process.env.VITE_BASE || '/'
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`
const behindProxy = base !== '/'
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8000'

// code-server strips its /proxy/5173 prefix before forwarding; put it back so Vite's base matches.
const codeServerProxyPlugin = () => ({
  name: 'code-server-proxy-rewrite',
  configureServer(server: any) {
    if (server.httpServer) {
      server.httpServer.prependListener('upgrade', (req: any) => {
        if (req.url && !req.url.startsWith(base)) {
          req.url = base + req.url.replace(/^\//, '')
        }
      })
    }
    server.middlewares.use((req: any, _res: any, next: any) => {
      if (req.url && !req.url.startsWith(base)) {
        req.url = base + req.url.replace(/^\//, '')
      }
      next()
    })
  },
})

export default defineConfig({
  base,
  plugins: [react(), ...(behindProxy ? [codeServerProxyPlugin()] : [])],
  server: {
    host: true,
    port: 5173,
    ...(behindProxy && { allowedHosts: true, hmr: { clientPort: 443 } }),
    proxy: {
      [`^(${base})?api`]: {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(new RegExp(`^(${base})?api`), ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})

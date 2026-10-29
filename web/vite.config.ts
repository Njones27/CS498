/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const base = process.env.VITE_BASE ?? '/proxy/5173/'
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8000'

const codeServerProxyPlugin = () => ({
  name: 'code-server-proxy-rewrite',
  configureServer(server: any) {
    if (server.httpServer) {
      server.httpServer.prependListener('upgrade', (req: any) => {
        if (base !== '/' && req.url && !req.url.startsWith(base)) {
          req.url = base + req.url.replace(/^\//, '')
        }
      })
    }
    server.middlewares.use((req: any, _res: any, next: any) => {
      if (base !== '/' && req.url && !req.url.startsWith(base)) {
        req.url = base + req.url.replace(/^\//, '')
      }
      next()
    })
  },
})

export default defineConfig({
  base,
  plugins: [react(), codeServerProxyPlugin()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    hmr: {
      clientPort: 443,
    },
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

// Bump CACHE_VERSION on new releases to invalidate stale static assets and precached files.
const CACHE_VERSION = 'v1'
const CACHE_NAME = `parking-app-${CACHE_VERSION}`
const API_CACHE_NAME = `parking-api-${CACHE_VERSION}`

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons.svg',
  './apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  const validCaches = new Set([CACHE_NAME, API_CACHE_NAME])
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !validCaches.has(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle GET requests and same-origin / font requests
  if (request.method !== 'GET') return

  // Navigation requests: Network-first, fallback to cached index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
        .catch(async () => {
          const cached = await caches.match(request)
          if (cached) return cached
          return caches.match('./index.html')
        }),
    )
    return
  }

  // Public driver API calls (/api/lots, /api/lots/:lotId, and /api/lots/:lotId/status):
  // Network-first with cache fallback for offline viewing.
  // Explicitly excludes admin endpoints, auth endpoints, or photo/upload assets.
  const isPublicDriverApi =
    /\/api\/lots(?:\/[^/]+(?:\/status)?)?$/.test(url.pathname) &&
    !url.pathname.includes('/admin/')

  if (isPublicDriverApi) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(API_CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
        .catch(async () => {
          const cached = await caches.match(request)
          if (cached) return cached
          return new Response(
            JSON.stringify({ error: 'offline', message: 'You are currently offline' }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }),
    )
    return
  }

  // For any other /api/ requests (admin, auth, snapshots), do not cache or intercept.
  if (url.pathname.includes('/api/')) {
    return
  }

  // Static assets (CSS, JS, Fonts, Images): Cache-first with network fallback
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok && (url.origin === location.origin || url.hostname.includes('fonts.'))) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        }
        return response
      })
    }),
  )
})

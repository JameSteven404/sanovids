import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// `start.bat` (vite preview) and `npm run dev` share http://localhost:5180 on purpose (same origin = same
// IndexedDB projects). The preview registers the production service worker, which would keep serving the old
// build on the dev server. In dev, /sw.js is therefore a "kill switch" that clears its caches, unregisters
// itself and reloads the open tabs (the browser fetches /sw.js for its update check on every navigation).
const KILL_SWITCH_SW = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key)
    await self.registration.unregister()
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url)
  })())
})
`

function devServiceWorkerKillSwitch(): Plugin {
  return {
    name: 'bdp:dev-sw-kill-switch',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/sw.js') return next()
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(KILL_SWITCH_SW)
      })
    },
  }
}

// Relative base: the same dist/ works on any static host (sub-folder included), from `vite preview`
// and inside the Electron desktop build (served through the app:// protocol, see electron/main.cjs).
export default defineConfig({
  base: './',
  plugins: [
    devServiceWorkerKillSwitch(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registered from src/lib/pwa.ts so it can be skipped inside Electron and on file:.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
      manifest: {
        id: './',
        name: 'SanoVids',
        short_name: 'SanoVids',
        description: 'Dựng phim AI theo từng cảnh trên canvas: kịch bản, ảnh tham chiếu, video và take.',
        lang: 'vi',
        dir: 'ltr',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        theme_color: '#0f1012',
        background_color: '#0f1012',
        categories: ['productivity', 'photo', 'entertainment'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell + every lazy chunk + fonts (woff2 only; the .woff fallbacks are never used by modern engines).
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Long-lived vendor chunks (cached across app updates). Lazy views/dialogs get their own chunks
        // automatically from the React.lazy() imports in App.tsx.
        codeSplitting: {
          groups: [
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 3 },
            {
              name: 'xyflow',
              test: /[\\/]node_modules[\\/](@xyflow|classcat|d3-[a-z-]+|use-sync-external-store)[\\/]/,
              priority: 2,
            },
            {
              name: 'jszip',
              test: /[\\/]node_modules[\\/](jszip|pako|lie|immediate|setimmediate|readable-stream|safe-buffer|string_decoder|process-nextick-args|core-util-is|inherits|isarray|util-deprecate)[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    // electron-builder output (hundreds of MB) — watching it slows the dev server and makes packaging fail with
    // EPERM on Windows while `npm run dev` is running.
    watch: { ignored: ['**/release/**'] },
  },
  preview: { port: 5180, strictPort: true },
})

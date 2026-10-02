// Runs in the sandboxed renderer before the page. Exposes a tiny bridge: window.bdpDesktop.
// The web app uses it to know it runs as the desktop build (no service worker, "installed" state), and — only when
// the user enables it in Settings — to reach the experimental canvasapp.io.vn gateway (see docs/GATEWAY-CANVASAPP.md).
// The gateway functions only forward to allowlisted handlers in main.cjs; no cookies or credentials cross this bridge.
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const arg = process.argv.find((a) => a.startsWith('--bdp-version='))

contextBridge.exposeInMainWorld('bdpDesktop', {
  version: arg ? arg.slice('--bdp-version='.length) : '',
  electron: process.versions.electron,
  platform: process.platform,
  canvasapp: {
    /** → { ok: true, authenticated } | { ok: false, code, message } */
    status: () => ipcRenderer.invoke('canvasapp:status'),
    /** Opens canvasapp.io.vn in its own window; resolves when logged in or when the window is closed. */
    login: () => ipcRenderer.invoke('canvasapp:login'),
    /** Clears the canvasapp session (cookies, storage, cache) of the gateway partition. */
    logout: () => ipcRenderer.invoke('canvasapp:logout'),
    /** { method, path, json?, form?, binary? } → { ok: true, status, contentType, json?, text?, bytes? } | { ok: false, code, message } */
    request: (req) => ipcRenderer.invoke('canvasapp:request', req),
    /**
     * Top-up: { checkoutUrl, fields } (from POST /api/payments/topups) → opens the REAL checkout page (SePay) in a
     * modal window; main re-validates the URL. → { ok: true, result: 'success'|'cancel'|'error'|'closed'|'timeout',
     * orderId, blockedHost } | { ok: false, code, message }. Only plain data crosses: no payment data, no cookies.
     */
    checkout: (args) =>
      ipcRenderer.invoke('canvasapp:checkout', {
        checkoutUrl: args && typeof args.checkoutUrl === 'string' ? args.checkoutUrl : '',
        fields: args && args.fields && typeof args.fields === 'object' ? { ...args.fields } : {},
      }),
  },
})

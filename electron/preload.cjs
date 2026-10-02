// Runs in the sandboxed renderer before the page. Exposes a tiny bridge: window.bdpDesktop.
// The web app uses it to know it runs as the desktop build (no service worker, "installed" state), and — only when
// the user enables it in Settings — to reach the experimental canvasapp.io.vn gateway (see docs/GATEWAY-CANVASAPP.md).
// The gateway functions only forward to allowlisted handlers in main.cjs; no cookies or credentials cross this bridge.
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const arg = process.argv.find((a) => a.startsWith('--bdp-version='))

/** Plain data only: a string (or '') — the main process validates everything again. */
const str = (v) => (typeof v === 'string' ? v : '')
/** [{ name, bytes | text }] for the files:* calls (at most 8; main allows fewer). */
const fileList = (files) =>
  Array.isArray(files)
    ? files.slice(0, 8).map((f) => ({
        name: str(f && f.name),
        bytes: f && ArrayBuffer.isView(f.bytes) ? new Uint8Array(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength) : undefined,
        text: f && typeof f.text === 'string' ? f.text : undefined,
      }))
    : []

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
  /**
   * Saving videos (src/lib/desktopFiles.ts). The page never names a path to write to: the save dialog or the folder
   * picker does, and main only writes into folders the user picked (its allowlist). Every call → { ok, … } | { ok: false, code, message }.
   */
  files: {
    /** Native folder picker → { ok: true, path, name } (the folder joins the allowlist). */
    pickFolder: () => ipcRenderer.invoke('files:pickFolder'),
    /** { folderPath } → { ok: true, allowed, exists } */
    folderStatus: (args) => ipcRenderer.invoke('files:folderStatus', { folderPath: str(args && args.folderPath) }),
    /** { folderPath, files: [{ name, bytes | text }] } → { ok: true, names } — never overwrites (" (2)"). */
    writeToFolder: (args) => ipcRenderer.invoke('files:writeToFolder', { folderPath: str(args && args.folderPath), files: fileList(args && args.files) }),
    /** { folderPath } → shows the (allowlisted) folder in Explorer / Finder. */
    openFolder: (args) => ipcRenderer.invoke('files:openFolder', { folderPath: str(args && args.folderPath) }),
    /** { suggestedName, title?, files } → native "Save as" for files[0], companions next to it → { ok: true, path, names } | { ok: false, canceled } */
    saveAs: (args) =>
      ipcRenderer.invoke('files:saveAs', { suggestedName: str(args && args.suggestedName), title: str(args && args.title), files: fileList(args && args.files) }),
  },
})

// Runs in the sandboxed renderer before the page. Exposes a tiny bridge: window.bdpDesktop.
// The web app uses it to know it runs as the desktop build (no service worker, "installed" state), and — only when
// the user enables it in Settings — to reach the experimental canvasapp.io.vn gateway (see docs/GATEWAY-CANVASAPP.md).
// The gateway functions only forward to allowlisted handlers in main.cjs; no cookies or credentials cross this bridge.
// files: the "Lưu video" dialog and the folder nodes (main writes only into folders the user picked).
// updates: the auto-updater (electron/updater.cjs) — check / download / install / open the fixed release page; the page
// never sends a URL, a path or a feed, and receives the state as plain data ('updates:state').
// app: read-only self-check of the app's own code signature (main checks the running .exe once; no argument crosses),
// and where the app runs from (installer / portable / temp-copy / dev — a kind, never a path).
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
/** Owner of a folder write { folderId, takeId, via } (strings; main checks them and records the group), or undefined. */
const saveOwner = (o) => (o && typeof o === 'object' ? { folderId: str(o.folderId), takeId: str(o.takeId), via: str(o.via) } : undefined)
/** [{ takeId, groupIds }] for files:trashSaved — capped above main's limits (200 / 20), so main refuses a bigger batch. */
const trashItems = (items) =>
  Array.isArray(items)
    ? items.slice(0, 256).map((i) => ({ takeId: str(i && i.takeId), groupIds: Array.isArray(i && i.groupIds) ? i.groupIds.slice(0, 32).map(str) : [] }))
    : []

contextBridge.exposeInMainWorld('bdpDesktop', {
  version: arg ? arg.slice('--bdp-version='.length) : '',
  electron: process.versions.electron,
  platform: process.platform,
  /** Self-check of the app's code signature (Cài đặt → Giới thiệu). */
  app: {
    /** → { status: 'signed'|'unsigned'|'other-signer'|'tampered'|'unknown', packaged, signer?, thumbprint? } */
    signature: () => ipcRenderer.invoke('app:signature'),
    /** → { kind: 'installer'|'portable'|'temp-copy'|'dev' } — where this SanoVids runs from (no path). */
    placement: () => ipcRenderer.invoke('app:placement'),
  },
  canvasapp: {
    /** → { ok: true, authenticated } | { ok: false, code, message } */
    status: () => ipcRenderer.invoke('canvasapp:status'),
    /** Opens canvasapp.io.vn in its own window; resolves when logged in or when the window is closed. */
    login: () => ipcRenderer.invoke('canvasapp:login'),
    /**
     * Đăng xuất: stops canvasapp requests in flight, deletes the kept (encrypted) login copy, asks canvasapp to end the
     * session and clears the gateway partition. → { ok: true } | { ok: false, code: 'keep-login-not-cleared', message }
     */
    logout: () => ipcRenderer.invoke('canvasapp:logout'),
    /** → { ok: true, keepLogin, available, chosen } — whether SanoVids keeps the canvasapp login across restarts (encrypted). */
    keepLogin: () => ipcRenderer.invoke('canvasapp:keepLogin'),
    /** (on) → same; off deletes the kept copy now (this run stays logged in). Only a boolean crosses. */
    setKeepLogin: (on) => ipcRenderer.invoke('canvasapp:setKeepLogin', on === true),
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
    /**
     * { folderPath, files: [{ name, bytes | text }], owner?: { folderId, takeId, via } } → { ok: true, names, recorded? }
     * — never overwrites (" (2)"); with an owner, main records the group (`recorded`: its id, or false).
     */
    writeToFolder: (args) =>
      ipcRenderer.invoke('files:writeToFolder', { folderPath: str(args && args.folderPath), files: fileList(args && args.files), owner: saveOwner(args && args.owner) }),
    /**
     * { folderPath, folderId, items: [{ takeId, groupIds }] } → { ok: true, results } — moves to the Recycle Bin only the
     * files main recorded for those groups and that are unchanged (never deletes; the page names no file).
     */
    trashSaved: (args) =>
      ipcRenderer.invoke('files:trashSaved', { folderPath: str(args && args.folderPath), folderId: str(args && args.folderId), items: trashItems(args && args.items) }),
    /** { folderPath } → shows the (allowlisted) folder in Explorer / Finder. */
    openFolder: (args) => ipcRenderer.invoke('files:openFolder', { folderPath: str(args && args.folderPath) }),
    /** { suggestedName, title?, files } → native "Save as" for files[0], companions next to it → { ok: true, path, names } | { ok: false, canceled } */
    saveAs: (args) =>
      ipcRenderer.invoke('files:saveAs', { suggestedName: str(args && args.suggestedName), title: str(args && args.title), files: fileList(args && args.files) }),
  },
  /**
   * Auto-update (electron/updater.cjs). The feed is fixed in the app (resources/app-update.yml): the page can only ask
   * main to check / download / install / open the fixed release page. Every call → UpdateResult, except getState.
   */
  updates: {
    /** → UpdateState */
    getState: () => ipcRenderer.invoke('updates:getState'),
    /** Check now; resolves when the check is over → { ok } | { ok: false, code, message } */
    check: () => ipcRenderer.invoke('updates:check'),
    /** Installer only, status 'available': start the download (progress comes through onState). */
    download: () => ipcRenderer.invoke('updates:download'),
    /** Installer only, status 'ready': quit, install silently, relaunch. Save the project BEFORE calling this. */
    install: () => ipcRenderer.invoke('updates:install'),
    /** { autoDownload: boolean } (anything else is refused by main). */
    setPrefs: (p) => ipcRenderer.invoke('updates:setPrefs', { autoDownload: p && typeof p.autoDownload === 'boolean' ? p.autoDownload : undefined }),
    /** Opens the public download page (a constant in main) in the default browser. */
    openReleasePage: () => ipcRenderer.invoke('updates:openReleasePage'),
    /** cb(state) on every change; returns an unsubscribe function. */
    onState: (cb) => {
      if (typeof cb !== 'function') return () => undefined
      const listener = (_event, state) => cb(state)
      ipcRenderer.on('updates:state', listener)
      return () => ipcRenderer.removeListener('updates:state', listener)
    },
  },
})

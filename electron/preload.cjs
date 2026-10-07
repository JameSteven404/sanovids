// Runs in the sandboxed renderer before the page. Exposes a tiny bridge: window.bdpDesktop.
// The web app uses it to know it runs as the desktop build (no service worker, "installed" state), and — only when
// the user enables it in Settings — to reach the experimental canvasapp.io.vn gateway (see docs/GATEWAY-CANVASAPP.md).
// The gateway functions only forward to allowlisted handlers in main.cjs; no cookies or credentials cross this bridge.
// files: the "Lưu video" dialog and the folder nodes (main writes only into folders the user picked).
// updates: the auto-updater (electron/updater.cjs) — check / download / install / open the fixed release page; the page
// never sends a URL, a path or a feed, and receives the state as plain data ('updates:state').
// app: read-only self-check of the app's own code signature (main checks the running .exe once; no argument crosses),
// and where the app runs from (installer / portable / temp-copy / dev — a kind, never a path); setBusy tells main whether
// takes are being made (macOS: a window hidden by its close button keeps working at full speed only then).
// devAccess: the development-mode lock (electron/devaccess.cjs). Main decides; the page only reads the state and asks
// to unlock (the typed code, ≤ 300 characters), lock, keep, link / unlink the authenticator.
// seedvis: the seedvis.com gateway (electron/seedvis.cjs). The page sends symbolic routes and plain data; main builds
// every URL, adds the API key (which never comes back), checks every field and pulls results by job id + index.
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const arg = process.argv.find((a) => a.startsWith('--bdp-version='))
const devAccessArg = process.argv.find((a) => a.startsWith('--bdp-dev-access='))

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

/** Bytes of a typed array as a Uint8Array view, else undefined. */
const bytesOf = (b) => (b && ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : undefined)
/**
 * A seedvis:request payload: plain data only — route, id, idempotencyKey, a shallow copy of body, images
 * [{ field, index, mime, bytes }] (capped at 11 so main refuses more than 10), mustFinishBy. Main checks it all again.
 */
const seedvisRequest = (r) => {
  const o = r && typeof r === 'object' ? r : {}
  const out = { route: str(o.route) }
  if (o.id !== undefined) out.id = str(o.id)
  if (o.idempotencyKey !== undefined) out.idempotencyKey = str(o.idempotencyKey)
  if (o.body && typeof o.body === 'object' && !Array.isArray(o.body)) out.body = { ...o.body }
  if (Array.isArray(o.images)) {
    out.images = o.images.slice(0, 11).map((i) => ({ field: str(i && i.field), index: i && Number.isSafeInteger(i.index) ? i.index : -1, mime: str(i && i.mime), bytes: bytesOf(i && i.bytes) }))
  }
  if (typeof o.mustFinishBy === 'number') out.mustFinishBy = o.mustFinishBy
  return out
}

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
    /** (busy) → whether main heard it. macOS: takes queued / being made keep a hidden window working (only a boolean). */
    setBusy: (busy) => ipcRenderer.invoke('app:busy', busy === true),
  },
  /** Development-mode lock: every call → DevAccessState or { ok, state } | { ok: false, error, … } (src/providers/devAccess.ts). */
  devAccess: {
    /** 'build' | 'unlocked' | 'locked' when this window was created ('' = unknown: the page treats it as locked). */
    initial: devAccessArg ? devAccessArg.slice('--bdp-dev-access='.length) : '',
    getState: () => ipcRenderer.invoke('devAccess:getState'),
    unlock: (code) => ipcRenderer.invoke('devAccess:unlock', { code: str(code).slice(0, 300) }),
    lock: () => ipcRenderer.invoke('devAccess:lock'),
    setKeep: (days) => ipcRenderer.invoke('devAccess:setKeep', { days: Number(days) }),
    totpBegin: () => ipcRenderer.invoke('devAccess:totpBegin'),
    totpConfirm: (code) => ipcRenderer.invoke('devAccess:totpConfirm', { code: str(code).slice(0, 300) }),
    linkCancel: () => ipcRenderer.invoke('devAccess:linkCancel'),
    totpRemove: () => ipcRenderer.invoke('devAccess:totpRemove'),
    /** cb(state) on every change main pushes; returns an unsubscribe function. */
    onState: (cb) => {
      if (typeof cb !== 'function') return () => undefined
      const listener = (_event, state) => cb(state)
      ipcRenderer.on('devAccess:state', listener)
      return () => ipcRenderer.removeListener('devAccess:state', listener)
    },
  },
  /**
   * seedvis.com (src/providers/seedvis/contract.ts SeedvisBridge). No call ever returns the API key. Every call →
   * its contract answer or { ok: false, code, message }.
   */
  seedvis: {
    /** → SeedvisKeyStatus { hasKey, hint, tag, savedAt, verifiedAt, storage, problem? } */
    keyStatus: () => ipcRenderer.invoke('seedvis:keyStatus'),
    /** "Dán key": main reads the clipboard itself, checks the key with seedvis, encrypts it, clears the clipboard. */
    pasteKey: (a) => ipcRenderer.invoke('seedvis:pasteKey', { unverified: !!(a && a.unverified === true) }),
    /** Fallback field: { key } crosses once (≤ 1000 characters). */
    setKey: (a) => ipcRenderer.invoke('seedvis:setKey', { key: str(a && a.key).slice(0, 1000), unverified: !!(a && a.unverified === true) }),
    clearKey: () => ipcRenderer.invoke('seedvis:clearKey'),
    /** { route, id?, idempotencyKey?, body?, images?, mustFinishBy? } → SeedvisResponse */
    request: (r) => ipcRenderer.invoke('seedvis:request', seedvisRequest(r)),
    /** { generationId, index } → { ok: true, id, total, mime } | failure — main fetches only URLs seedvis gave it. */
    downloadOpen: (a) =>
      ipcRenderer.invoke('seedvis:downloadOpen', { generationId: str(a && a.generationId), index: a && Number.isSafeInteger(a.index) ? a.index : -1 }),
    /** { id } → { ok: true, done: false, bytes } | { ok: true, done: true } | failure */
    downloadRead: (a) => ipcRenderer.invoke('seedvis:downloadRead', { id: str(a && a.id) }),
    /** { id } → { ok: true } */
    downloadClose: (a) => ipcRenderer.invoke('seedvis:downloadClose', { id: str(a && a.id) }),
    /** → boolean (main's net.isOnline()) */
    isOnline: () => ipcRenderer.invoke('seedvis:isOnline'),
    /** Opens the fixed seedvis.com billing page in the default browser. */
    openBilling: () => ipcRenderer.invoke('seedvis:openBilling'),
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
    /**
     * { method, path, json?, form? } → { ok: true, status, contentType, json?, text? } | { ok: false, code, message }
     * — never the video stream (main refuses it here: downloadOpen / downloadRead / downloadClose).
     */
    request: (req) => ipcRenderer.invoke('canvasapp:request', req),
    /**
     * Finished videos, pulled in pieces (main reads the HTTP body; nothing big crosses in one message).
     * { id (a UUID the page picks), path (allowlisted GET …/stream), from (continue at this byte; main decides whether
     * it can) } → { ok: true, id, status, contentType, from, total, resumable } | { ok: true, status, contentType,
     * json?, text? } (not 200 / 206) | { ok: false, code, message }
     */
    downloadOpen: (a) =>
      ipcRenderer.invoke('canvasapp:downloadOpen', {
        id: str(a && a.id),
        path: str(a && a.path),
        from: a && Number.isSafeInteger(a.from) && a.from > 0 ? a.from : 0,
      }),
    /** { id } → the next piece: { ok: true, done: false, bytes } | { ok: true, done: true } | { ok: false, code, message } */
    downloadRead: (a) => ipcRenderer.invoke('canvasapp:downloadRead', { id: str(a && a.id) }),
    /** { id } → stops that download (also while it waits for its turn) → { ok: true } */
    downloadClose: (a) => ipcRenderer.invoke('canvasapp:downloadClose', { id: str(a && a.id) }),
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

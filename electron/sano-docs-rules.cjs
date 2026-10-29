// Sano Agent "Tài liệu" (SANO TH-45, docs/SANO-DESKTOP.md §3b): SANO's page lists the user's Google Docs and Sheets,
// and "Mở" opens one in Sano Agent's own window, in Google's own editor, signed in with the user's Google account inside
// that window. Edits never go through an API: no write scope is asked for. The window has no preload, its own in-memory
// partition, and may only stay on Google's editor and sign-in pages; everything else opens in the default browser.
//
// No require (like the other *-rules.cjs): windows, the partition, the dialog, shell.openExternal and the clock are
// injected by main.cjs, fakes by src/lib/__tests__/sanoDocsRules.test.ts. Nothing here logs a document id or a path:
// hosts only.
'use strict'

/**
 * Contract with SANO's shared/assistant.ts (§7 of the step-4 spec; DRIVE_FILE_ID must stay identical):
 * @typedef {'docs' | 'sheets'} DriveFileKind
 * @typedef {{ id: string, name: string, kind: DriveFileKind, modifiedTime: string }} DriveFile
 * @typedef {{ files: DriveFile[], nextPageToken: string | null, incomplete: boolean }} DriveFileList
 * window.sanoDesktop.docs: open({ id, kind }) → Promise<void> (rejects Error & { code: 'bad-input' | 'signed-out' |
 * 'too-many' | 'not-allowed' | 'failed' }), closeAll() → Promise<boolean> (false: the user chose "Ở lại").
 */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/
/**
 * In memory: CookieEncryption is off, a persist: partition would store Google session cookies in plaintext. Google's
 * sign-in is kept across runs in main's encrypted snapshot instead (google-keep-rules, <profile>/google-docs.bin).
 */
const PARTITION = 'sano-google-docs'
/** Document windows and their popups together. */
const MAX_WINDOWS = 20
/** At most one openExternal per document window in this time. */
const EXTERNAL_EVERY_MS = 2000
const DOC_PATH = Object.freeze({ docs: 'document', sheets: 'spreadsheets' })
/** The editor, Drive (same account), sign-in, and Google's cross-domain SetSID hop during sign-in. */
const NAVIGATION_HOSTS = Object.freeze(['docs.google.com', 'drive.google.com', 'accounts.google.com', 'accounts.youtube.com'])
/** The Docs/Sheets export redirect, not the rest of *.googleusercontent.com (arbitrary user content). */
const DOWNLOAD_HOST_RE = /^doc-[a-z0-9-]+-(?:docs|sheets)\.googleusercontent\.com$/
const DOWNLOAD_BLOB_PREFIX = 'blob:https://docs.google.com/'

const TEXT = Object.freeze({
  badInput: 'Tài liệu không hợp lệ.',
  signedOut: 'Đăng nhập tài khoản SANO trước khi mở tài liệu.',
  tooMany: 'Đang mở quá nhiều tài liệu. Đóng bớt rồi thử lại.',
  notCleared: 'Chưa dọn được phiên Google cũ. Thử lại.',
  failed: 'Chưa mở được tài liệu.',
})
const OK = Object.freeze({ ok: true, value: undefined })
const fail = (error, code) => ({ ok: false, error, code })

function parse(url) {
  try {
    return typeof url === 'string' ? new URL(url) : null
  } catch {
    return null
  }
}

/** https:, no userinfo, no port other than the default (URL drops :443). */
function plainHttps(u) {
  return !!u && u.protocol === 'https:' && !u.username && !u.password && u.port === ''
}

/** { id, kind } → the document's Google editor URL, or null. */
function docUrl(input) {
  const { id, kind } = input && typeof input === 'object' ? input : {}
  if (typeof id !== 'string' || !DRIVE_FILE_ID.test(id) || !Object.hasOwn(DOC_PATH, kind)) return null
  return `https://docs.google.com/${DOC_PATH[kind]}/d/${id}/edit`
}

/** Top-frame will-navigate / will-redirect of a docs window (and its popups): may it stay in the window? */
function navigationAllowed(url) {
  const u = parse(url)
  if (!plainHttps(u)) return false
  return NAVIGATION_HOSTS.includes(u.hostname) || (u.hostname === 'www.google.com' && u.pathname.startsWith('/accounts/'))
}

/** setWindowOpenHandler: 'allow' (a Google page, tracked), 'external' (default browser), or 'deny'. */
function popupDecision(url) {
  if (navigationAllowed(url)) return 'allow'
  const u = parse(url)
  return u && (u.protocol === 'https:' || u.protocol === 'mailto:') ? 'external' : 'deny'
}

/** The partition's will-download: Docs' own exports only (File → Download); the Save dialog stays Electron's. */
function downloadAllowed(url) {
  if (typeof url === 'string' && url.startsWith(DOWNLOAD_BLOB_PREFIX)) return true
  const u = parse(url)
  return plainHttps(u) && (u.hostname === 'docs.google.com' || DOWNLOAD_HOST_RE.test(u.hostname))
}

/** Copy only: notifications, camera / microphone, location, clipboard-read and the rest are denied. */
function permissionAllowed(permission) {
  return permission === 'clipboard-sanitized-write'
}

/** Host only, for the "refused" log lines: never the path or query (a document id, a search). */
function hostLabel(url) {
  const u = parse(url)
  if (!u) return 'not-a-url'
  if (u.protocol === 'blob:') return hostLabel(u.pathname)
  return u.host || u.protocol
}

/**
 * fx: { openWindow(url, key) → { focus(), destroy(), isDestroyed(), onClosed(cb) }, clearPartition() → Promise,
 * signedIn() → Promise<boolean>, confirm(n) → boolean (main's native dialog), openExternal(url), now(), log(line),
 * and Google's kept cookies (google-keep-rules, bound to the SANO user; none of them throws): restoreGoogle(),
 * startGoogle(), saveGoogle() / wipeGoogle() (each capped by main, then nothing is saved until the next restore) }.
 *
 * Invariant (docs/SANO-DESKTOP.md §3b): the partition may hold the Google sign-in of whoever used it last, so it is
 * `dirty` from the start and after every endSession (main's onSessionEnd: sign-out, a session dropped, another user).
 * A document opens only once a clear has succeeded since then: the next SANO user never inherits that Google sign-in.
 * What persists is the encrypted snapshot: put back after each clear an open made (a snapshot of another SANO user is
 * deleted unread), saved before endSession clears — or wiped with it when the account was turned off (403).
 */
function createDocs(fx) {
  const tracked = new Set() // every window: documents and their popups
  const documents = new Map() // 'kind:id' → its document window
  const lastExternal = new Map() // window key → time of its last openExternal
  let running = null // the clear in progress: an open waits for it
  let dirty = true
  let ends = 0 // endSession bumps it: an open it overtook is refused, a clear started before it does not count
  let fresh = false // cleared since Google's kept cookies were last put back
  let watching = false // fx.startGoogle ran

  const destroy = (win) => {
    tracked.delete(win)
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch (e) {
      fx.log(`[SanoVids] docs: destroy failed (${e && e.name})`)
    }
  }
  const destroyAll = () => {
    for (const win of [...tracked]) destroy(win)
    documents.clear()
  }
  const keep = (win, key) => {
    tracked.add(win)
    if (key) documents.set(key, win)
    win.onClosed(() => {
      tracked.delete(win)
      if (key && documents.get(key) === win) {
        documents.delete(key)
        lastExternal.delete(key)
      }
    })
  }
  const clear = async () => {
    const started = ends
    try {
      await fx.clearPartition()
      if (ends === started) dirty = false
      fresh = true
    } catch (e) {
      fx.log(`[SanoVids] docs: clear failed (${e && e.name})`) // stays dirty: the next open clears again
    }
  }
  /** Once per clear, before the next document opens: the signed-in user's kept Google cookies go back in. */
  const restore = async () => {
    if (!fresh) return
    fresh = false
    await fx.restoreGoogle()
    if (!watching) {
      watching = true
      fx.startGoogle()
    }
  }
  /** One clear at a time, in call order. */
  const queue = (task) => {
    const p = Promise.resolve(running).then(task)
    running = p
    p.finally(() => {
      if (running === p) running = null
    })
    return p
  }

  return {
    /** → { ok: true, value: undefined } | { ok: false, error, code }. */
    async open(input) {
      try {
        const url = docUrl(input)
        if (!url) return fail(TEXT.badInput, 'bad-input')
        const started = ends
        if (!(await fx.signedIn())) return fail(TEXT.signedOut, 'signed-out')
        await running
        if (dirty) await queue(clear)
        if (ends !== started) return fail(TEXT.signedOut, 'signed-out') // the session ended meanwhile
        if (dirty) return fail(TEXT.notCleared, 'failed')
        await queue(restore)
        if (ends !== started) return fail(TEXT.signedOut, 'signed-out')
        const key = `${input.kind}:${input.id}`
        const open = documents.get(key)
        if (open && !open.isDestroyed()) {
          open.focus()
          return OK
        }
        if (tracked.size >= MAX_WINDOWS) return fail(TEXT.tooMany, 'too-many')
        keep(fx.openWindow(url, key), key)
        return OK
      } catch (e) {
        fx.log(`[SanoVids] docs: unexpected ${e && e.name}`)
        return fail(TEXT.failed, 'failed')
      }
    },
    /**
     * Server-forced end (401/403/expiry/another user): every window goes, unload prompts unasked, Google's cookies are
     * saved (`wipe`: the account was turned off → removed with their snapshot), then the partition is cleared.
     */
    endSession({ wipe = false } = {}) {
      ends++
      dirty = true
      destroyAll()
      return queue(async () => {
        await (wipe ? fx.wipeGoogle() : fx.saveGoogle())
        await clear()
      })
    },
    /** The user's own sign-out, the main window closing: asks first when any window is open → false on "Ở lại". */
    closeAll({ ask } = {}) {
      if (tracked.size && ask && !fx.confirm(tracked.size)) return false
      destroyAll()
      return true
    },
    /**
     * The main window is about to close: asks when any window is open → false on "Ở lại". Destroys nothing: the page's
     * own beforeunload can still cancel the close, and 'closed' calls closeAll once it really happened.
     */
    confirmClose() {
      return !tracked.size || fx.confirm(tracked.size)
    },
    /**
     * did-create-window of a popup of the document `parentKey` (the key its external() calls use): tracked, or destroyed
     * here once MAX_WINDOWS are open → false.
     */
    track(parentKey, child) {
      if (tracked.size >= MAX_WINDOWS) {
        destroy(child)
        return false
      }
      keep(child, null)
      return true
    },
    /** A link out of a document window (https: / mailto:): at most one every 2 s per window, the rest dropped. */
    external(key, url) {
      const u = parse(url)
      if (!u || (u.protocol !== 'https:' && u.protocol !== 'mailto:')) return false
      const now = fx.now()
      if (lastExternal.has(key) && now - lastExternal.get(key) < EXTERNAL_EVERY_MS) {
        fx.log(`[SanoVids] docs: external throttled ${hostLabel(url)}`)
        return false
      }
      lastExternal.set(key, now)
      Promise.resolve()
        .then(() => fx.openExternal(url))
        .catch(() => fx.log('[SanoVids] docs: external failed'))
      return true
    },
  }
}

module.exports = {
  DRIVE_FILE_ID,
  PARTITION,
  MAX_WINDOWS,
  EXTERNAL_EVERY_MS,
  NAVIGATION_HOSTS,
  TEXT,
  docUrl,
  navigationAllowed,
  popupDecision,
  downloadAllowed,
  permissionAllowed,
  hostLabel,
  createDocs,
}

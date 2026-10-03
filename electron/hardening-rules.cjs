// SanoVids — pure hardening rules of the desktop shell (electron/main.cjs). Unit-tested by
// src/lib/__tests__/hardeningRules.test.ts. See docs/SIGNING.md "Bảo mật".
//
// No require at all (not 'electron', not node:crypto): plain data in, plain data out. Only language / runtime globals
// (TextEncoder, TextDecoder, btoa) are used, so main.cjs, the tests and scripts can all load it.
'use strict'

// ---------------------------------------------------------------------------------------------------------------
// Command-line switches
// ---------------------------------------------------------------------------------------------------------------

/**
 * Never accepted by a packaged SanoVids: debuggers, V8 flags, switches that turn Chromium's security off, switches that
 * make the signed SanoVids.exe start ANOTHER program as one of its helper processes (gpu-launcher, *-cmd-prefix,
 * browser-subprocess-path: a known way to abuse signed Chromium apps), and switches that write TLS secrets or full
 * network logs to disk. `disable-features` is the catch-all for turning sandbox / site-isolation features off; the app
 * never passes it (checked on Electron 44: none of these is present on a normal launch, before or after ready).
 */
const ALWAYS_REFUSED = Object.freeze([
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-brk-node',
  'inspect-publish-uid',
  'inspect-wait',
  'debug',
  'debug-brk',
  'debug-port',
  'js-flags',
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'no-sandbox',
  'disable-web-security',
  'disable-site-isolation-trials',
  'allow-running-insecure-content',
  'unsafely-treat-insecure-origin-as-secure',
  'gpu-launcher',
  'renderer-cmd-prefix',
  'utility-cmd-prefix',
  'browser-subprocess-path',
  'disable-gpu-sandbox',
  'single-process',
  'in-process-gpu',
  'disable-features',
  'ssl-key-log-file',
  'log-net-log',
])

/**
 * Remote debugging (DevTools protocol): only in a TEST build (a `sanovidsTestProfileDir` baked into its package.json,
 * which the release gate refuses) running on an isolated test profile, for the E2E harness. Never in the official
 * build, whatever the environment says (SANOVIDS_PROFILE_DIR alone only isolates the data).
 */
const REMOTE_DEBUG = Object.freeze(['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins'])

const REFUSED_DIALOG_TEXT =
  'SanoVids không mở khi có tham số gỡ lỗi hoặc tham số tắt bảo mật (ví dụ --remote-debugging-port, --inspect, --no-sandbox). Hãy mở SanoVids bằng biểu tượng bình thường, không thêm tham số.'

/** An isolated test profile (SANOVIDS_PROFILE_DIR or a baked test build) — never a real user's data folder. */
const isTestProfile = (source) => source === 'env' || source === 'baked'

/** Debugging aids (remote debugging, DevTools) in a packaged app: a test build on an isolated test profile only. */
const debugAllowed = (testBuild, profileSource) => testBuild === true && isTestProfile(profileSource)

/**
 * Is this the packaged app? Electron's app.isPackaged only looks at the exe FILE NAME ("electron.exe" → false), so a
 * copy of SanoVids.exe renamed electron.exe would switch every packaged-only protection off while still running the
 * real app.asar on the real profile. With the OnlyLoadAppFromAsar fuse a packaged binary always runs
 * resources\app.asar; `electron .` from source runs the project folder. Either signal → packaged (fail closed).
 */
function isPackagedApp(o) {
  const { isPackaged, appPath } = o && typeof o === 'object' ? o : {}
  return isPackaged === true || (typeof appPath === 'string' && /\.asar[\\/]?$/i.test(appPath))
}

/**
 * Switches a packaged app refuses to start with (lower-case names, [] = start normally). Queried only through
 * `hasSwitch` (app.commandLine.hasSwitch: Chromium's own parser, which also reads "-switch" / "/switch" on Windows and
 * lower-cases names) — never by scanning argv. A `hasSwitch` that throws counts the name as present (fail closed).
 * `testBuild`: the app's package.json has a baked `sanovidsTestProfileDir` (test-identity builds only).
 */
function refusedSwitches(o) {
  const { isPackaged, profileSource, testBuild, hasSwitch } = o && typeof o === 'object' ? o : {}
  if (isPackaged === false) return []
  const names = debugAllowed(testBuild, profileSource) ? ALWAYS_REFUSED : [...ALWAYS_REFUSED, ...REMOTE_DEBUG]
  const out = []
  for (const name of names) {
    let present = true
    try {
      present = !!hasSwitch(name)
    } catch {
      present = true
    }
    if (present) out.push(name)
  }
  return out
}

/** DevTools (webPreferences.devTools, F12 / Ctrl+Shift+I): from source, or in a test build on an isolated test profile. */
function allowDevTools(o) {
  const { isPackaged, profileSource, testBuild } = o && typeof o === 'object' ? o : {}
  return isPackaged === false || debugAllowed(testBuild, profileSource)
}

// ---------------------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------------------

/**
 * Environment variables a packaged SanoVids removes from its own process before Chromium reads them. SSLKEYLOGFILE
 * makes Chromium write every TLS session key to that file (same effect as the refused --ssl-key-log-file switch);
 * Wireshark users often set it machine-wide, so it is dropped silently instead of refusing to start.
 */
const STRIPPED_ENV = Object.freeze(['SSLKEYLOGFILE'])

/** The names (as spelled in `env`) a packaged app deletes from process.env. From source: none. */
function envToStrip(o) {
  const { isPackaged, env } = o && typeof o === 'object' ? o : {}
  if (isPackaged === false || !env || typeof env !== 'object') return []
  return Object.keys(env).filter((k) => STRIPPED_ENV.includes(k.toUpperCase()))
}

// ---------------------------------------------------------------------------------------------------------------
// Downloads (session 'will-download')
// ---------------------------------------------------------------------------------------------------------------

/** What the page ever downloads: videos, posters (svg placeholder included), the prompt .txt, the .zip, .json exports. */
const DOWNLOAD_ALLOWED_EXT = Object.freeze(['mp4', 'webm', 'mov', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'svg', 'txt', 'zip', 'json'])
/** Only blobs the SanoVids page itself made (URL.createObjectURL on app://bdp). */
const DOWNLOAD_URL_PREFIX = 'blob:app://bdp/'
const DOWNLOAD_BAD_NAME_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/

/** Lower-case extension of a download's file name, '' when it has none (or ends with a dot / space, or names a path). */
function downloadExtension(filename) {
  if (typeof filename !== 'string' || !filename || DOWNLOAD_BAD_NAME_RE.test(filename) || /[.\s]$/.test(filename)) return ''
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

function downloadAllowed(url, filename) {
  return typeof url === 'string' && url.startsWith(DOWNLOAD_URL_PREFIX) && DOWNLOAD_ALLOWED_EXT.includes(downloadExtension(filename))
}

/** Short label for the "download refused" log line: never the file name or the URL. */
function downloadLogLabel(url, filename) {
  if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_URL_PREFIX)) return 'not-an-app-blob'
  const ext = downloadExtension(filename)
  return ext ? '.' + ext.replace(/[^a-z0-9]/g, '?').slice(0, 16) : 'no-extension'
}

// ---------------------------------------------------------------------------------------------------------------
// Web permissions of the default session (the SanoVids window)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Copy buttons, the web folder picker API, full-screen video, and navigator.storage.persist() (store/persist.ts asks at
 * every start so the IndexedDB projects are never evicted; it grants no device or data access). Everything else
 * (camera, location, notifications…) is denied.
 */
const DEFAULT_SESSION_PERMISSIONS = Object.freeze(['clipboard-sanitized-write', 'fileSystem', 'fullscreen', 'persistent-storage'])

function permissionAllowed(permission) {
  return typeof permission === 'string' && DEFAULT_SESSION_PERMISSIONS.includes(permission)
}

// ---------------------------------------------------------------------------------------------------------------
// Content-Security-Policy of the app's HTML (app://bdp)
// ---------------------------------------------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 of `bytes` (Uint8Array) → 32 bytes. Plain FIPS 180-4, so this file needs no require. */
function sha256(bytes) {
  const len = bytes.length
  const total = Math.ceil((len + 9) / 64) * 64
  const buf = new Uint8Array(total)
  buf.set(bytes)
  buf[len] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(total - 8, Math.floor(len / 0x20000000))
  view.setUint32(total - 4, (len * 8) >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, k] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      k = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] += a
    h[1] += b
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += k
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i])
  return out
}

/** Bytes → "binary string" (one char per byte, 0–255) and back: tags are ASCII, so bytes are searched without decoding. */
function bytesToBinary(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return s
}
function binaryToBytes(s) {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** sha256 → base64 (the CSP source format). */
function sha256Base64(bytes) {
  return btoa(bytesToBinary(sha256(bytes)))
}

/**
 * 'sha256-<base64>' of every inline <script> (no src attribute), in document order. `html` is the page's bytes
 * (Uint8Array / Buffer, hashed exactly as stored, UTF-8) or a string (encoded as UTF-8). Line breaks are normalized to
 * LF first, like the HTML parser does before the browser hashes the script text.
 */
function inlineScriptHashes(html) {
  let bin = ''
  if (html instanceof Uint8Array) bin = bytesToBinary(html)
  else if (typeof html === 'string') bin = bytesToBinary(new TextEncoder().encode(html))
  else return []
  const out = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  for (let m = re.exec(bin); m; m = re.exec(bin)) {
    if (/(?:^|\s)src\s*=/i.test(m[1])) continue
    out.push('sha256-' + sha256Base64(binaryToBytes(m[2].replace(/\r\n?/g, '\n'))))
  }
  return out
}

/** The policy sent with every HTML page of app://bdp: only the app's own files, plus its inline theme script by hash. */
function contentSecurityPolicy(html) {
  const hashes = inlineScriptHashes(html).map((h) => `'${h}'`)
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check of the app's own code signature ('app:signature', src/lib/appSignature.ts re-validates it)
// ---------------------------------------------------------------------------------------------------------------

const APP_SIGNATURE_STATUSES = Object.freeze(['signed', 'unsigned', 'other-signer', 'tampered', 'unknown'])
const SIGNER_MAX = 200
// C0 / C1 controls and invisible format characters (bidi overrides, zero-width…): a signer name never hides or reorders text.
const SIGNER_DROP_RE = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Display name of the signer: controls stripped, NFC, at most 200 UTF-16 units (never half an emoji). '' when empty. */
function cleanSigner(raw) {
  if (typeof raw !== 'string') return ''
  let s = raw.replace(LONE_SURROGATE_RE, '').replace(SIGNER_DROP_RE, '').normalize('NFC').trim()
  if (s.length > SIGNER_MAX) {
    s = s.slice(0, SIGNER_MAX)
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1)
  }
  return s
}

/**
 * electron/signature.cjs verdict → the renderer payload { status, packaged, signer?, thumbprint? }. signer / thumbprint
 * only for 'signed' and 'other-signer'. A 'signed' status without ok:true (inconsistent verdict) becomes 'unknown'.
 */
function appSignaturePayload(verdict, opts) {
  const packaged = !!(opts && opts.packaged === true)
  const v = verdict && typeof verdict === 'object' ? verdict : {}
  let status = APP_SIGNATURE_STATUSES.includes(v.status) ? v.status : 'unknown'
  if (status === 'signed' && v.ok !== true) status = 'unknown'
  const out = { status, packaged }
  if (status === 'signed' || status === 'other-signer') {
    const signer = cleanSigner(v.signer)
    if (signer) out.signer = signer
    const thumbprint = typeof v.thumbprint === 'string' ? v.thumbprint.replace(/\s+/g, '').toUpperCase() : ''
    if (/^[0-9A-F]{40}$/.test(thumbprint)) out.thumbprint = thumbprint
  }
  return out
}

// The DLLs next to the running exe that SanoVids processes load: the four Electron ships unsigned, which the build signs
// by name (package.json build.win.signExts: must be signed by a pinned author certificate), and the two Microsoft signs
// (must keep a valid Microsoft signature, never ours). The install folder is writable by the user, so the self-check
// covers them too, not only the exe. scripts/buildInspect.mjs checks the same lists at release time.
const SIGNED_DLLS = Object.freeze(['ffmpeg.dll', 'vk_swiftshader.dll', 'vulkan-1.dll', 'dxcompiler.dll'])
const MICROSOFT_DLLS = Object.freeze(['d3dcompiler_47.dll', 'dxil.dll'])
/** Simple name (CN) of Microsoft's code-signing certificates: not localized, unlike Get-AuthenticodeSignature's texts. */
const MICROSOFT_SIGNER = 'Microsoft Corporation'
/** Self-check companions of process.execPath, in check order: { name, kind: 'author' | 'microsoft' }. */
const SELF_CHECK_FILES = Object.freeze([
  ...SIGNED_DLLS.map((name) => Object.freeze({ name, kind: 'author' })),
  ...MICROSOFT_DLLS.map((name) => Object.freeze({ name, kind: 'microsoft' })),
])
const THUMBPRINT_RE = /^[0-9A-F]{40}$/

/**
 * One self-check companion → 'ok' | 'bad' | 'unknown'. `result` = { parsed, verdict } (electron/signature.cjs
 * checkFilesSignature: the normalized PowerShell output and its judgeSignature verdict against `pins`).
 *   author     the verdict decides: signed by a pin → ok; tampered / unsigned / another signer → bad; else unknown.
 *   microsoft  the raw output decides, in order: unreadable (missing file, error) → unknown; signed by one of OUR pins
 *              → bad; NotSigned (2) / HashMismatch (3) / NotTrusted (4) → bad; not Authenticode (catalog) or no
 *              signer certificate → unknown; Valid (0) by "Microsoft Corporation" → ok; Valid by anyone else → bad;
 *              UnknownError (1) with CERT_E_UNTRUSTEDROOT (a self-signed impostor: Microsoft's chain is always
 *              trusted) → bad; anything else (revocation offline, …) → unknown.
 */
function selfCheckFileState(kind, result, pins) {
  const r = result && typeof result === 'object' ? result : {}
  if (kind === 'author') {
    const v = r.verdict && typeof r.verdict === 'object' ? r.verdict : {}
    if (v.ok === true && v.status === 'signed') return 'ok'
    return v.status === 'tampered' || v.status === 'unsigned' || v.status === 'other-signer' ? 'bad' : 'unknown'
  }
  if (kind !== 'microsoft') return 'unknown'
  const p = r.parsed && typeof r.parsed === 'object' ? r.parsed : null
  if (!p || p.v !== 1 || p.error != null || !Number.isInteger(p.status)) return 'unknown'
  const ours = (Array.isArray(pins) ? pins : []).map((x) => String(x).replace(/\s+/g, '').toUpperCase())
  const thumb = typeof p.thumbprint === 'string' ? p.thumbprint.replace(/\s+/g, '').toUpperCase() : ''
  if (thumb && ours.includes(thumb)) return 'bad'
  if (p.status === 2 || p.status === 3 || p.status === 4) return 'bad'
  if (p.sigType !== 'Authenticode' || !THUMBPRINT_RE.test(thumb)) return 'unknown'
  if (p.status === 0) return p.signer === MICROSOFT_SIGNER ? 'ok' : 'bad'
  if (p.status === 1 && p.hresult === '0x800B0109') return 'bad'
  return 'unknown'
}

/**
 * The self-check verdict from the exe's verdict and its companions' states ([{ name, state }]). The exe decides unless
 * it is 'signed'; then any 'bad' companion → tampered (signer / thumbprint dropped by appSignaturePayload), any other
 * non-'ok' one (missing, unreadable) → unknown. `files` names the companions that changed the verdict (log only).
 */
function combineSelfCheck(exeVerdict, fileStates) {
  const exe = exeVerdict && typeof exeVerdict === 'object' ? exeVerdict : null
  if (!exe) return { ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false }
  if (exe.status !== 'signed' || exe.ok !== true) return exe
  if (!Array.isArray(fileStates)) return { ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false, files: [] }
  const label = (f) => (f && typeof f.name === 'string' && f.name ? f.name : '?')
  const bad = fileStates.filter((f) => f && f.state === 'bad').map(label)
  if (bad.length) return { ok: false, status: 'tampered', reason: 'hash-mismatch', timestamped: false, files: bad }
  const unsure = fileStates.filter((f) => !f || f.state !== 'ok').map(label)
  if (unsure.length) return { ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false, files: unsure }
  return exe
}

module.exports = {
  ALWAYS_REFUSED,
  REMOTE_DEBUG,
  REFUSED_DIALOG_TEXT,
  isPackagedApp,
  refusedSwitches,
  allowDevTools,
  STRIPPED_ENV,
  envToStrip,
  DOWNLOAD_ALLOWED_EXT,
  DOWNLOAD_URL_PREFIX,
  downloadExtension,
  downloadAllowed,
  downloadLogLabel,
  DEFAULT_SESSION_PERMISSIONS,
  permissionAllowed,
  sha256Base64,
  inlineScriptHashes,
  contentSecurityPolicy,
  APP_SIGNATURE_STATUSES,
  appSignaturePayload,
  SIGNED_DLLS,
  MICROSOFT_DLLS,
  MICROSOFT_SIGNER,
  SELF_CHECK_FILES,
  selfCheckFileState,
  combineSelfCheck,
}

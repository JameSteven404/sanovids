// SanoVids — pure hardening rules of the desktop shell (electron/main.cjs). Unit-tested by
// src/lib/__tests__/hardeningRules.test.ts. See docs/SIGNING.md "Bảo mật".
//
// No require at all (not 'electron', not node:crypto): plain data in, plain data out. Only language / runtime globals
// (TextEncoder, TextDecoder, btoa) are used, so main.cjs, the tests and scripts can all load it.
'use strict'

// ---------------------------------------------------------------------------------------------------------------
// Command-line switches
// ---------------------------------------------------------------------------------------------------------------

/** Never accepted by a packaged SanoVids: debuggers, V8 flags, and switches that turn Chromium's security off. */
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
])

/** Remote debugging (DevTools protocol): only with an isolated test profile (env / baked), for the E2E harness. */
const REMOTE_DEBUG = Object.freeze(['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins'])

const REFUSED_DIALOG_TEXT =
  'SanoVids không mở khi có tham số gỡ lỗi hoặc tham số tắt bảo mật (ví dụ --remote-debugging-port, --inspect, --no-sandbox). Hãy mở SanoVids bằng biểu tượng bình thường, không thêm tham số.'

/** An isolated test profile (SANOVIDS_PROFILE_DIR or a baked test build) — never a real user's data folder. */
const isTestProfile = (source) => source === 'env' || source === 'baked'

/**
 * Switches a packaged app refuses to start with (lower-case names, [] = start normally). Queried only through
 * `hasSwitch` (app.commandLine.hasSwitch: Chromium's own parser, which also reads "-switch" / "/switch" on Windows and
 * lower-cases names) — never by scanning argv. A `hasSwitch` that throws counts the name as present (fail closed).
 */
function refusedSwitches(o) {
  const { isPackaged, profileSource, hasSwitch } = o && typeof o === 'object' ? o : {}
  if (isPackaged === false) return []
  const names = isTestProfile(profileSource) ? ALWAYS_REFUSED : [...ALWAYS_REFUSED, ...REMOTE_DEBUG]
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

/** DevTools (webPreferences.devTools, F12 / Ctrl+Shift+I): from source, or with an isolated test profile. */
function allowDevTools(o) {
  const { isPackaged, profileSource } = o && typeof o === 'object' ? o : {}
  return isPackaged === false || isTestProfile(profileSource)
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

/** Copy buttons, the web folder picker API, full-screen video. Everything else (camera, location, notifications…) is denied. */
const DEFAULT_SESSION_PERMISSIONS = Object.freeze(['clipboard-sanitized-write', 'fileSystem', 'fullscreen'])

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

module.exports = {
  ALWAYS_REFUSED,
  REMOTE_DEBUG,
  REFUSED_DIALOG_TEXT,
  refusedSwitches,
  allowDevTools,
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
}

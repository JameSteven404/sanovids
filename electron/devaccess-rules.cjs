// SanoVids — pure rules of the development-mode lock ("ẩn chế độ Phát triển"). electron/devaccess.cjs wires them to
// IPC, the userData file and the clock; scripts/owner/mo-khoa.mjs (the owner's code tool, never packaged) builds codes
// with the same functions. Unit-tested by src/lib/__tests__/devAccessRules.test.ts.
//
// No require at all (like updater-rules.cjs / hardening-rules.cjs): SHA-256, HMAC-SHA1 and the Ed25519 check are
// INJECTED (node:crypto in main and in the owner tool, fakes or node:crypto in the tests), so every decision here is
// plain data in, plain data out. Only language globals (TextEncoder) are used.
//
// What it decides:
//   - who may use development mode: 'build' (opened by the kind of build: from source / a test build, the same rule as
//     DevTools), 'unlocked' (an owner code was accepted on THIS device, until a time), 'locked' (release builds);
//   - owner unlock codes "SV1-…": 16 bytes (version + key id, flags, device id, use-by hour, max days, nonce) signed with
//     the owner's Ed25519 key (only the public key is pinned in package.json sanovids.devUnlockKeys). One use per code,
//     one device per code;
//   - per-device authenticator codes (RFC 6238 TOTP, SHA-1, 6 digits, 30 s), linked only right after a code unlock;
//   - the wait after wrong 6-digit codes, the "Giữ mở khoá" lifetime, what each IPC operation may do in each state.
// Nothing here ever logs, and the public state (stateView) never carries a secret.
'use strict'

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

/** "Giữ mở khoá" choices in days; 0 = until locked by hand. */
const KEEP_DAYS = Object.freeze([1, 7, 30, 0])
const DEFAULT_KEEP_DAYS = 7
const CODE_PREFIX = 'SV1'
/** Signed bytes = SIGN_CONTEXT ‖ payload (domain separation: the owner key signs nothing else with this prefix). */
const SIGN_CONTEXT = 'SanoVids/dev-unlock/v1\0'
const DEVICE_CONTEXT = 'SanoVids/dev-device/v1'
/** Use-by hours count from here. */
const EPOCH_MS = Date.UTC(2026, 0, 1)
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const PAYLOAD_BYTES = 16
const SIGNATURE_BYTES = 64
const CODE_BYTES = PAYLOAD_BYTES + SIGNATURE_BYTES
/** 80 bytes = 640 bits = exactly 128 Crockford characters. */
const CODE_CHARS = 128
/** Longer input is refused before any parsing (a pasted code with dashes is ~147 characters). */
const MAX_INPUT = 300
const DEVICE_ID_BYTES = 5
const NONCE_BYTES = 5
/** Code nonces remembered per device (one use per code). */
const USED_MAX = 64
/** The authenticator may be linked during this long after a code unlock that allows it. */
const LINK_WINDOW_MS = 5 * 60_000
/** The clock went back more than this before the unlock time → locked. */
const CLOCK_BACK_MS = 5 * 60_000
/** Owner tool limits: a code that allows linking lives 4 h by default (≤ 24 h); one that does not, 48 h (≤ 336 h). */
const CODE_HOURS = Object.freeze({ linkDefault: 4, linkMax: 24, plainDefault: 48, plainMax: 336 })
/**
 * A code whose use-by lies further ahead than this means this computer's date is days behind. The longest code the
 * owner tool makes (CODE_HOURS.plainMax = 14 days) has its use-by rounded UP to the next whole hour (useByHoursOf):
 * up to 1 h more, plus 1 h for two clocks that disagree a little — still far below "days behind".
 */
const MAX_USEBY_AHEAD_MS = (CODE_HOURS.plainMax + 2) * HOUR_MS
const TOTP_PERIOD_S = 30
const TOTP_DIGITS = 6
/** A code matching this many steps away (but not ±1) means the clock is off: never accepted, counted as wrong. */
const TOTP_SKEW_STEPS = 20
/** Wrong 6-digit codes allowed before the first wait. */
const FREE_FAILS = 4
const WAIT_BASE_MS = 5 * 60_000
const WAIT_MAX_MS = 60 * 60_000
/** Two unlock attempts at least this far apart. */
const MIN_ATTEMPT_GAP_MS = 1000

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Public keys of RFC 8032 §7.1 (TEST 1, 2, 3, 1024, SHA(abc)): their private keys are published, so anyone could sign
 * codes for them. Never trusted as a pin; the release gate refuses them too.
 */
const RFC8032_TEST_KEYS = Object.freeze([
  '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  'PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw',
  '_FHNjmIYoaONpH7QAjDwWAgW7RO6MwOsXeuRFUiQgCU',
  'J4EX_BRMcjQPZ9DyMW6Dhs7_vyskKMnFH-98WX8dQm4',
  '7Bcrk61eVjv0kyxw4SRQNMNUZ-8u_U1k6_gZaDRn4r8',
])

// ---------------------------------------------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------------------------------------------

/** Bytes → text in a 32-letter alphabet (5 bits per letter, most significant first, zero-padded at the end). */
function encode5(bytes, alphabet) {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const b of bytes) {
    buffer = ((buffer << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31]
  return out
}

/** Text in a 32-letter alphabet → bytes; null on a letter outside it or non-zero padding bits. */
function decode5(text, alphabet) {
  const out = []
  let buffer = 0
  let bits = 0
  for (const ch of text) {
    const v = alphabet.indexOf(ch)
    if (v < 0) return null
    buffer = ((buffer << 5) | v) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null
  return Uint8Array.from(out)
}

/** Crockford base32 reading rules: case-insensitive, spaces and dashes ignored, O → 0, I / L → 1. */
function normalizeCrockford(text) {
  return String(text).toUpperCase().replace(/[\s -]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}

function crockfordEncode(bytes) {
  return encode5(bytes, CROCKFORD)
}

/** → bytes, or null (any letter outside the alphabet — 'U' included — or empty input). */
function crockfordDecode(text) {
  if (typeof text !== 'string') return null
  const s = normalizeCrockford(text)
  if (!s) return null
  return decode5(s, CROCKFORD)
}

/** RFC 4648 base32 without padding (the authenticator secret). */
function base32Encode(bytes) {
  return encode5(bytes, BASE32)
}

function base32Decode(text) {
  if (typeof text !== 'string' || !/^[A-Z2-7]+$/.test(text)) return null
  return decode5(text, BASE32)
}

function b64urlEncode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const left = bytes.length - i
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63]
    if (left > 1) out += B64URL[(n >>> 6) & 63]
    if (left > 2) out += B64URL[n & 63]
  }
  return out
}

/** base64url without padding → bytes, or null. */
function b64urlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const out = []
  let buffer = 0
  let bits = 0
  for (const ch of text) {
    buffer = ((buffer << 6) | B64URL.indexOf(ch)) & 0xffff
    bits += 6
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null
  return Uint8Array.from(out)
}

const utf8 = (s) => new TextEncoder().encode(s)

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Same length strings compared without an early exit. */
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 'XXXXXXXX…' → 'XXXXXXXX-XXXXXXXX-…' */
const groupBy = (text, n, sep = '-') => (text.match(new RegExp(`.{1,${n}}`, 'g')) || []).join(sep)

// ---------------------------------------------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------------------------------------------

/** 40-bit device id = SHA-256(DEVICE_CONTEXT ‖ device secret)[0..5). `sha256(bytes) → bytes` is injected. */
function deviceIdOf(deviceSecret, sha256) {
  return Uint8Array.from(sha256(concatBytes(utf8(DEVICE_CONTEXT), deviceSecret)).slice(0, DEVICE_ID_BYTES))
}

/** The device code people read and type: the 40-bit device id in Crockford, 'XXXX-XXXX'. */
function deviceCodeText(deviceId) {
  return deviceId && deviceId.length === DEVICE_ID_BYTES ? groupBy(crockfordEncode(deviceId), 4) : ''
}

function deviceCodeOf(deviceSecret, sha256) {
  return deviceCodeText(deviceIdOf(deviceSecret, sha256))
}

/** 'XXXX-XXXX' (any Crockford spelling) → the 5-byte device id, or null. */
function parseDeviceCode(text) {
  if (typeof text !== 'string' || text.length > 40) return null
  const s = normalizeCrockford(text)
  if (s.length !== 8) return null
  const bytes = decode5(s, CROCKFORD)
  return bytes && bytes.length === DEVICE_ID_BYTES ? bytes : null
}

// ---------------------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------------------

/**
 * What was typed / pasted in the unlock box → { kind: 'totp', digits } (6 digits) | { kind: 'email', digits } (8 digits;
 * the Gmail stage, not built yet) | { kind: 'signed', bytes, text } (an SV1 code: 128 Crockford characters, optional
 * "SV1" prefix, dashes / spaces / case ignored; `text` = canonical "SV1-XXXXXXXX-…") | { kind: 'bad' }. Never throws.
 */
function classifyInput(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_INPUT) return { kind: 'bad' }
  const compact = raw.replace(/[\s -]+/g, '')
  if (/^\d{6}$/.test(compact)) return { kind: 'totp', digits: compact }
  if (/^\d{8}$/.test(compact)) return { kind: 'email', digits: compact }
  let s = normalizeCrockford(raw)
  if (s.length === CODE_CHARS + CODE_PREFIX.length && s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length)
  if (s.length !== CODE_CHARS) return { kind: 'bad' }
  const bytes = decode5(s, CROCKFORD)
  if (!bytes || bytes.length !== CODE_BYTES) return { kind: 'bad' }
  return { kind: 'signed', bytes, text: `${CODE_PREFIX}-${groupBy(s, 8)}` }
}

// ---------------------------------------------------------------------------------------------------------------
// Signed codes
// ---------------------------------------------------------------------------------------------------------------

const uint24 = (b, at) => (b[at] << 16) | (b[at + 1] << 8) | b[at + 2]

/**
 * The 16 signed bytes of a code: [0] (ver << 4) | kid · [1] flags (bit0 dev = 1, bit1 link) · [2..7) device id ·
 * [7..10) use-by hour since EPOCH_MS (uint24) · [10] max days (0 = the device's own "Giữ mở khoá") · [11..16) nonce.
 * Throws on out-of-range input (owner tool only).
 */
function buildPayload({ kid, link, deviceId, useByHours, maxDays = 0, nonce }) {
  if (!Number.isInteger(kid) || kid < 1 || kid > 15) throw new Error('kid 1–15')
  if (!(deviceId instanceof Uint8Array) || deviceId.length !== DEVICE_ID_BYTES) throw new Error('device id')
  if (!Number.isInteger(useByHours) || useByHours < 0 || useByHours > 0xffffff) throw new Error('use-by')
  if (!Number.isInteger(maxDays) || maxDays < 0 || maxDays > 255) throw new Error('max days')
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) throw new Error('nonce')
  const p = new Uint8Array(PAYLOAD_BYTES)
  p[0] = (1 << 4) | kid
  p[1] = 1 | (link ? 2 : 0)
  p.set(deviceId, 2)
  p[7] = (useByHours >>> 16) & 255
  p[8] = (useByHours >>> 8) & 255
  p[9] = useByHours & 255
  p[10] = maxDays
  p.set(nonce, 11)
  return p
}

/** What the owner key signs for a payload. */
function signedMessage(payload) {
  return concatBytes(utf8(SIGN_CONTEXT), payload)
}

/** payload ‖ signature → the "SV1-XXXXXXXX-…" text (16 groups of 8). */
function formatCode(payload, signature) {
  return `${CODE_PREFIX}-${groupBy(crockfordEncode(concatBytes(payload, signature)), 8)}`
}

/** Use-by hour (uint24 since EPOCH_MS, rounded up) of an instant. */
const useByHoursOf = (ms) => Math.ceil((ms - EPOCH_MS) / HOUR_MS)

/** Pinned owner keys: kid → alg + key. Duplicate kids and the RFC 8032 test keys are dropped (never trusted). */
function parseDevUnlockPins(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Map()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const keys = Object.keys(item).sort().join(',')
    if (keys !== 'alg,key,kid') continue
    const { kid, alg, key } = item
    if (!Number.isInteger(kid) || kid < 1 || kid > 15 || alg !== 'ed25519' || typeof key !== 'string' || key.length !== 43) continue
    const bytes = b64urlDecode(key)
    if (!bytes || bytes.length !== 32 || RFC8032_TEST_KEYS.includes(key)) continue
    seen.set(kid, seen.has(kid) ? null : { kid, alg, key })
  }
  return [...seen.values()].filter(Boolean)
}

/**
 * Why a package.json `sanovids.devUnlockKeys` value cannot ship in a release (Vietnamese, [] = fine) — shared with the
 * release gate (scripts/releaseLib.mjs checkDevUnlockPins) and the owner tool ("kiem-tra --chi-ghim").
 */
function pinProblems(raw) {
  if (raw === undefined) return ['Chưa ghim khoá mở khoá (package.json sanovids.devUnlockKeys).']
  if (!Array.isArray(raw)) return ['sanovids.devUnlockKeys phải là một danh sách.']
  if (!raw.length) return ['sanovids.devUnlockKeys trống: chưa ghim khoá mở khoá nào.']
  const out = []
  const kids = new Set()
  raw.forEach((item, i) => {
    const at = `devUnlockKeys[${i}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      out.push(`${at} không phải một mục { kid, alg, key }.`)
      return
    }
    const keys = Object.keys(item).sort().join(',')
    if (keys !== 'alg,key,kid') out.push(`${at} phải có đúng ba trường kid, alg, key (đang có: ${Object.keys(item).join(', ') || 'không có'}).`)
    if (!Number.isInteger(item.kid) || item.kid < 1 || item.kid > 15) out.push(`${at}.kid phải là số nguyên 1–15.`)
    else if (kids.has(item.kid)) out.push(`${at}.kid ${item.kid} bị trùng.`)
    else kids.add(item.kid)
    if (item.alg !== 'ed25519') out.push(`${at}.alg phải là "ed25519".`)
    const bytes = typeof item.key === 'string' && item.key.length === 43 ? b64urlDecode(item.key) : null
    if (!bytes || bytes.length !== 32) out.push(`${at}.key phải là khoá công khai Ed25519 32 byte (base64url, 43 ký tự).`)
    else if (RFC8032_TEST_KEYS.includes(item.key)) out.push(`${at}.key là khoá thử công khai của RFC 8032 (ai cũng có khoá riêng của nó) — không bao giờ được phát hành.`)
  })
  return out
}

/** The 8-character check code of a public key (owner tool, "kiem-tra --chi-ghim"): Crockford of SHA-256(key)[0..5). */
function pinCheckCode(keyB64url, sha256) {
  const bytes = b64urlDecode(keyB64url)
  if (!bytes || bytes.length !== 32) return ''
  return crockfordEncode(Uint8Array.from(sha256(bytes).slice(0, 5)))
}

function codeFields(bytes) {
  return {
    ver: bytes[0] >> 4,
    kid: bytes[0] & 15,
    flags: bytes[1],
    deviceId: bytes.subarray(2, 2 + DEVICE_ID_BYTES),
    useByMs: EPOCH_MS + uint24(bytes, 7) * HOUR_MS,
    maxDays: bytes[10],
    nonce: crockfordEncode(bytes.subarray(11, 16)),
  }
}

/** `verify(pin, message, signature) → boolean` (injected); a throw counts as a bad signature. */
function signatureOk(verify, pin, bytes) {
  try {
    return verify(pin, signedMessage(bytes.subarray(0, PAYLOAD_BYTES)), bytes.subarray(PAYLOAD_BYTES)) === true
  } catch {
    return false
  }
}

const flagsOk = (flags) => (flags & 1) === 1 && (flags & ~3) === 0

/**
 * Decision table of an SV1 code (first failing check wins): malformed → newer-format → no-keys → unknown-key →
 * bad-signature → malformed (flags, only after the signature) → other-device → expired → clock → used → ok.
 * → { ok: true, kid, link, maxDays, useByMs, nonce } | { ok: false, error, codeDevice?, thisDevice? }
 */
function judgeSignedCode(o) {
  const { bytes, pins, deviceId, nowMs, used, verify } = o && typeof o === 'object' ? o : {}
  if (!(bytes instanceof Uint8Array) || bytes.length !== CODE_BYTES) return { ok: false, error: 'malformed' }
  const f = codeFields(bytes)
  if (f.ver !== 1) return { ok: false, error: 'newer-format' }
  const list = Array.isArray(pins) ? pins : []
  if (!list.length) return { ok: false, error: 'no-keys' }
  const pin = list.find((p) => p && p.kid === f.kid)
  if (!pin) return { ok: false, error: 'unknown-key' }
  if (!signatureOk(verify, pin, bytes)) return { ok: false, error: 'bad-signature' }
  if (!flagsOk(f.flags)) return { ok: false, error: 'malformed' }
  if (!sameBytes(f.deviceId, deviceId)) return { ok: false, error: 'other-device', codeDevice: deviceCodeText(f.deviceId), thisDevice: deviceCodeText(deviceId) }
  if (!Number.isFinite(nowMs) || nowMs > f.useByMs) return { ok: false, error: 'expired' }
  if (f.useByMs > nowMs + MAX_USEBY_AHEAD_MS) return { ok: false, error: 'clock' }
  if (pruneUsed(used, nowMs).some((u) => u.n === f.nonce)) return { ok: false, error: 'used' }
  return { ok: true, kid: f.kid, link: (f.flags & 2) === 2, maxDays: f.maxDays, useByMs: f.useByMs, nonce: f.nonce }
}

/**
 * A code already accepted on this device (the stored unlock), checked again at every start: same format, its key
 * still pinned, signature, flags, device. Not the use-by time nor the used list — this IS that one use.
 */
function storedCodeOk({ bytes, pins, deviceId, verify }) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CODE_BYTES) return false
  const f = codeFields(bytes)
  const pin = f.ver === 1 && Array.isArray(pins) ? pins.find((p) => p && p.kid === f.kid) : null
  return !!pin && signatureOk(verify, pin, bytes) && flagsOk(f.flags) && sameBytes(f.deviceId, deviceId)
}

const usedEntryOk = (u) => !!u && typeof u === 'object' && typeof u.n === 'string' && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(u.n) && Number.isSafeInteger(u.exp)

/** The used-nonce list without expired entries (their codes are refused as expired anyway), at most USED_MAX. */
function pruneUsed(used, nowMs) {
  const list = Array.isArray(used) ? used.filter((u) => usedEntryOk(u) && u.exp >= nowMs) : []
  list.sort((a, b) => b.exp - a.exp)
  return list.slice(0, USED_MAX).map((u) => ({ n: u.n, exp: u.exp }))
}

/** The used list after accepting `nonce` (valid until `expMs`); full → the entry expiring first goes. */
function withUsed(used, nonce, expMs, nowMs) {
  const list = pruneUsed(used, nowMs).filter((u) => u.n !== nonce)
  list.push({ n: nonce, exp: expMs })
  list.sort((a, b) => b.exp - a.exp)
  return list.slice(0, USED_MAX)
}

// ---------------------------------------------------------------------------------------------------------------
// Authenticator (RFC 4226 HOTP / RFC 6238 TOTP)
// ---------------------------------------------------------------------------------------------------------------

/** HOTP value of `counter` (`hmacSha1(key, message) → 20 bytes` injected), `digits` long with leading zeros. */
function hotp(key, counter, hmacSha1, digits = TOTP_DIGITS) {
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = c % 256
    c = Math.floor(c / 256)
  }
  const h = hmacSha1(key, msg)
  const off = h[h.length - 1] & 15
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

const stepOf = (nowMs) => Math.floor(nowMs / 1000 / TOTP_PERIOD_S)

/**
 * A 6-digit code against the device's secret. Order: a step in c-1..c+1 newer than `lastStep` → ok (that step becomes
 * lastStep); a matching step not newer → 'totp-replay' (≤ 1 step behind) or 'totp-old' { minutes } (both: right code,
 * never counted as wrong, never unlocks); a match within ±20 steps only → 'totp-skew' { minutes } (counted as wrong,
 * never unlocks); else 'totp-wrong'. → { ok: true, step } | { ok: false, error, minutes?, counts }
 */
function judgeTotp(o) {
  const { secret, digits, nowMs, lastStep, hmacSha1 } = o && typeof o === 'object' ? o : {}
  if (!(secret instanceof Uint8Array) || typeof digits !== 'string' || !/^\d{6}$/.test(digits) || !Number.isFinite(nowMs)) {
    return { ok: false, error: 'totp-wrong', counts: true }
  }
  const last = Number.isSafeInteger(lastStep) ? lastStep : -1
  const c = stepOf(nowMs)
  let older = null
  for (const d of [0, -1, 1]) {
    const step = c + d
    if (!sameText(hotp(secret, step, hmacSha1), digits)) continue
    if (step > last) return { ok: true, step }
    older = older === null ? step : Math.max(older, step)
  }
  if (older !== null) {
    const behind = last - older
    return behind <= 1 ? { ok: false, error: 'totp-replay', counts: false } : { ok: false, error: 'totp-old', minutes: Math.ceil((behind * TOTP_PERIOD_S) / 60), counts: false }
  }
  for (let k = 2; k <= TOTP_SKEW_STEPS; k++) {
    for (const d of [-k, k]) {
      if (sameText(hotp(secret, c + d, hmacSha1), digits)) return { ok: false, error: 'totp-skew', minutes: Math.max(1, Math.round((k * TOTP_PERIOD_S) / 60)), counts: true }
    }
  }
  return { ok: false, error: 'totp-wrong', counts: true }
}

/** "SanoVids · Máy 7KQ2" — the entry's name in the authenticator app (first 4 characters of the device code). */
function totpLabel(deviceCode) {
  return `SanoVids · Máy ${String(deviceCode || '').slice(0, 4)}`
}

/** otpauth:// URI of the Key Uri Format (Google / Microsoft Authenticator): issuer SanoVids, SHA1, 6 digits, 30 s. */
function otpauthUri({ secretB32, deviceCode }) {
  const account = encodeURIComponent(`Máy ${String(deviceCode || '').slice(0, 4)}`)
  return `otpauth://totp/SanoVids:${account}?secret=${secretB32}&issuer=SanoVids&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_S}`
}

/** The secret in groups of 4 for typing it by hand ("Nhập khoá thiết lập"). */
function secretGroups(secretB32) {
  return String(secretB32 || '').match(/.{1,4}/g) || []
}

// ---------------------------------------------------------------------------------------------------------------
// Wrong 6-digit codes
// ---------------------------------------------------------------------------------------------------------------

const failsOf = (f) => (f && Number.isSafeInteger(f.n) && f.n >= 0 && Number.isSafeInteger(f.waitUntil) && f.waitUntil >= 0 ? f : { n: 0, waitUntil: 0 })

/** { waiting, waitUntil } now. */
function failState(fails, nowMs) {
  const f = failsOf(fails)
  return { waiting: f.waitUntil > nowMs, waitUntil: f.waitUntil }
}

/** After a wrong 6-digit code: the 5th wrong one waits 5 min, each next one twice as long, at most 60 min. */
function afterFail(fails, nowMs) {
  const n = failsOf(fails).n + 1
  if (n <= FREE_FAILS) return { n, waitUntil: 0 }
  return { n, waitUntil: nowMs + Math.min(WAIT_MAX_MS, WAIT_BASE_MS * 2 ** (n - FREE_FAILS - 1)) }
}

/** After a right 6-digit code, a confirmed link, or a verified owner-signed code (proof of ownership): no wait. */
function afterSuccess() {
  return { n: 0, waitUntil: 0 }
}

// ---------------------------------------------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------------------------------------------

/**
 * May `op` run in this state? Main checks it before doing anything (the renderer is never trusted).
 * `link` = { open, started, pending } of the link window. → true | an error code (nothing is written then).
 *   getState / lock / linkCancel  always
 *   unlock                        locked → true; build / unlocked → 'not-needed' (the state is returned)
 *   setKeep / totpRemove          unlocked only ('locked' / 'build')
 *   totpBegin                     not build; the link window open ('link-window') and not used yet ('link-used')
 *   totpConfirm                   not build; the window open with a pending secret ('link-window')
 */
function opAllowed(op, o) {
  const { access, link } = o && typeof o === 'object' ? o : {}
  const l = link && typeof link === 'object' ? link : {}
  switch (op) {
    case 'getState':
    case 'lock':
    case 'linkCancel':
      return true
    case 'unlock':
      return access === 'locked' ? true : 'not-needed'
    case 'setKeep':
    case 'totpRemove':
      return access === 'unlocked' ? true : access === 'build' ? 'build' : 'locked'
    case 'totpBegin':
      if (access === 'build') return 'build'
      if (!l.open) return 'link-window'
      return l.started ? 'link-used' : true
    case 'totpConfirm':
      if (access === 'build') return 'build'
      return l.open && l.pending ? true : 'link-window'
    default:
      return 'unknown-op'
  }
}

/** New `until` when "Giữ mở khoá" changes: days 0 = none (refused with a code's max days: 'cap'); never past capUntil. */
function keepUntil({ nowMs, days, capUntil }) {
  if (!KEEP_DAYS.includes(days)) return { ok: false, error: 'bad-days' }
  const cap = Number.isSafeInteger(capUntil) ? capUntil : null
  if (days === 0) return cap === null ? { ok: true, until: null } : { ok: false, error: 'cap' }
  const until = nowMs + days * DAY_MS
  return { ok: true, until: cap === null ? until : Math.min(until, cap) }
}

/** Unlock window of an accepted code: the device's keepDays (0 = no end) bounded by the code's max days. */
function unlockTimes({ nowMs, keepDays, maxDays }) {
  const capUntil = maxDays > 0 ? nowMs + maxDays * DAY_MS : null
  const keep = keepDays > 0 ? nowMs + keepDays * DAY_MS : null
  const until = keep === null ? capUntil : capUntil === null ? keep : Math.min(keep, capUntil)
  return { until, capUntil }
}

/**
 * Access now. 'build' always wins; otherwise the stored unlock, unless the clock went back > 5 min before it
 * ('clock-back'), it ran out ('expired') or — for a code unlock — that code no longer verifies ('key-removed': its key
 * was dropped from the pins, the file was edited). → { access, until, capUntil, method, reason }
 */
function accessOf(o) {
  const { buildOpen, record, nowMs, pins, verify, deviceId } = o && typeof o === 'object' ? o : {}
  const locked = (reason) => ({ access: 'locked', until: null, capUntil: null, method: null, reason })
  if (buildOpen === true) return { access: 'build', until: null, capUntil: null, method: null, reason: null }
  const u = record && record.unlock
  if (!u) return locked(null)
  if (!Number.isFinite(nowMs) || nowMs < u.at - CLOCK_BACK_MS) return locked('clock-back')
  if (u.until !== null && nowMs >= u.until) return locked('expired')
  if (u.capUntil !== null && nowMs >= u.capUntil) return locked('expired')
  if (u.method === 'code') {
    const c = classifyInput(u.code || '')
    if (c.kind !== 'signed' || !storedCodeOk({ bytes: c.bytes, pins, deviceId, verify })) return locked('key-removed')
  }
  return { access: 'unlocked', until: u.until, capUntil: u.capUntil, method: u.method, reason: null }
}

/** Packaged builds open from source / a test build exactly where DevTools are allowed, unless a test build bakes the lock. */
function devOpenBuild({ devToolsAllowed, testDevLock }) {
  return devToolsAllowed === true && testDevLock !== true
}

// ---------------------------------------------------------------------------------------------------------------
// The record (userData/dev-access.json)
// ---------------------------------------------------------------------------------------------------------------

const intOrNull = (v) => v === null || Number.isSafeInteger(v)

function parseUnlock(u) {
  if (u === null || u === undefined) return null
  if (!u || typeof u !== 'object' || Array.isArray(u)) return undefined
  if (!['code', 'totp', 'email'].includes(u.method) || !Number.isSafeInteger(u.at) || !intOrNull(u.until) || !intOrNull(u.capUntil)) return undefined
  if (u.method === 'code' && (typeof u.code !== 'string' || u.code.length > MAX_INPUT)) return undefined
  const out = { method: u.method, at: u.at, until: u.until, capUntil: u.capUntil }
  if (u.method === 'code') out.code = u.code
  return out
}

function parseTotp(t) {
  if (t === null || t === undefined) return null
  if (!t || typeof t !== 'object' || Array.isArray(t)) return undefined
  if (!Number.isSafeInteger(t.lastStep) || t.lastStep < -1 || !Number.isSafeInteger(t.linkedAt)) return undefined
  if (t.wrap === 'none') {
    const s = base32Decode(t.secret)
    return s && s.length === 20 ? { wrap: 'none', secret: t.secret, lastStep: t.lastStep, linkedAt: t.linkedAt } : undefined
  }
  if (t.wrap === 'dpapi') {
    return typeof t.secretEnc === 'string' && t.secretEnc.length > 0 && t.secretEnc.length <= 4096 && /^[A-Za-z0-9+/]+=*$/.test(t.secretEnc)
      ? { wrap: 'dpapi', secretEnc: t.secretEnc, lastStep: t.lastStep, linkedAt: t.linkedAt }
      : undefined
  }
  return undefined
}

/** A new record (no unlock, no link). */
function newRecord(deviceB64url) {
  return { v: 1, device: deviceB64url, keepDays: DEFAULT_KEEP_DAYS, unlock: null, used: [], totp: null, fails: { n: 0, waitUntil: 0 } }
}

/** userData/dev-access.json (text or object) → record, or null for anything malformed (never throws). */
function parseRecord(input) {
  let r = input
  if (typeof input === 'string') {
    try {
      r = JSON.parse(input)
    } catch {
      return null
    }
  }
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.v !== 1) return null
  const device = b64urlDecode(r.device)
  if (!device || device.length !== 32 || typeof r.device !== 'string' || r.device.length !== 43) return null
  if (!KEEP_DAYS.includes(r.keepDays)) return null
  const unlock = parseUnlock(r.unlock)
  const totp = parseTotp(r.totp)
  if (unlock === undefined || totp === undefined) return null
  if (!Array.isArray(r.used) || r.used.length > USED_MAX || !r.used.every(usedEntryOk)) return null
  const fails = r.fails
  if (!fails || typeof fails !== 'object' || !Number.isSafeInteger(fails.n) || fails.n < 0 || !Number.isSafeInteger(fails.waitUntil) || fails.waitUntil < 0) return null
  return { v: 1, device: r.device, keepDays: r.keepDays, unlock, used: r.used.map((u) => ({ n: u.n, exp: u.exp })), totp, fails: { n: fails.n, waitUntil: fails.waitUntil } }
}

/** The record as written (known fields only). */
function serializeRecord(rec) {
  return JSON.stringify(
    {
      v: 1,
      device: rec.device,
      keepDays: rec.keepDays,
      unlock: rec.unlock,
      used: rec.used,
      totp: rec.totp,
      fails: rec.fails,
    },
    null,
    2,
  )
}

/**
 * The state the page sees (IPC devAccess:getState / push devAccess:state). Never a secret: no TOTP secret, no stored
 * code, no nonce, no device secret — only the device CODE people read anyway.
 */
function stateView({ acc, record, link, persist, totpLost, nowMs, deviceCode }) {
  const rec = record || null
  const linked = !!(rec && rec.totp)
  const fails = failsOf(rec && rec.fails)
  const open = !!(link && link.until > nowMs)
  return {
    access: acc.access,
    until: acc.access === 'unlocked' ? acc.until : null,
    capUntil: acc.access === 'unlocked' ? acc.capUntil : null,
    method: acc.access === 'unlocked' ? acc.method : null,
    keepDays: rec && KEEP_DAYS.includes(rec.keepDays) ? rec.keepDays : DEFAULT_KEEP_DAYS,
    deviceCode: typeof deviceCode === 'string' ? deviceCode : '',
    totp: { linked: linked && !totpLost, label: linked ? totpLabel(deviceCode) : null, lost: linked && !!totpLost },
    linkUntil: open ? link.until : null,
    linkStarted: open && !!link.started,
    waitUntil: fails.waitUntil > nowMs ? fails.waitUntil : null,
    persist: persist !== false,
    email: false,
  }
}

module.exports = {
  KEEP_DAYS,
  DEFAULT_KEEP_DAYS,
  CODE_PREFIX,
  SIGN_CONTEXT,
  DEVICE_CONTEXT,
  EPOCH_MS,
  HOUR_MS,
  DAY_MS,
  CODE_BYTES,
  CODE_CHARS,
  PAYLOAD_BYTES,
  MAX_INPUT,
  USED_MAX,
  LINK_WINDOW_MS,
  CLOCK_BACK_MS,
  MAX_USEBY_AHEAD_MS,
  CODE_HOURS,
  TOTP_PERIOD_S,
  TOTP_DIGITS,
  TOTP_SKEW_STEPS,
  FREE_FAILS,
  WAIT_BASE_MS,
  WAIT_MAX_MS,
  MIN_ATTEMPT_GAP_MS,
  RFC8032_TEST_KEYS,
  crockfordEncode,
  crockfordDecode,
  normalizeCrockford,
  base32Encode,
  base32Decode,
  b64urlEncode,
  b64urlDecode,
  deviceIdOf,
  deviceCodeOf,
  deviceCodeText,
  parseDeviceCode,
  classifyInput,
  buildPayload,
  signedMessage,
  formatCode,
  useByHoursOf,
  parseDevUnlockPins,
  pinProblems,
  pinCheckCode,
  judgeSignedCode,
  storedCodeOk,
  pruneUsed,
  withUsed,
  hotp,
  stepOf,
  judgeTotp,
  totpLabel,
  otpauthUri,
  secretGroups,
  failState,
  afterFail,
  afterSuccess,
  opAllowed,
  keepUntil,
  unlockTimes,
  accessOf,
  devOpenBuild,
  newRecord,
  parseRecord,
  serializeRecord,
  stateView,
}

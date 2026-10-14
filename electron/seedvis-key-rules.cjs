// seedvis.com API key store — the pure rules and the injected state machine of electron/seedvis.cjs (seedvis plan
// v3.1 §10.3, §15 S1–S3, S15–S18). Same style as ./keeplogin-rules.cjs (async safeStorage, atomic writes, a chain
// with a cap so "Xoá key" never hangs behind a Keychain prompt, a .forget marker when a file cannot be deleted).
//
// Files in userData (never anywhere else):
//   seedvis-key.bin        safeStorage-encrypted JSON { v: 1, key, savedAt, verifiedAt } (DPAPI on Windows, the
//                          Keychain on macOS). Written as .tmp then renamed. Never plaintext: when encryption is
//                          unavailable (or Linux's plain-text backend) nothing is saved.
//   seedvis-key.json       plain sidecar { v: 1, hint (last 4 characters), tag, savedAt, verifiedAt } so the status shows
//                          without decrypting. tag = the first 12 hex of HMAC-SHA256(installSalt, key): stable for the
//                          same key on this install (jobs remember the key they were sent with), useless to test a
//                          leaked candidate key without the salt — never a bare hash of the key.
//   seedvis-key.salt       32 random bytes, created once per profile, kept by "Xoá key" (same key → same tag).
//   seedvis-key.bin.forget "Xoá key" could not delete the key file now: it is deleted unread at the next use / start.
//
// The key itself only lives in this object's memory once decrypted (and in seedvis.cjs for the request being sent).
// No method returns it except getKey() (main-internal); status() never carries it. Never logs.
//
// No require (seedvis.cjs and the tests share it), no Electron, no fs, no crypto: everything is injected.
'use strict'

const SEEDVIS_KEY_FILE = 'seedvis-key.bin'
const SEEDVIS_KEY_META_FILE = 'seedvis-key.json'
const SEEDVIS_KEY_SALT_FILE = 'seedvis-key.salt'
/** A key file larger than this (or an empty one) is deleted without being decrypted. */
const SEEDVIS_KEY_MAX_FILE_BYTES = 16 * 1024
/** Xoá key waits at most this long for a save / read in progress (e.g. a Keychain prompt on macOS). */
const SEEDVIS_KEY_CHAIN_CAP_MS = 5000
/** A seedvis key: 20–200 characters of [A-Za-z0-9_-]. The sv_live_ prefix seen in one example is only a hint. */
const SEEDVIS_KEY_RE = /^[A-Za-z0-9_-]{20,200}$/
/** Clipboard / field text longer than this is never a key (not even trimmed or scanned). */
const SEEDVIS_KEY_INPUT_MAX = 1000
const SEEDVIS_SALT_BYTES = 32
const SEEDVIS_TAG_HEX = 12
const TAG_RE = /^[0-9a-f]{12}$/
const HINT_RE = /^[A-Za-z0-9_-]{4}$/
/** "Lưu mà chưa kiểm tra" stays possible this long after the candidate's check failed with a network error. */
const SEEDVIS_UNVERIFIED_OFFER_MS = 2 * 60 * 1000

const SEEDVIS_KEY_TEXTS = Object.freeze({
  noKey: 'Chưa nhập API key seedvis — mở Cài đặt › seedvis.com.',
  badClipboard:
    'Clipboard không có API key seedvis hợp lệ (20–200 ký tự: chữ, số, “-” hoặc “_”; key seedvis thường bắt đầu bằng sv_live_). Sao chép key trên seedvis.com rồi bấm “Dán key” lại.',
  badFormat: 'API key seedvis không hợp lệ (20–200 ký tự: chữ, số, “-” hoặc “_”; key seedvis thường bắt đầu bằng sv_live_).',
  wrongKey: 'API key không đúng (seedvis từ chối key này) — chưa lưu.',
  noApi: 'Gói seedvis hoặc key này không có quyền dùng API — chưa lưu.',
  verifyNetwork: 'Không kiểm tra được key vì lỗi mạng — chưa lưu. Nếu bạn chắc key đúng, bấm “Lưu mà chưa kiểm tra”.',
  verifyBusy: 'seedvis đang bận nên chưa kiểm tra được key — chưa lưu. Thử lại sau, hoặc bấm “Lưu mà chưa kiểm tra”.',
  verifyOdd: 'seedvis trả lời lạ khi kiểm tra key — chưa lưu. Thử lại sau.',
  unverifiedRefused:
    '“Lưu mà chưa kiểm tra” chỉ dùng được cho đúng key vừa bị lỗi mạng khi kiểm tra, trong vòng 2 phút — chưa lưu. Dán hoặc nhập lại key để SanoVids kiểm tra.',
  keyChanged: 'API key seedvis vừa được xoá hoặc thay trong lúc cảnh chờ gửi — chưa gửi gì, không bị trừ credit. Chạy lại cảnh để gửi bằng key hiện tại.',
  saveFailed: 'Không ghi được key vào máy (lỗi ghi tệp) — chưa lưu. Thử lại.',
  superseded: 'Key vừa được xoá hoặc thay trong lúc lưu — chưa lưu key này.',
  notCleared:
    'Đã xoá key khỏi SanoVids cho lần chạy này, nhưng tệp key (đã mã hoá) chưa xoá được ngay — SanoVids sẽ xoá nó ở lần dùng sau và không dùng lại.',
})

/** "Mã hoá không dùng được": nothing is ever saved in plaintext. */
function keyUnavailableText(platform) {
  if (platform === 'linux') return 'Máy này không có kho khoá mã hoá (chỉ có kiểu lưu văn bản thường) — SanoVids không lưu API key seedvis dạng không mã hoá.'
  if (platform === 'darwin') return 'Keychain đang không cho SanoVids mã hoá — chưa lưu API key seedvis. Thử lại; SanoVids không bao giờ lưu key dạng không mã hoá.'
  return 'Windows đang không cho SanoVids mã hoá — chưa lưu API key seedvis. SanoVids không bao giờ lưu key dạng không mã hoá.'
}

/**
 * The saved key cannot be decrypted here. Placement-aware: a copied profile / Portable copy on Windows; on macOS the
 * Keychain refusing a new (ad-hoc signed) build, or an app not running from Applications. "Xoá key" always works.
 */
function keyUnreadableText(platform, placement) {
  if (platform === 'darwin') {
    const outside = typeof placement === 'string' && placement !== 'mac-applications' && placement !== 'dev' && placement !== 'unknown'
    return (
      'Khoá API seedvis đã lưu không đọc được: Keychain không cho bản SanoVids này đọc (thường gặp sau khi cập nhật bản Mac chưa ký chính thức' +
      (outside ? ', hoặc khi SanoVids không chạy từ thư mục Applications' : '') +
      '). Bấm “Xoá key” rồi dán lại key.'
    )
  }
  if (platform === 'win32') {
    const copy = placement === 'portable' || placement === 'temp-copy'
    return (
      'Khoá API seedvis đã lưu không đọc được trên máy / tài khoản Windows này' +
      (copy ? ' (bản Portable không mang key sang máy hay tài khoản khác)' : ' (có thể thư mục dữ liệu được chép từ máy khác)') +
      '. Bấm “Xoá key” rồi dán lại key.'
    )
  }
  return 'Khoá API seedvis đã lưu không đọc được trên máy / tài khoản này. Bấm “Xoá key” rồi dán lại key.'
}

// ---------------------------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------------------------

/** Lenient format check (S18): 20–200 characters of [A-Za-z0-9_-], no whitespace inside. No prefix is required. */
function keyFormatOk(text) {
  return typeof text === 'string' && SEEDVIS_KEY_RE.test(text)
}

/**
 * Prefixes of other services' secrets (GitHub, OpenAI / Anthropic, Stripe, AWS, Slack, Google, GitLab, Hugging Face,
 * npm): such text is never sent to seedvis to be checked as a Bearer key ("Dán key" reads whatever the clipboard holds).
 */
const FOREIGN_SECRET_RE = /^(?:gh[pousr]_|github_pat_|sk[-_]|[rp]k_(?:live|test)_|AKIA|ASIA|xox[abposr]-|AIza|glpat-|hf_|npm_)/

/**
 * Pasted / typed text → the key (outer whitespace trimmed) or null. Text over 1000 characters is refused untouched, and
 * so is another service's secret (FOREIGN_SECRET_RE).
 */
function normalizeKeyInput(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > SEEDVIS_KEY_INPUT_MAX) return null
  const t = raw.trim()
  return keyFormatOk(t) && !FOREIGN_SECRET_RE.test(t) ? t : null
}

/** The last 4 characters ("…AB12" in the UI). */
function keyHint(key) {
  return keyFormatOk(key) ? key.slice(-4) : null
}

/** First 12 hex of HMAC-SHA256(salt, key) (hmacHex injected: node:crypto in main), or null. */
function keyTag(salt, key, hmacHex) {
  if (!validSalt(salt) || !keyFormatOk(key) || typeof hmacHex !== 'function') return null
  let hex
  try {
    hex = String(hmacHex(salt, key)).toLowerCase()
  } catch {
    return null
  }
  const tag = hex.slice(0, SEEDVIS_TAG_HEX)
  return TAG_RE.test(tag) ? tag : null
}

function validSalt(bytes) {
  return bytes instanceof Uint8Array && bytes.byteLength === SEEDVIS_SALT_BYTES
}

const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

/** seedvis-key.json text → { hint, tag, savedAt, verifiedAt } or null (anything odd = no sidecar). */
function parseKeyMeta(text) {
  let p
  try {
    p = JSON.parse(String(text))
  } catch {
    return null
  }
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.v !== 1) return null
  if (typeof p.hint !== 'string' || !HINT_RE.test(p.hint)) return null
  const tag = typeof p.tag === 'string' && TAG_RE.test(p.tag) ? p.tag : null
  const savedAt = finiteOrNull(p.savedAt)
  if (savedAt === null) return null
  return { hint: p.hint, tag, savedAt, verifiedAt: finiteOrNull(p.verifiedAt) }
}

/** The sidecar: exactly these four fields, never the key. */
function keyMetaText(meta) {
  return JSON.stringify({ v: 1, hint: meta.hint, tag: meta.tag || null, savedAt: meta.savedAt, verifiedAt: meta.verifiedAt || null }) + '\n'
}

/** Decrypted text → { key, savedAt, verifiedAt } or null. */
function parseKeyPayload(text) {
  let p
  try {
    p = JSON.parse(String(text))
  } catch {
    return null
  }
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.v !== 1 || !keyFormatOk(p.key)) return null
  const savedAt = finiteOrNull(p.savedAt)
  if (savedAt === null) return null
  return { key: p.key, savedAt, verifiedAt: finiteOrNull(p.verifiedAt) }
}

function keyPayloadText(p) {
  return JSON.stringify({ v: 1, key: p.key, savedAt: p.savedAt, verifiedAt: p.verifiedAt || null })
}

/** The IPC status (contract SeedvisKeyStatus) — never the key. */
function keyStatusPayload(s) {
  const has = s.hasKey === true
  const m = has && s.meta ? s.meta : null
  const out = {
    hasKey: has,
    hint: m ? m.hint : null,
    tag: m && m.tag ? m.tag : null,
    savedAt: m ? m.savedAt : null,
    verifiedAt: m && m.verifiedAt ? m.verifiedAt : null,
    storage: s.storage === 'unavailable' ? 'unavailable' : 'safeStorage',
  }
  if (s.problem === 'unknown' || s.problem === 'unreadable') out.problem = s.problem
  return out
}

/**
 * "Lưu mà chưa kiểm tra" (plan §10.3) is offered only for the candidate whose key check just failed with a network
 * error — never for whatever the clipboard / field holds later (another service's token would be saved and sent to
 * seedvis as a Bearer key). Main remembers a keyed digest of that one candidate (never the key) for
 * SEEDVIS_UNVERIFIED_OFFER_MS. deps: { now, digest(candidate) → string (main: HMAC with a per-run random key) }
 *   offer(candidate)   its check failed with code 'network' (replaces any earlier offer)
 *   allows(candidate)  → may it be saved without a check now?
 *   clear()            any other check outcome, a save, Xoá key
 */
function createUnverifiedOffer(deps) {
  const now = deps.now
  let held = null // { digest, at }
  const digestOf = (candidate) => {
    if (!keyFormatOk(candidate)) return null
    try {
      const d = deps.digest(candidate)
      return typeof d === 'string' && d.length >= 32 ? d : null
    } catch {
      return null
    }
  }
  return {
    offer(candidate) {
      const d = digestOf(candidate)
      held = d ? { digest: d, at: now() } : null
    },
    allows(candidate) {
      if (!held) return false
      const age = now() - held.at
      if (!(age >= 0 && age <= SEEDVIS_UNVERIFIED_OFFER_MS)) {
        held = null
        return false
      }
      const d = digestOf(candidate)
      return d !== null && d === held.digest
    },
    clear() {
      held = null
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The key store
// ---------------------------------------------------------------------------------------------------------------

/**
 * deps: {
 *   crypto   safeStorage-like: isEncryptionAvailable() → boolean | Promise<boolean> (false for Linux basic_text),
 *            encryptStringAsync(text) → bytes, decryptStringAsync(bytes) → { result, shouldReEncrypt },
 *   fsp      fs.promises-like: readFile, writeFile, rm, stat;   rename(from, to) (default fsp.rename),
 *   dir, join (path.join), now, sleep(ms), randomBytes(n) → Uint8Array, hmacHex(salt, text) → hex,
 *   platform, placement() → kind (texts only), capMs = SEEDVIS_KEY_CHAIN_CAP_MS
 * }
 *   start()        once on ready: reads the sidecar and stats the key file (never safeStorage, never the key).
 *   status()       → SeedvisKeyStatus ('unknown' until start() ran or while the key was not decrypted yet).
 *   getKey()       → { ok: true, key, tag, hint } | { ok: false, code: 'no-key' | 'key-unreadable', message }.
 *                    Decrypts lazily once (a Keychain prompt waits for the user); 'unreadable' sticks until a new
 *                    key is saved or the key is cleared. A clear / save while it awaits → 'no-key', nothing written.
 *                    ok only with a well-formed key.
 *   holds(key)     → is this still the key in use (not cleared / replaced since)? Synchronous.
 *   save(key, { verifiedAt }) → { ok: true, status } | { ok: false, code: 'bad-key' | 'storage-unavailable' |
 *                    'storage-failed', message }
 *   clear()        → { ok: true, status } | { ok: false, code: 'storage-failed', message } (the key is gone from memory
 *                    at once either way; a file that could not be deleted gets the .forget marker). Never waits more
 *                    than capMs.
 *   markVerified(tag, at)   a later successful check of the same key (sidecar only).
 * Every file operation is serialized on one chain; never throws; never logs.
 */
function createSeedvisKeyStore(deps) {
  const { crypto, fsp, dir, join, now, sleep, randomBytes, hmacHex } = deps
  const rename = deps.rename || ((from, to) => fsp.rename(from, to))
  const capMs = deps.capMs || SEEDVIS_KEY_CHAIN_CAP_MS
  const platform = deps.platform || 'win32'
  const placement = () => {
    try {
      return typeof deps.placement === 'function' ? deps.placement() : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  const file = join(dir, SEEDVIS_KEY_FILE)
  const metaFile = join(dir, SEEDVIS_KEY_META_FILE)
  const saltFile = join(dir, SEEDVIS_KEY_SALT_FILE)
  const marker = file + '.forget'
  const writeOpts = platform === 'win32' ? undefined : { mode: 0o600 }

  let started = false
  let hasFile = false
  let meta = null
  let key = null // decrypted, memory only
  let problem = null // null | 'unknown' (not decrypted yet) | 'unreadable'
  let unavailable = false
  let epoch = 0 // bumped by save / clear: work that started before never writes or adopts a key
  let chain = Promise.resolve()

  /** Runs fn after everything queued before; resolves fn's result, or `fallback` when it threw. */
  const run = (fn, fallback) => {
    const p = chain.then(fn).catch(() => fallback)
    chain = p.then(() => undefined)
    return p
  }
  const capped = (p, fallback) => Promise.race([p, sleep(capMs).then(() => fallback)])
  const fail = (code, message) => ({ ok: false, code, message })
  const unreadable = () => fail('key-unreadable', keyUnreadableText(platform, placement()))

  async function encryption() {
    let ok = false
    try {
      ok = (await crypto.isEncryptionAvailable()) === true
    } catch {
      ok = false
    }
    unavailable = !ok
    return ok
  }

  async function exists(p) {
    try {
      if (typeof fsp.stat === 'function') await fsp.stat(p)
      else await fsp.readFile(p)
      return true
    } catch {
      return false
    }
  }

  const rmQuiet = (p) => Promise.resolve(fsp.rm(p, { force: true })).catch(() => undefined)

  async function writeAtomic(target, data) {
    const tmp = target + '.tmp'
    try {
      await fsp.writeFile(tmp, data, writeOpts)
      await rename(tmp, target)
    } catch (e) {
      await rmQuiet(tmp)
      throw e
    }
  }

  /** Deletes the key file and the sidecar (the salt stays). Windows may hold a file a moment: retried, then emptied. → gone? */
  async function dropAll() {
    let gone = false
    for (const wait of [0, 150, 600]) {
      if (wait) await sleep(wait)
      try {
        await fsp.rm(file, { force: true })
        gone = true
        break
      } catch {
        gone = false
      }
    }
    if (!gone) {
      try {
        await fsp.writeFile(file, new Uint8Array(0)) // an empty key file is deleted unread at the next use
        gone = true
      } catch {
        /* still there */
      }
    }
    await rmQuiet(file + '.tmp')
    await rmQuiet(metaFile)
    await rmQuiet(metaFile + '.tmp')
    if (gone) {
      await rmQuiet(marker)
      return true
    }
    await Promise.resolve(fsp.writeFile(marker, new Uint8Array(0))).catch(() => undefined)
    return false
  }

  async function readSalt(create) {
    try {
      const b = await fsp.readFile(saltFile)
      const u = b instanceof Uint8Array ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null
      if (validSalt(u)) return u
    } catch {
      /* none yet */
    }
    if (!create) return null
    const fresh = randomBytes(SEEDVIS_SALT_BYTES)
    const salt = fresh instanceof Uint8Array ? new Uint8Array(fresh.buffer, fresh.byteOffset, fresh.byteLength) : null
    if (!validSalt(salt)) return null
    try {
      await writeAtomic(saltFile, salt)
      return salt
    } catch {
      return null
    }
  }

  async function writeMeta(m) {
    try {
      await writeAtomic(metaFile, keyMetaText(m))
    } catch {
      /* the status still works from memory; the sidecar is rebuilt at the next decrypt */
    }
  }

  async function startNow() {
    if (await exists(marker)) {
      await dropAll()
      hasFile = false
      meta = null
      problem = null
      return
    }
    let st = null
    try {
      st = typeof fsp.stat === 'function' ? await fsp.stat(file) : { size: (await fsp.readFile(file)).byteLength }
    } catch {
      st = null
    }
    if (!st) {
      hasFile = false
      meta = null
      problem = null
      await rmQuiet(metaFile) // a sidecar without its key says nothing
      return
    }
    const size = Number.isFinite(st.size) ? st.size : -1
    if (size <= 0 || size > SEEDVIS_KEY_MAX_FILE_BYTES) {
      await dropAll()
      hasFile = false
      meta = null
      problem = null
      return
    }
    hasFile = true
    try {
      meta = parseKeyMeta(await fsp.readFile(metaFile, 'utf8'))
    } catch {
      meta = null
    }
    problem = 'unknown'
  }

  /** The key in memory as getKey's answer; never ok without a well-formed key. */
  const keyAnswer = (k) => (keyFormatOk(k) ? { ok: true, key: k, tag: meta ? meta.tag : null, hint: keyHint(k) } : fail('no-key', SEEDVIS_KEY_TEXTS.noKey))

  async function getKeyNow() {
    if (key) return keyAnswer(key)
    if (!hasFile) return fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
    if (problem === 'unreadable') return unreadable()
    const at = epoch
    // "Xoá key" / a new save while this read awaits: nothing is written or adopted, and nothing is returned
    const moved = () => at !== epoch
    if (await exists(marker)) {
      await dropAll()
      hasFile = false
      meta = null
      problem = null
      return fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
    }
    let bytes
    try {
      bytes = await fsp.readFile(file)
    } catch {
      hasFile = false
      meta = null
      problem = null
      return fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
    }
    if (!bytes || bytes.length === 0 || bytes.length > SEEDVIS_KEY_MAX_FILE_BYTES) {
      await dropAll()
      hasFile = false
      meta = null
      problem = null
      return fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
    }
    if (!(await encryption())) {
      if (at === epoch) problem = 'unreadable'
      return unreadable()
    }
    let payload = null
    let reEncrypt = false
    try {
      const out = await crypto.decryptStringAsync(bytes)
      payload = parseKeyPayload(out && out.result)
      reEncrypt = !!out && out.shouldReEncrypt === true
    } catch {
      payload = null // another Windows account / a reset Local State / a damaged file / a refused Keychain prompt
    }
    if (moved()) return fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
    if (!payload) {
      problem = 'unreadable'
      return unreadable()
    }
    const decrypted = payload.key // held locally until adopted (only while the epoch is unchanged)
    const hint = keyHint(decrypted)
    const salt = await readSalt(true)
    if (moved()) return fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
    key = decrypted
    problem = null
    const tag = salt ? keyTag(salt, decrypted, hmacHex) : meta && meta.hint === hint ? meta.tag : null
    if (!meta || meta.hint !== hint || meta.tag !== tag) {
      meta = { hint, tag, savedAt: payload.savedAt, verifiedAt: Math.max(payload.verifiedAt || 0, (meta && meta.hint === hint && meta.verifiedAt) || 0) || null }
      await writeMeta(meta)
      if (moved()) return fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
    }
    if (reEncrypt) {
      // the same payload under the new encryption key (not a new save: savedAt unchanged)
      try {
        const fresh = await crypto.encryptStringAsync(keyPayloadText(payload))
        if (!moved()) await writeAtomic(file, fresh)
      } catch {
        /* the old file still decrypts */
      }
      if (moved()) return fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
    }
    return key === decrypted ? keyAnswer(decrypted) : fail('no-key', SEEDVIS_KEY_TEXTS.noKey)
  }

  async function saveNow(candidate, opts, at) {
    const k = normalizeKeyInput(candidate)
    if (!k) return fail('bad-key', SEEDVIS_KEY_TEXTS.badFormat)
    if (!(await encryption())) return fail('storage-unavailable', keyUnavailableText(platform))
    const salt = await readSalt(true)
    if (!salt) return fail('storage-failed', SEEDVIS_KEY_TEXTS.saveFailed)
    const tag = keyTag(salt, k, hmacHex)
    const savedAt = now()
    const verifiedAt = opts && finiteOrNull(opts.verifiedAt)
    let bytes
    try {
      bytes = await crypto.encryptStringAsync(keyPayloadText({ key: k, savedAt, verifiedAt }))
    } catch {
      unavailable = true
      return fail('storage-unavailable', keyUnavailableText(platform))
    }
    if (at !== epoch) return fail('storage-failed', SEEDVIS_KEY_TEXTS.superseded)
    const tmp = file + '.tmp'
    try {
      await fsp.writeFile(tmp, bytes, writeOpts)
      if (at !== epoch) {
        await rmQuiet(tmp)
        return fail('storage-failed', SEEDVIS_KEY_TEXTS.superseded)
      }
      await rename(tmp, file)
    } catch {
      await rmQuiet(tmp)
      return fail('storage-failed', SEEDVIS_KEY_TEXTS.saveFailed)
    }
    // cleared / replaced while renaming: never adopted (clear()'s drop, queued after this save, deletes the file)
    if (at !== epoch) return fail('storage-failed', SEEDVIS_KEY_TEXTS.superseded)
    meta = { hint: keyHint(k), tag, savedAt, verifiedAt: verifiedAt || null }
    await writeMeta(meta)
    await rmQuiet(marker)
    hasFile = true
    key = k
    problem = null
    return { ok: true, status: status() }
  }

  function status() {
    return keyStatusPayload({ hasKey: hasFile, meta, storage: unavailable ? 'unavailable' : 'safeStorage', problem: started ? problem : 'unknown' })
  }

  return {
    start() {
      return run(async () => {
        await startNow()
        started = true
      }, undefined).then(() => {
        started = true
      })
    },
    status,
    getKey() {
      return run(getKeyNow, fail('key-unreadable', keyUnreadableText(platform, placement())))
    },
    /**
     * Is `candidate` (a getKey() answer) still the key in use — not cleared ("Xoá key") or replaced since? Checked
     * right before a request leaves (a submit may wait minutes for a slot). Synchronous; never returns the key.
     */
    holds(candidate) {
      return key !== null && keyFormatOk(candidate) && candidate === key
    },
    save(candidate, opts) {
      const at = ++epoch
      return run(() => saveNow(candidate, opts, at), fail('storage-failed', SEEDVIS_KEY_TEXTS.saveFailed))
    },
    async clear() {
      epoch++
      key = null
      meta = null
      hasFile = false
      problem = null
      const gone = await capped(run(dropAll, false), false)
      if (gone === true) return { ok: true, status: status() }
      // queued behind a slow save / read (a Keychain prompt), or the file is locked: never used again
      await Promise.resolve(fsp.writeFile(marker, new Uint8Array(0))).catch(() => undefined)
      return fail('storage-failed', SEEDVIS_KEY_TEXTS.notCleared)
    },
    markVerified(tag, at) {
      return run(async () => {
        if (!meta || !tag || meta.tag !== tag || !key) return
        const t = finiteOrNull(at)
        if (t === null) return
        meta = Object.assign({}, meta, { verifiedAt: t })
        await writeMeta(meta)
      }, undefined)
    },
  }
}

module.exports = {
  SEEDVIS_KEY_FILE,
  SEEDVIS_KEY_META_FILE,
  SEEDVIS_KEY_SALT_FILE,
  SEEDVIS_KEY_MAX_FILE_BYTES,
  SEEDVIS_KEY_CHAIN_CAP_MS,
  SEEDVIS_KEY_RE,
  SEEDVIS_KEY_INPUT_MAX,
  SEEDVIS_SALT_BYTES,
  SEEDVIS_TAG_HEX,
  SEEDVIS_UNVERIFIED_OFFER_MS,
  SEEDVIS_KEY_TEXTS,
  keyUnavailableText,
  keyUnreadableText,
  keyFormatOk,
  normalizeKeyInput,
  keyHint,
  keyTag,
  validSalt,
  parseKeyMeta,
  keyMetaText,
  parseKeyPayload,
  keyPayloadText,
  keyStatusPayload,
  createUnverifiedOffer,
  createSeedvisKeyStore,
}

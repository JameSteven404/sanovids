// The seedvis API key store: electron/seedvis-key-rules.cjs (pure rules + the injected store, run on an in-memory fs
// with a fake reversible safeStorage) and its use by electron/seedvis.cjs ("Dán key" reads the clipboard in main, the
// key check, "Lưu mà chưa kiểm tra", Xoá key) through the fake Electron. The key never leaves main: no IPC answer and
// no log line ever contains it, and no file holds it in plaintext. Only fake keys; userData is a fresh temp folder.
import { createHash, createHmac } from 'node:crypto'
import { existsSync, promises as fsPromises, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Any, type Harness, FAKE_KEY, FakeSafeStorage, OTHER_KEY, UUID, accountInfo, completed, createReq, harness, jsonAnswer, keyRules, queued202, saveKeyUnverified, settle } from './fakeElectron'

const hmacHex = (salt: Uint8Array, text: string) => createHmac('sha256', salt).update(text, 'utf8').digest('hex')

describe('key rules (pure)', () => {
  it('keyFormatOk is lenient: 20–200 of [A-Za-z0-9_-]; no prefix required; whitespace inside refused', () => {
    expect(keyRules.keyFormatOk(FAKE_KEY)).toBe(true)
    expect(keyRules.keyFormatOk('a'.repeat(20))).toBe(true)
    expect(keyRules.keyFormatOk('Z9_-'.repeat(50))).toBe(true) // 200, no sv_ prefix
    for (const bad of ['a'.repeat(19), 'a'.repeat(201), 'sv_live_abc def ghi jkl mno', 'sv_live_abcdefghijklmnopq\n', 'sv_live_ábcdefghijklmnopqrs', 'sv.live.abcdefghijklmnopqrs', '', 5, null]) {
      expect(keyRules.keyFormatOk(bad), String(bad)).toBe(false)
    }
  })

  it('normalizeKeyInput trims the outside only, and never looks into text longer than 1000 characters', () => {
    expect(keyRules.normalizeKeyInput(`  ${FAKE_KEY}\r\n`)).toBe(FAKE_KEY)
    expect(keyRules.normalizeKeyInput(`key: ${FAKE_KEY}`)).toBeNull()
    expect(keyRules.normalizeKeyInput(`${FAKE_KEY}${' '.repeat(1000)}`)).toBeNull()
    expect(keyRules.normalizeKeyInput('')).toBeNull()
    expect(keyRules.normalizeKeyInput(undefined)).toBeNull()
  })

  it("normalizeKeyInput refuses another service's secret (never sent to seedvis as a Bearer key to check it)", () => {
    const tail = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    for (const prefix of ['ghp_', 'github_pat_', 'gho_', 'sk-', 'sk-proj-', 'sk-ant-', 'sk_live_', 'rk_test_', 'AKIA', 'xoxb-', 'AIza', 'glpat-', 'hf_', 'npm_']) {
      expect(keyRules.normalizeKeyInput(`${prefix}${tail}`)).toBeNull()
    }
    expect(keyRules.normalizeKeyInput(` ${FAKE_KEY} `)).toBe(FAKE_KEY)
    expect(keyRules.normalizeKeyInput(`sv_test_${tail}`)).toBe(`sv_test_${tail}`)
    expect(keyRules.normalizeKeyInput(tail)).toBe(tail) // no prefix is still accepted (S18)
  })

  it('hint = last 4; tag = first 12 hex of HMAC-SHA256(install salt, key): stable per install, different across installs, never a bare hash', () => {
    expect(keyRules.keyHint(FAKE_KEY)).toBe(FAKE_KEY.slice(-4))
    expect(keyRules.keyHint('short')).toBeNull()
    const s1 = new Uint8Array(32).fill(1)
    const s2 = new Uint8Array(32).fill(2)
    const t1 = keyRules.keyTag(s1, FAKE_KEY, hmacHex)
    expect(t1).toMatch(/^[0-9a-f]{12}$/)
    expect(keyRules.keyTag(s1, FAKE_KEY, hmacHex)).toBe(t1)
    expect(keyRules.keyTag(s2, FAKE_KEY, hmacHex)).not.toBe(t1)
    expect(keyRules.keyTag(s1, OTHER_KEY, hmacHex)).not.toBe(t1)
    expect(t1).not.toBe(createHash('sha256').update(FAKE_KEY).digest('hex').slice(0, 12))
    expect(keyRules.keyTag(new Uint8Array(16), FAKE_KEY, hmacHex)).toBeNull() // a salt must be 32 bytes
    expect(keyRules.keyTag(s1, 'bad', hmacHex)).toBeNull()
  })

  it('the sidecar holds exactly hint / tag / savedAt / verifiedAt; odd files are ignored', () => {
    const meta = { hint: 'x123', tag: 'abcdef012345', savedAt: 1000, verifiedAt: null }
    const text = keyRules.keyMetaText(meta)
    expect(Object.keys(JSON.parse(text))).toEqual(['v', 'hint', 'tag', 'savedAt', 'verifiedAt'])
    expect(keyRules.parseKeyMeta(text)).toEqual(meta)
    for (const bad of ['', '{', '[]', '{"v":2,"hint":"x123","savedAt":1}', '{"v":1,"hint":"toolong","savedAt":1}', '{"v":1,"hint":"x123"}']) expect(keyRules.parseKeyMeta(bad), bad).toBeNull()
    expect(keyRules.parseKeyMeta('{"v":1,"hint":"x123","tag":"NOTHEX","savedAt":5}')).toEqual({ hint: 'x123', tag: null, savedAt: 5, verifiedAt: null })
    expect(keyRules.parseKeyPayload(keyRules.keyPayloadText({ key: FAKE_KEY, savedAt: 9, verifiedAt: 10 }))).toEqual({ key: FAKE_KEY, savedAt: 9, verifiedAt: 10 })
    expect(keyRules.parseKeyPayload('{"v":1,"key":"bad key","savedAt":1}')).toBeNull()
  })

  it('the status never carries the key', () => {
    const st = keyRules.keyStatusPayload({ hasKey: true, meta: { hint: 'x123', tag: 'abcdef012345', savedAt: 1, verifiedAt: 2 }, storage: 'safeStorage', problem: null, key: FAKE_KEY })
    expect(st).toEqual({ hasKey: true, hint: 'x123', tag: 'abcdef012345', savedAt: 1, verifiedAt: 2, storage: 'safeStorage' })
    expect(keyRules.keyStatusPayload({ hasKey: false, meta: null, problem: 'unknown' })).toEqual({ hasKey: false, hint: null, tag: null, savedAt: null, verifiedAt: null, storage: 'safeStorage', problem: 'unknown' })
  })

  it('"Lưu mà chưa kiểm tra" is offered for the one candidate whose check failed on the network, for 2 minutes', () => {
    let t = 1000
    const digests: string[] = []
    const offer = keyRules.createUnverifiedOffer({
      now: () => t,
      digest: (c: string) => {
        digests.push(c)
        return createHmac('sha256', 'per-run').update(c).digest('hex')
      },
    })
    expect(offer.allows(FAKE_KEY)).toBe(false) // nothing failed yet
    offer.offer(FAKE_KEY)
    expect(offer.allows(FAKE_KEY)).toBe(true)
    expect(offer.allows(OTHER_KEY)).toBe(false)
    expect(offer.allows('ghp_' + 'A'.repeat(36))).toBe(false) // another service's token from the clipboard
    expect(offer.allows('not a key')).toBe(false)
    t += keyRules.SEEDVIS_UNVERIFIED_OFFER_MS
    expect(offer.allows(FAKE_KEY)).toBe(true)
    t += 1
    expect(offer.allows(FAKE_KEY)).toBe(false) // expired, and forgotten
    t -= 1
    expect(offer.allows(FAKE_KEY)).toBe(false)
    // a later failure replaces it; clear() forgets it
    offer.offer(FAKE_KEY)
    offer.offer(OTHER_KEY)
    expect(offer.allows(FAKE_KEY)).toBe(false)
    expect(offer.allows(OTHER_KEY)).toBe(true)
    offer.clear()
    expect(offer.allows(OTHER_KEY)).toBe(false)
    // a clock that went backwards never extends it
    offer.offer(FAKE_KEY)
    t -= 5000
    expect(offer.allows(FAKE_KEY)).toBe(false)
    // only well-formed candidates are digested; a failing digest offers nothing
    expect(digests.every((d) => keyRules.keyFormatOk(d))).toBe(true)
    const broken = keyRules.createUnverifiedOffer({ now: () => t, digest: () => { throw new Error('x') } })
    broken.offer(FAKE_KEY)
    expect(broken.allows(FAKE_KEY)).toBe(false)
    expect(keyRules.SEEDVIS_UNVERIFIED_OFFER_MS).toBe(120_000)
  })

  it('placement-aware texts (unreadable / unavailable)', () => {
    expect(keyRules.keyUnreadableText('win32', 'installer')).toContain('Windows')
    expect(keyRules.keyUnreadableText('win32', 'portable')).toContain('Portable')
    expect(keyRules.keyUnreadableText('darwin', 'mac-applications')).toContain('Keychain')
    expect(keyRules.keyUnreadableText('darwin', 'mac-applications')).not.toContain('Applications')
    expect(keyRules.keyUnreadableText('darwin', 'mac-volume')).toContain('thư mục Applications')
    for (const p of ['win32', 'darwin', 'linux']) {
      expect(keyRules.keyUnreadableText(p, 'installer')).toContain('Xoá key')
      expect(keyRules.keyUnavailableText(p)).toContain('không')
    }
    expect(keyRules.keyUnavailableText('linux')).toContain('văn bản thường')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The store on an in-memory fs
// ---------------------------------------------------------------------------------------------------------------

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' })

class MemFs {
  files = new Map<string, Buffer>()
  locked = new Set<string>()
  log: string[] = []
  async readFile(p: string, enc?: string) {
    const b = this.files.get(p)
    if (!b) throw enoent()
    return enc ? b.toString(enc as BufferEncoding) : Buffer.from(b)
  }
  async writeFile(p: string, data: string | Uint8Array) {
    if (this.locked.has(p)) throw eperm()
    this.files.set(p, Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data))
    this.log.push(`write ${p}`)
  }
  async rm(p: string) {
    if (this.locked.has(p)) throw eperm()
    this.files.delete(p)
    this.log.push(`rm ${p}`)
  }
  async rename(a: string, b: string) {
    if (this.locked.has(a) || this.locked.has(b)) throw eperm()
    const d = this.files.get(a)
    if (!d) throw enoent()
    this.files.delete(a)
    this.files.set(b, d)
    this.log.push(`rename ${a} -> ${b}`)
  }
  async stat(p: string) {
    const b = this.files.get(p)
    if (!b) throw enoent()
    return { size: b.byteLength, mtimeMs: 0 }
  }
}

const DIR = '/ud'
const F = { bin: `${DIR}/seedvis-key.bin`, meta: `${DIR}/seedvis-key.json`, salt: `${DIR}/seedvis-key.salt`, forget: `${DIR}/seedvis-key.bin.forget` }

function store(fs: MemFs, safe: FakeSafeStorage, over: Any = {}) {
  let t = 1_000_000
  let salt = 0
  return keyRules.createSeedvisKeyStore({
    crypto: { isEncryptionAvailable: () => safe.isAsyncEncryptionAvailable(), encryptStringAsync: (s: string) => safe.encryptStringAsync(s), decryptStringAsync: (b: Uint8Array) => safe.decryptStringAsync(b) },
    fsp: fs,
    dir: DIR,
    join: (a: string, b: string) => `${a}/${b}`,
    now: () => (t += 1000),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    randomBytes: (n: number) => new Uint8Array(n).fill(++salt),
    hmacHex,
    platform: 'win32',
    placement: () => 'installer',
    ...over,
  })
}

describe('the key store', () => {
  it('before start: unknown (does not block); nothing saved → no key', async () => {
    const s = store(new MemFs(), new FakeSafeStorage())
    expect(s.status()).toMatchObject({ hasKey: false, problem: 'unknown' })
    await s.start()
    expect(s.status()).toEqual({ hasKey: false, hint: null, tag: null, savedAt: null, verifiedAt: null, storage: 'safeStorage' })
    expect(await s.getKey()).toMatchObject({ ok: false, code: 'no-key' })
  })

  it('saves encrypted (tmp + rename), with a plain sidecar of hint / tag only; restart reads the status without decrypting', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    const s = store(fs, safe)
    await s.start()
    const r = await s.save(`  ${FAKE_KEY} `, { verifiedAt: 555 })
    expect(r.ok).toBe(true)
    expect(r.status).toMatchObject({ hasKey: true, hint: FAKE_KEY.slice(-4), verifiedAt: 555, storage: 'safeStorage' })
    expect(r.status.tag).toMatch(/^[0-9a-f]{12}$/)
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY)
    expect(fs.log).toContain(`rename ${F.bin}.tmp -> ${F.bin}`)
    expect(fs.log).toContain(`rename ${F.meta}.tmp -> ${F.meta}`)
    for (const [p, b] of fs.files) expect(b.toString('latin1').includes(FAKE_KEY), p).toBe(false)
    expect(Object.keys(JSON.parse(fs.files.get(F.meta)!.toString()))).toEqual(['v', 'hint', 'tag', 'savedAt', 'verifiedAt'])
    expect(fs.files.get(F.salt)!.byteLength).toBe(32)
    expect(r.status.tag).toBe(keyRules.keyTag(new Uint8Array(fs.files.get(F.salt)!), FAKE_KEY, hmacHex))
    expect(await s.getKey()).toMatchObject({ ok: true, key: FAKE_KEY, tag: r.status.tag })
    // restart
    const decrypts = safe.decryptCalls
    const s2 = store(fs, safe)
    await s2.start()
    expect(s2.status()).toEqual({ ...r.status, problem: 'unknown' })
    expect(safe.decryptCalls).toBe(decrypts)
    expect(await s2.getKey()).toMatchObject({ ok: true, key: FAKE_KEY, tag: r.status.tag })
    expect(s2.status()).toEqual(r.status)
    await s2.getKey()
    expect(safe.decryptCalls).toBe(decrypts + 1) // decrypted once, then kept in memory
  })

  it('refuses to save without encryption (never plaintext): nothing written', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    safe.available = false
    const s = store(fs, safe, { platform: 'linux' })
    await s.start()
    const r = await s.save(FAKE_KEY, {})
    expect(r).toMatchObject({ ok: false, code: 'storage-unavailable' })
    expect(r.message).toContain('không mã hoá')
    expect([...fs.files.keys()]).toEqual([])
    expect(s.status()).toMatchObject({ hasKey: false, storage: 'unavailable' })
    safe.available = true
    safe.failEncrypt = true
    expect((await s.save(FAKE_KEY, {})).code).toBe('storage-unavailable')
    expect(fs.files.has(F.bin)).toBe(false)
  })

  it('a key that cannot be decrypted here (copied profile, refused Keychain): unreadable, sticky, Xoá key still works', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    await store(fs, safe).save(FAKE_KEY, {})
    safe.failDecrypt = true
    const s = store(fs, safe, { placement: () => 'portable' })
    await s.start()
    const r = await s.getKey()
    expect(r).toMatchObject({ ok: false, code: 'key-unreadable' })
    expect(r.message).toContain('Portable')
    expect(s.status()).toMatchObject({ hasKey: true, problem: 'unreadable' })
    const calls = safe.decryptCalls
    await s.getKey()
    expect(safe.decryptCalls).toBe(calls) // never re-prompts on every request
    expect(await s.clear()).toMatchObject({ ok: true, status: { hasKey: false } })
    expect(fs.files.has(F.bin)).toBe(false)
    expect(fs.files.has(F.salt)).toBe(true) // the install salt stays
    safe.failDecrypt = false
    expect((await s.save(OTHER_KEY, {})).ok).toBe(true)
    expect(await s.getKey()).toMatchObject({ ok: true, key: OTHER_KEY })
  })

  it('garbage after decryption, empty / oversized files, a sidecar without its key', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    fs.files.set(F.bin, Buffer.from(await safe.encryptStringAsync('{"v":1,"key":"not a key","savedAt":1}')))
    let s = store(fs, safe)
    await s.start()
    expect((await s.getKey()).code).toBe('key-unreadable')
    for (const size of [0, 16 * 1024 + 1]) {
      fs.files.set(F.bin, Buffer.alloc(size))
      const calls = safe.decryptCalls
      s = store(fs, safe)
      await s.start()
      expect(fs.files.has(F.bin), String(size)).toBe(false)
      expect(s.status().hasKey).toBe(false)
      expect(safe.decryptCalls).toBe(calls)
    }
    fs.files.set(F.meta, Buffer.from(keyRules.keyMetaText({ hint: 'abcd', tag: null, savedAt: 1, verifiedAt: null })))
    s = store(fs, safe)
    await s.start()
    expect(fs.files.has(F.meta)).toBe(false)
    expect(s.status().hasKey).toBe(false)
  })

  it('a lost sidecar is rebuilt from the key with the same tag; shouldReEncrypt rewrites the same payload', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    const first = await store(fs, safe).save(FAKE_KEY, { verifiedAt: 7 })
    fs.files.delete(F.meta)
    const s = store(fs, safe)
    await s.start()
    expect(s.status()).toMatchObject({ hasKey: true, hint: null, tag: null, problem: 'unknown' })
    safe.reEncrypt = true
    const before = safe.encryptCalls
    expect(await s.getKey()).toMatchObject({ ok: true, tag: first.status.tag })
    expect(s.status()).toMatchObject({ hint: first.status.hint, tag: first.status.tag, savedAt: first.status.savedAt, verifiedAt: 7 })
    expect(fs.files.has(F.meta)).toBe(true)
    expect(safe.encryptCalls).toBe(before + 1)
    safe.reEncrypt = false
    expect(keyRules.parseKeyPayload((await safe.decryptStringAsync(fs.files.get(F.bin)!)).result)).toMatchObject({ key: FAKE_KEY, savedAt: first.status.savedAt })
  })

  it('Xoá key keeps the salt: the same key pasted again gets the same tag (jobs it sent are found again)', async () => {
    const fs = new MemFs()
    const s = store(fs, new FakeSafeStorage())
    await s.start()
    const a = await s.save(FAKE_KEY, {})
    await s.clear()
    const b = await s.save(FAKE_KEY, {})
    expect(b.status.tag).toBe(a.status.tag)
    const c = await s.save(OTHER_KEY, {})
    expect(c.status.tag).not.toBe(a.status.tag)
    expect(await s.getKey()).toMatchObject({ key: OTHER_KEY })
  })

  it('Xoá key never hangs behind a Keychain prompt: capped, marked, deleted unread at the next start', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    const s = store(fs, safe, { capMs: 30, sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) })
    await s.start()
    await s.save(FAKE_KEY, {})
    safe.hangEncrypt = true
    void s.save(OTHER_KEY, {}) // stuck in "encrypt" (a Keychain prompt nobody answers)
    const t0 = Date.now()
    const r = await s.clear()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r).toMatchObject({ ok: false, code: 'storage-failed' })
    expect(s.status().hasKey).toBe(false)
    expect(await Promise.race([s.getKey(), new Promise((resolve) => setTimeout(() => resolve('queued'), 50))])).toBe('queued')
    expect(fs.files.has(F.forget)).toBe(true)
    safe.hangEncrypt = false
    const calls = safe.decryptCalls
    const s2 = store(fs, safe)
    await s2.start()
    expect(fs.files.has(F.bin)).toBe(false)
    expect(fs.files.has(F.forget)).toBe(false)
    expect(s2.status().hasKey).toBe(false)
    expect(safe.decryptCalls).toBe(calls)
  })

  it('a locked key file: emptied, or marked when even that fails — never used again', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    // real waits: the retries (150 + 600 ms) stay under the cap
    const real = { capMs: 3000, sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }
    const s = store(fs, safe, real)
    await s.start()
    await s.save(FAKE_KEY, {})
    fs.locked.add(F.bin)
    const r = await s.clear()
    expect(r).toMatchObject({ ok: false, code: 'storage-failed' })
    expect(r.message).toContain('lần dùng sau')
    expect(fs.files.has(F.forget)).toBe(true)
    fs.locked.clear()
    const s2 = store(fs, safe)
    await s2.start()
    expect(fs.files.has(F.bin)).toBe(false)
    expect(s2.status().hasKey).toBe(false)
    // rm refused but the file can be emptied: gone (an empty key file is deleted unread)
    const fs3 = new MemFs()
    const s3 = store(fs3, safe, real)
    await s3.start()
    await s3.save(FAKE_KEY, {})
    const rm = fs3.rm.bind(fs3)
    fs3.rm = async (p: string) => {
      if (p === F.bin) throw eperm()
      return rm(p)
    }
    expect((await s3.clear()).ok).toBe(true)
    expect(fs3.files.get(F.bin)!.byteLength).toBe(0)
    fs3.rm = rm
    const s4 = store(fs3, safe)
    await s4.start()
    expect(fs3.files.has(F.bin)).toBe(false)
  })

  it('a save racing Xoá key never brings the key back', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    const s = store(fs, safe)
    await s.start()
    let release: () => void = () => undefined
    const enc = safe.encryptStringAsync.bind(safe)
    safe.encryptStringAsync = async (t: string) => {
      await new Promise<void>((resolve) => (release = resolve))
      return enc(t)
    }
    const saving = s.save(FAKE_KEY, {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    const clearing = s.clear()
    release()
    expect(await saving).toMatchObject({ ok: false, code: 'storage-failed', message: keyRules.SEEDVIS_KEY_TEXTS.superseded })
    await clearing
    expect(fs.files.has(F.bin)).toBe(false)
    expect(s.status().hasKey).toBe(false)
    expect((await s.getKey()).code).toBe('no-key')
  })

  /** Holds the first-use read of a saved key at `where` (after the decrypt) until release(). */
  function holdAfterDecrypt(fs: MemFs, safe: FakeSafeStorage, where: string) {
    const st = { reached: false, release: () => undefined as void }
    const gate = new Promise<void>((resolve) => (st.release = resolve))
    const hold = async () => {
      st.reached = true
      await gate
    }
    if (where === 'salt') {
      const read = fs.readFile.bind(fs)
      fs.readFile = async (p: string, enc?: string) => {
        if (p === F.salt) await hold()
        return read(p, enc)
      }
    } else if (where === 'sidecar') {
      fs.files.delete(F.meta) // the sidecar is rebuilt after the decrypt
      const write = fs.writeFile.bind(fs)
      fs.writeFile = async (p: string, d: string | Uint8Array) => {
        if (p === `${F.meta}.tmp`) await hold()
        return write(p, d)
      }
    } else {
      safe.reEncrypt = true
      const enc = safe.encryptStringAsync.bind(safe)
      safe.encryptStringAsync = async (t: string) => {
        await hold()
        return enc(t)
      }
    }
    return st
  }
  const realWaits = { capMs: 3000, sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(cond()).toBe(true)
  }

  it.each([['salt'], ['sidecar'], ['reencrypt']])(
    'Xoá key while the first read of the key is past the decrypt (%s): no-key — never ok without a key — and nothing comes back',
    async (where) => {
      const fs = new MemFs()
      const safe = new FakeSafeStorage()
      await store(fs, safe).save(FAKE_KEY, { verifiedAt: 5 })
      const held = holdAfterDecrypt(fs, safe, where)
      const s = store(fs, safe, realWaits)
      await s.start()
      const reading = s.getKey()
      await until(() => held.reached)
      const clearing = s.clear()
      held.release()
      expect(await reading).toEqual({ ok: false, code: 'no-key', message: keyRules.SEEDVIS_KEY_TEXTS.noKey })
      expect(await clearing).toMatchObject({ ok: true, status: { hasKey: false } })
      expect(fs.files.has(F.bin)).toBe(false)
      expect(fs.files.has(F.meta)).toBe(false)
      expect(s.status()).toEqual({ hasKey: false, hint: null, tag: null, savedAt: null, verifiedAt: null, storage: 'safeStorage' })
      expect(s.holds(FAKE_KEY)).toBe(false)
      expect((await s.getKey()).code).toBe('no-key')
    },
  )

  it('a new key saved while the old one is being read: the read answers no-key, the new key is the one in use', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    await store(fs, safe).save(FAKE_KEY, {})
    const held = holdAfterDecrypt(fs, safe, 'salt')
    const s = store(fs, safe, realWaits)
    await s.start()
    const reading = s.getKey()
    await until(() => held.reached)
    const saving = s.save(OTHER_KEY, {})
    held.release()
    expect(await reading).toMatchObject({ ok: false, code: 'no-key' })
    expect((await saving).ok).toBe(true)
    expect(await s.getKey()).toMatchObject({ ok: true, key: OTHER_KEY })
    expect(s.holds(FAKE_KEY)).toBe(false)
    expect(s.holds(OTHER_KEY)).toBe(true)
  })

  it('holds(): true only for the key in use; false after Xoá key, for junk, and before any read', async () => {
    const fs = new MemFs()
    const safe = new FakeSafeStorage()
    const s = store(fs, safe)
    await s.start()
    expect(s.holds(FAKE_KEY)).toBe(false)
    await s.save(FAKE_KEY, {})
    expect(s.holds(FAKE_KEY)).toBe(true)
    for (const bad of [OTHER_KEY, '', null, undefined, 42, `${FAKE_KEY} `]) expect(s.holds(bad), String(bad)).toBe(false)
    const restarted = store(fs, safe)
    await restarted.start()
    expect(restarted.holds(FAKE_KEY)).toBe(false) // not decrypted yet
    await s.clear()
    expect(s.holds(FAKE_KEY)).toBe(false)
  })

  it('markVerified updates the sidecar of the current key only', async () => {
    const fs = new MemFs()
    const s = store(fs, new FakeSafeStorage())
    await s.start()
    const r = await s.save(FAKE_KEY, {})
    await s.markVerified('000000000000', 99)
    expect(s.status().verifiedAt).toBeNull()
    await s.markVerified(r.status.tag, 12345)
    expect(s.status().verifiedAt).toBe(12345)
    expect(keyRules.parseKeyMeta(fs.files.get(F.meta)!.toString()).verifiedAt).toBe(12345)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Through seedvis.cjs (fake Electron, a fresh temp userData)
// ---------------------------------------------------------------------------------------------------------------

describe('seedvis.cjs: "Dán key", the key check, Xoá key — the key never comes back', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  const filesText = (dir: string) => readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('\n')

  it('main reads the clipboard, checks the key with GET /account/info, saves it encrypted, clears the clipboard', async () => {
    h = harness()
    h.clip.text = `  ${FAKE_KEY}\n`
    h.net.server = (ctl) => ctl.reply(jsonAnswer(200, accountInfo()))
    const r = await h.call('seedvis:pasteKey')
    expect(r).toMatchObject({ ok: true, status: { hasKey: true, hint: FAKE_KEY.slice(-4), storage: 'safeStorage' } })
    expect(Number.isFinite(r.status.verifiedAt)).toBe(true)
    expect(h.clip.text).toBe('')
    expect(h.net.seen).toHaveLength(1)
    expect(h.net.seen[0].url).toBe('https://seedvis.com/api/v1/account/info')
    expect(h.net.seen[0].headers.Authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(readdirSync(h.dir).sort()).toEqual(['seedvis-key.bin', 'seedvis-key.json', 'seedvis-key.salt'])
    expect(filesText(h.dir)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY)
  })

  it('leaves the clipboard alone when it changed meanwhile', async () => {
    h = harness()
    h.clip.text = FAKE_KEY
    h.net.server = (ctl) => {
      h.clip.text = 'something the user copied since'
      ctl.reply(jsonAnswer(200, accountInfo()))
    }
    expect((await h.call('seedvis:pasteKey')).ok).toBe(true)
    expect(h.clip.text).toBe('something the user copied since')
    expect(h.clip.cleared).toBe(0)
  })

  it.each([
    [401, {}, 'bad-key', keyRules.SEEDVIS_KEY_TEXTS.wrongKey],
    [403, {}, 'bad-key', keyRules.SEEDVIS_KEY_TEXTS.noApi],
    [200, { api_enabled: false }, 'bad-key', keyRules.SEEDVIS_KEY_TEXTS.noApi],
    [503, {}, 'network', keyRules.SEEDVIS_KEY_TEXTS.verifyBusy],
    [404, {}, 'bad-response', keyRules.SEEDVIS_KEY_TEXTS.verifyOdd],
  ])('a check answered %s is not saved (code %s), the clipboard is kept', async (status, over, code, message) => {
    h = harness()
    h.clip.text = FAKE_KEY
    h.net.server = (ctl) => ctl.reply(jsonAnswer(status as number, status === 200 ? accountInfo(over as Any) : { success: false }))
    expect(await h.call('seedvis:pasteKey')).toEqual({ ok: false, code, message })
    expect(h.clip.text).toBe(FAKE_KEY)
    expect(existsSync(join(h.dir, 'seedvis-key.bin'))).toBe(false)
    expect((await h.call('seedvis:keyStatus')).hasKey).toBe(false)
  })

  it('a network failure offers "Lưu mà chưa kiểm tra": saved without a request, verifiedAt null', async () => {
    h = harness()
    h.clip.text = FAKE_KEY
    h.net.server = (ctl) => ctl.fail('net::ERR_CONNECTION_RESET')
    expect(await h.call('seedvis:pasteKey')).toEqual({ ok: false, code: 'network', message: keyRules.SEEDVIS_KEY_TEXTS.verifyNetwork })
    const n = h.net.seen.length
    const r = await h.call('seedvis:pasteKey', { unverified: true })
    expect(r).toMatchObject({ ok: true, status: { hasKey: true, verifiedAt: null } })
    expect(h.net.seen).toHaveLength(n)
    expect(h.clip.text).toBe('')
  })

  it('"Lưu mà chưa kiểm tra" after the clipboard changed: refused — the other text is not saved, not sent, not cleared', async () => {
    h = harness()
    h.clip.text = FAKE_KEY
    h.net.server = (ctl) => ctl.fail('net::ERR_CONNECTION_RESET')
    expect(await h.call('seedvis:pasteKey')).toMatchObject({ ok: false, code: 'network' })
    const n = h.net.seen.length
    // the user copied something else meanwhile: another service's token matches the key charset — refused as not a
    // seedvis key at all (normalizeKeyInput), before the offer is even looked at
    const other = `ghp_TESTONLY${'a'.repeat(28)}`
    h.clip.text = other
    expect(await h.call('seedvis:pasteKey', { unverified: true })).toEqual({ ok: false, code: 'bad-key', message: keyRules.SEEDVIS_KEY_TEXTS.badClipboard })
    expect(await h.call('seedvis:pasteKey')).toEqual({ ok: false, code: 'bad-key', message: keyRules.SEEDVIS_KEY_TEXTS.badClipboard })
    expect(h.net.seen).toHaveLength(n)
    h.clip.text = OTHER_KEY
    expect(await h.call('seedvis:pasteKey', { unverified: true })).toEqual({ ok: false, code: 'bad-key', message: keyRules.SEEDVIS_KEY_TEXTS.unverifiedRefused })
    expect(h.clip.text).toBe(OTHER_KEY)
    expect(h.clip.cleared).toBe(0)
    expect(existsSync(join(h.dir, 'seedvis-key.bin'))).toBe(false)
    expect((await h.call('seedvis:keyStatus')).hasKey).toBe(false)
    expect(h.net.seen).toHaveLength(n)
    // the key that failed is still in the clipboard: allowed
    h.clip.text = FAKE_KEY
    expect(await h.call('seedvis:pasteKey', { unverified: true })).toMatchObject({ ok: true, status: { hasKey: true, verifiedAt: null } })
    expect(h.net.seen).toHaveLength(n)
  })

  it('"Lưu mà chưa kiểm tra" needs a check that failed on the network: never first, never after a refusal, never twice', async () => {
    h = harness()
    // nothing was checked
    h.clip.text = FAKE_KEY
    expect(await h.call('seedvis:pasteKey', { unverified: true })).toMatchObject({ ok: false, code: 'bad-key', message: keyRules.SEEDVIS_KEY_TEXTS.unverifiedRefused })
    expect(await h.call('seedvis:setKey', { key: FAKE_KEY, unverified: true })).toMatchObject({ ok: false, code: 'bad-key', message: keyRules.SEEDVIS_KEY_TEXTS.unverifiedRefused })
    expect(h.net.seen).toHaveLength(0)
    // seedvis said "wrong key" (401): not offered, even after an earlier network failure of the same key
    h.net.server = (ctl) => ctl.fail('net::ERR_CONNECTION_RESET')
    expect((await h.call('seedvis:setKey', { key: FAKE_KEY })).code).toBe('network')
    h.net.server = (ctl) => ctl.reply(jsonAnswer(401, { success: false }))
    expect((await h.call('seedvis:setKey', { key: FAKE_KEY })).message).toBe(keyRules.SEEDVIS_KEY_TEXTS.wrongKey)
    expect((await h.call('seedvis:setKey', { key: FAKE_KEY, unverified: true })).code).toBe('bad-key')
    // the fallback field: only the same key, once
    h.net.server = (ctl) => ctl.fail('net::ERR_TIMED_OUT')
    expect((await h.call('seedvis:setKey', { key: FAKE_KEY })).code).toBe('network')
    expect((await h.call('seedvis:setKey', { key: OTHER_KEY, unverified: true })).code).toBe('bad-key')
    expect(await h.call('seedvis:setKey', { key: `  ${FAKE_KEY}\n`, unverified: true })).toMatchObject({ ok: true, status: { hasKey: true, verifiedAt: null } })
    await h.call('seedvis:clearKey')
    expect((await h.call('seedvis:setKey', { key: FAKE_KEY, unverified: true })).code).toBe('bad-key')
    expect((await h.call('seedvis:keyStatus')).hasKey).toBe(false)
    // Xoá key also forgets an open offer
    expect((await h.call('seedvis:setKey', { key: FAKE_KEY })).code).toBe('network')
    await h.call('seedvis:clearKey')
    expect((await h.call('seedvis:setKey', { key: FAKE_KEY, unverified: true })).code).toBe('bad-key')
  })

  it('Xoá key while the first request decrypts the key: the submit sends nothing (never "Bearer null")', async () => {
    h = harness()
    expect((await saveKeyUnverified(h)).ok).toBe(true)
    const dir = h.dir
    h.gw.dispose()
    h = harness({ dir }) // a restart: the key is decrypted on its first use
    const real = fsPromises.readFile
    let reached = false
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const spy = vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Any[]) => {
      if (String(args[0]).endsWith('seedvis-key.salt')) {
        reached = true
        await gate
      }
      return (real as Any).apply(fsPromises, args)
    }) as Any)
    try {
      h.net.server = (ctl) => ctl.reply(jsonAnswer(202, queued202('gen_x')))
      const sending = h.call('seedvis:request', createReq())
      for (let i = 0; i < 200 && !reached; i++) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(reached).toBe(true)
      const clearing = h.call('seedvis:clearKey')
      release()
      expect(await sending).toMatchObject({ ok: false, code: 'no-key', sent: false })
      expect((await clearing).ok).toBe(true)
    } finally {
      spy.mockRestore()
    }
    await settle()
    expect(h.net.seen).toHaveLength(0)
    expect(existsSync(join(h.dir, 'seedvis-key.bin'))).toBe(false)
    expect(existsSync(join(h.dir, 'seedvis-key.json'))).toBe(false)
    expect((await h.call('seedvis:keyStatus')).hasKey).toBe(false)
  })

  it('refuses clipboard text that is not a key, without any request', async () => {
    h = harness()
    for (const t of ['', 'hello', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} ${FAKE_KEY}`, `${FAKE_KEY}${'x'.repeat(1000)}`]) {
      h.clip.text = t
      expect(await h.call('seedvis:pasteKey'), t.slice(0, 20)).toEqual({ ok: false, code: 'bad-key', message: keyRules.SEEDVIS_KEY_TEXTS.badClipboard })
      expect(h.clip.text).toBe(t)
    }
    expect(await h.call('seedvis:setKey', { key: 'short' })).toEqual({ ok: false, code: 'bad-key', message: keyRules.SEEDVIS_KEY_TEXTS.badFormat })
    expect(await h.call('seedvis:setKey', { key: 42 })).toMatchObject({ ok: false, code: 'bad-key' })
    expect(h.net.seen).toHaveLength(0)
  })

  it('no IPC answer and no log line ever contains the key (a whole session)', async () => {
    h = harness({ packaged: false })
    const results: unknown[] = []
    const call = async (ch: string, arg?: Any) => {
      const r = await h.call(ch, arg)
      results.push(r)
      return r
    }
    h.clip.text = FAKE_KEY
    let infoDown = false
    h.net.server = (ctl) => {
      const u = ctl.req.url
      if (u.endsWith('/account/info')) return infoDown ? ctl.fail('net::ERR_CONNECTION_RESET') : ctl.reply(jsonAnswer(200, accountInfo({ plan: `echo ${FAKE_KEY}` })))
      if (u.endsWith('/account/usage')) return ctl.reply(jsonAnswer(200, { success: true, data: { credit_balance: 3, note: FAKE_KEY } }))
      if (u.endsWith('/models')) return ctl.reply(jsonAnswer(200, { success: true, data: [{ id: 'Veo-3.1', echo: `Bearer ${FAKE_KEY}` }] }))
      if (u.endsWith('/developer/generations')) return ctl.reply(jsonAnswer(202, { ...queued202('gen_1'), echo: { authorization: `Bearer ${FAKE_KEY}` } }))
      if (u.includes('/cancel')) return ctl.reply(jsonAnswer(409, { success: false, code: 'not_cancellable', message: `key ${FAKE_KEY}` }))
      if (u.includes('/developer/generations/')) return ctl.reply(jsonAnswer(200, completed('gen_1')))
      return ctl.reply(jsonAnswer(500, { message: FAKE_KEY }))
    }
    await call('seedvis:pasteKey')
    await call('seedvis:keyStatus')
    await call('seedvis:request', { route: 'account.info' })
    await call('seedvis:request', { route: 'account.usage' })
    await call('seedvis:request', { route: 'models' })
    await call('seedvis:request', createReq())
    await call('seedvis:request', { route: 'generations.get', id: 'gen_1' })
    await call('seedvis:request', { route: 'generations.cancel', id: 'gen_1' })
    await call('seedvis:isOnline')
    await call('seedvis:clearKey')
    await call('seedvis:request', { route: 'models' })
    infoDown = true
    await call('seedvis:setKey', { key: FAKE_KEY })
    await call('seedvis:setKey', { key: OTHER_KEY, unverified: true }) // refused: not the key whose check failed
    await call('seedvis:setKey', { key: FAKE_KEY, unverified: true })
    await call('seedvis:keyStatus')
    await settle()
    const all = JSON.stringify(results) + '\n' + h.logs.join('\n')
    for (const k of [FAKE_KEY, OTHER_KEY]) {
      expect(all).not.toContain(k)
      expect(all).not.toContain(k.slice(8, 30)) // not even the middle of it
    }
    expect(results.length).toBe(15)
    expect(results[12]).toMatchObject({ ok: false, code: 'bad-key', message: keyRules.SEEDVIS_KEY_TEXTS.unverifiedRefused })
    expect(results[13]).toMatchObject({ ok: true, status: { hasKey: true, verifiedAt: null } })
  })

  it('Xoá key: files gone, the next request says no-key and sends nothing', async () => {
    h = harness()
    expect((await saveKeyUnverified(h)).ok).toBe(true)
    expect(await h.call('seedvis:clearKey')).toMatchObject({ ok: true, status: { hasKey: false } })
    expect(existsSync(join(h.dir, 'seedvis-key.bin'))).toBe(false)
    expect(existsSync(join(h.dir, 'seedvis-key.json'))).toBe(false)
    expect(await h.call('seedvis:request', { route: 'models' })).toMatchObject({ ok: false, code: 'no-key' })
    expect(await h.call('seedvis:request', createReq())).toMatchObject({ ok: false, code: 'no-key', sent: false })
    expect(h.net.seen).toHaveLength(0)
  })

  it('Linux plain-text backend: refused (never plaintext); a key this account cannot decrypt: requests refused, nothing sent', async () => {
    h = harness({ platform: 'linux' })
    h.safe.backend = 'basic_text'
    expect(await saveKeyUnverified(h)).toMatchObject({ ok: false, code: 'storage-unavailable' })
    expect(readdirSync(h.dir).filter((f) => f.startsWith('seedvis-key.bin'))).toEqual([])
    h.cleanup()
    // saved by one install, read by another Windows account
    h = harness()
    expect((await saveKeyUnverified(h)).ok).toBe(true)
    const dir = h.dir
    h.gw.dispose()
    const other = harness({ dir, placement: 'installer' })
    other.safe.failDecrypt = true
    const r = await other.call('seedvis:request', createReq({ idempotencyKey: UUID }))
    expect(r).toMatchObject({ ok: false, code: 'key-unreadable', sent: false })
    expect(other.net.seen).toHaveLength(0)
    expect((await other.call('seedvis:keyStatus')).problem).toBe('unreadable')
    expect((await other.call('seedvis:clearKey')).ok).toBe(true)
    other.cleanup()
    h = harness() // afterEach cleans this one
  })

  it('a successful GET /account/info with the stored key refreshes verifiedAt (sidecar)', async () => {
    h = harness()
    expect((await saveKeyUnverified(h)).ok).toBe(true)
    expect((await h.call('seedvis:keyStatus')).verifiedAt).toBeNull()
    h.net.server = (ctl) => ctl.reply(jsonAnswer(200, accountInfo()))
    await h.call('seedvis:request', { route: 'account.info' })
    // the next key read is queued behind the sidecar write
    await h.call('seedvis:request', { route: 'models' })
    expect(Number.isFinite((await h.call('seedvis:keyStatus')).verifiedAt)).toBe(true)
    expect(keyRules.parseKeyMeta(readFileSync(join(h.dir, 'seedvis-key.json'), 'utf8')).verifiedAt).not.toBeNull()
  })
})

// Giữ đăng nhập Google (electron/google-keep-rules.cjs): createGoogleKeep against a fake cookie store with a 'changed'
// emitter, a fake reversible async safeStorage, an in-memory fs and fake timers / clock. No Electron, no Google, no profile.
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Ck {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  session: boolean
  expirationDate?: number
}
interface Keep {
  restore(): Promise<number>
  sweep(): Promise<void>
  start(): void
  save(): Promise<void>
  detach(): void
  wipe(): Promise<void>
}
interface Rules {
  GOOGLE_KEEP_IDLE_DAYS: number
  createGoogleKeep(deps: Record<string, unknown>): Keep
}
const R = createRequire(import.meta.url)('../../../electron/google-keep-rules.cjs') as Rules

const FILE = 'C:/profile/google-canvasapp.bin'
const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 29)
const inYear = () => Math.floor(Date.now() / 1000) + 365 * 86_400
type Listener = (e: unknown, c: Ck, cause: string, removed: boolean) => void

function fakeStore(initial: Ck[] = []) {
  const jar = new Map<string, Ck>()
  const key = (c: Ck) => `${c.name}\n${c.domain}\n${c.path}`
  for (const c of initial) jar.set(key(c), c)
  const listeners: Listener[] = []
  const emit = (c: Ck, cause: string, removed: boolean) => {
    for (const l of listeners) l({}, { ...c }, cause, removed)
  }
  const calls = { set: [] as Record<string, unknown>[], remove: 0, flush: 0 }
  const insert = (c: Ck) => {
    const old = jar.get(key(c))
    if (old) jar.delete(key(c)), emit(old, 'overwrite', true)
    jar.set(key(c), c)
    emit(c, 'inserted', false)
  }
  return {
    jar,
    calls,
    listeners,
    get: async () => [...jar.values()].map((c) => ({ ...c })),
    set: async (d: Record<string, unknown>) => {
      calls.set.push(d)
      const hostOnly = d.domain === undefined
      const c: Ck = { name: String(d.name), value: String(d.value), domain: hostOnly ? new URL(String(d.url)).hostname : String(d.domain), hostOnly, path: String(d.path ?? '/'), secure: d.secure === true, httpOnly: d.httpOnly === true, sameSite: String(d.sameSite ?? 'unspecified'), session: d.expirationDate === undefined }
      if (d.expirationDate !== undefined) c.expirationDate = Number(d.expirationDate)
      insert(c)
    },
    remove: async (url: string, name: string) => {
      calls.remove++
      const u = new URL(url)
      for (const [k, c] of jar) if (c.name === name && c.domain.replace(/^\./, '') === u.hostname && u.pathname.startsWith(c.path)) jar.delete(k), emit(c, 'explicit', true)
    },
    flushStore: async () => void calls.flush++,
    on: (_ev: string, fn: Listener) => void listeners.push(fn),
    /** What a Set-Cookie of Google's server does. */
    server: (c: Ck) => insert(c),
    clear: () => {
      for (const [k, c] of [...jar]) jar.delete(k), emit(c, 'explicit', true)
    },
  }
}
type Store = ReturnType<typeof fakeStore>

const SECRET = 'S3cr3tValue'
const sid = (o: Partial<Ck> = {}): Ck => ({ name: 'SID', value: `${SECRET}-sid`, domain: '.google.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', session: false, expirationDate: inYear(), ...o })
const gaps = (o: Partial<Ck> = {}): Ck => ({ name: '__Host-GAPS', value: `${SECRET}-gaps`, domain: 'accounts.google.com', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false, expirationDate: inYear(), ...o })
const canvas = (): Ck => ({ name: 'canvas_session', value: `${SECRET}-cv`, domain: 'canvasapp.io.vn', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true })

function machine() {
  const files = new Map<string, Uint8Array>()
  const ops: string[] = []
  const m = {
    files,
    ops,
    failRename: false,
    available: true,
    fs: {
      readFile: async (p: string) => {
        if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return files.get(p)!
      },
      writeFile: async (p: string, b: Uint8Array) => void (ops.push(`write ${p}`), files.set(p, b)),
      rename: async (a: string, b: string) => {
        ops.push(`rename ${a} ${b}`)
        if (m.failRename) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        files.set(b, files.get(a)!)
        files.delete(a)
      },
      rm: async (p: string) => void (ops.push(`rm ${p}`), files.delete(p)),
    },
    /** main's asyncSafeStorage: isEncryptionAvailable is false without encryption and for Linux basic_text. */
    crypto: {
      isEncryptionAvailable: async () => m.available,
      encryptStringAsync: async (t: string) => encrypt(t),
      decryptStringAsync: async (b: Uint8Array) => ({ result: decrypt(b), shouldReEncrypt: false }),
    },
  }
  return m
}
const encrypt = (t: string) => new Uint8Array(Buffer.from('ENC:' + Buffer.from(t).toString('base64')))
function decrypt(b: Uint8Array) {
  const s = Buffer.from(b).toString()
  if (!s.startsWith('ENC:')) throw new Error('bad')
  return Buffer.from(s.slice(4), 'base64').toString()
}
type Machine = ReturnType<typeof machine>

const logs: string[] = []
function keepOf(store: Store, m: Machine, o: { allowed?: () => boolean; owner?: () => string | null } = {}) {
  return R.createGoogleKeep({ label: 'google-test', file: FILE, cookies: store, crypto: m.crypto, fs: m.fs, now: () => Date.now(), log: (l: string) => void logs.push(l), ...o })
}
const snapshot = (m: Machine) => JSON.parse(decrypt(m.files.get(FILE)!)) as { v: number; savedAt: number; owner: string | null; cookies: (Ck & { expirationDate?: number })[] }
const writeSnapshot = (m: Machine, s: unknown) => m.files.set(FILE, encrypt(JSON.stringify(s)))
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  logs.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  // values never reach a log line
  for (const line of logs) expect(line).not.toContain(SECRET)
})

describe('createGoogleKeep', () => {
  it('a persistent Google cookie becomes a session cookie at once and is saved (original expiry kept, other hosts untouched)', async () => {
    const store = fakeStore([canvas()])
    const m = machine()
    const keep = keepOf(store, m)
    expect(await keep.restore()).toBe(0)
    keep.start()
    const exp = inYear()
    store.server(sid({ expirationDate: exp }))
    await settle()
    expect([...store.jar.values()].find((c) => c.name === 'SID')).toMatchObject({ session: true, value: `${SECRET}-sid` })
    expect([...store.jar.values()].some((c) => c.expirationDate !== undefined)).toBe(false)
    expect(store.calls.set).toHaveLength(1) // our own re-set never loops
    expect(m.files.has(FILE)).toBe(false) // debounced
    await vi.advanceTimersByTimeAsync(1000)
    const snap = snapshot(m)
    expect(snap).toMatchObject({ v: 1, savedAt: T0 + 1000, owner: null })
    expect(snap.cookies).toEqual([{ name: 'SID', value: `${SECRET}-sid`, domain: 'google.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', expirationDate: exp }])
    expect(Buffer.from(m.files.get(FILE)!).toString()).not.toContain(SECRET) // encrypted
    expect(store.jar.get('canvas_session\ncanvasapp.io.vn\n/')).toMatchObject({ value: `${SECRET}-cv` })
  })

  it('restore: session cookies only, right url / domain / host-only; a cookie already there wins; expired entries dropped', async () => {
    const m = machine()
    const now = Math.floor(T0 / 1000)
    writeSnapshot(m, {
      v: 1,
      savedAt: T0 - DAY,
      owner: null,
      cookies: [
        { name: 'SID', value: 'v-sid', domain: 'google.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', expirationDate: now + 1000 },
        { name: '__Host-GAPS', value: 'v-gaps', domain: 'accounts.google.com', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
        { name: 'OLD', value: 'v-old', domain: 'google.com', hostOnly: false, path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: now - 1 },
        { name: 'NID', value: 'v-nid-file', domain: 'google.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' },
        { name: 'X', value: 'v-evil', domain: 'evilgoogle.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
      ],
    })
    const store = fakeStore([sid({ name: 'NID', value: 'v-nid-live', session: true, expirationDate: undefined, sameSite: 'no_restriction' })])
    expect(await keepOf(store, m).restore()).toBe(2)
    expect(store.calls.set).toEqual([
      { url: 'https://google.com/', name: 'SID', value: 'v-sid', path: '/', secure: true, httpOnly: true, sameSite: 'unspecified', domain: '.google.com' },
      { url: 'https://accounts.google.com/', name: '__Host-GAPS', value: 'v-gaps', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
    ])
    expect([...store.jar.values()].every((c) => c.session)).toBe(true)
    expect(store.jar.get('NID\n.google.com\n/')!.value).toBe('v-nid-live')
  })

  it('restored cookies keep their original expiry in the next snapshot', async () => {
    const m = machine()
    const exp = inYear()
    writeSnapshot(m, { v: 1, savedAt: T0, owner: null, cookies: [{ name: 'SID', value: 'v', domain: 'google.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: exp }] })
    vi.setSystemTime(T0 + DAY)
    const keep = keepOf(fakeStore(), m)
    await keep.restore()
    await keep.save()
    expect(snapshot(m)).toMatchObject({ savedAt: T0 + DAY, cookies: [{ name: 'SID', expirationDate: exp }] })
  })

  it(`older than ${R.GOOGLE_KEEP_IDLE_DAYS} days, from the future, another owner, undecryptable or not JSON: deleted, nothing restored`, async () => {
    const entry = { name: 'SID', value: 'v', domain: 'google.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax' }
    const cases: [string, (m: Machine) => void, { owner?: () => string | null }][] = [
      ['too old', (m) => writeSnapshot(m, { v: 1, savedAt: T0 - (R.GOOGLE_KEEP_IDLE_DAYS * DAY + 1), owner: null, cookies: [entry] }), {}],
      ['too old', (m) => writeSnapshot(m, { v: 1, savedAt: T0 + 2 * DAY, owner: null, cookies: [entry] }), {}],
      ['another owner', (m) => writeSnapshot(m, { v: 1, savedAt: T0, owner: 'hash-a', cookies: [entry] }), { owner: () => 'hash-b' }],
      ['another owner', (m) => writeSnapshot(m, { v: 1, savedAt: T0, owner: 'hash-a', cookies: [entry] }), {}],
      ['unreadable', (m) => void m.files.set(FILE, new Uint8Array(Buffer.from('garbage'))), {}],
      ['unreadable', (m) => void m.files.set(FILE, encrypt('{not json')), {}],
      ['unreadable', (m) => writeSnapshot(m, { v: 2, savedAt: T0, owner: null, cookies: [entry] }), {}],
      ['unreadable', (m) => void m.files.set(FILE, new Uint8Array(0)), {}],
    ]
    for (const [why, prepare, o] of cases) {
      const m = machine()
      prepare(m)
      const store = fakeStore()
      logs.length = 0
      expect(await keepOf(store, m, o).restore(), why).toBe(0)
      expect([m.files.has(FILE), store.jar.size], why).toEqual([false, 0])
      expect(logs, why).toEqual([`[SanoVids] google-test: copy deleted (${why})`])
    }
    // the same owner: put back, and the next snapshot is bound to it
    const m = machine()
    writeSnapshot(m, { v: 1, savedAt: T0, owner: 'hash-a', cookies: [entry] })
    const keep = keepOf(fakeStore(), m, { owner: () => 'hash-a' })
    expect(await keep.restore()).toBe(1)
    vi.setSystemTime(T0 + 1000)
    await keep.save()
    expect(snapshot(m)).toMatchObject({ owner: 'hash-a', savedAt: T0 + 1000 })
  })

  it('an owner rule with no owner now: the snapshot is neither read, deleted nor written', async () => {
    const m = machine()
    writeSnapshot(m, { v: 1, savedAt: T0, owner: 'hash-a', cookies: [] })
    const before = m.files.get(FILE)
    const store = fakeStore([sid({ session: true, expirationDate: undefined })])
    const keep = keepOf(store, m, { owner: () => null })
    expect(await keep.restore()).toBe(0)
    await keep.save()
    expect(m.files.get(FILE)).toBe(before)
  })

  it('not allowed: restore / save delete the snapshot and write nothing; wipe also removes the Google cookies', async () => {
    let allowed = true
    const m = machine()
    const store = fakeStore([sid({ session: true, expirationDate: undefined }), canvas()])
    const keep = keepOf(store, m, { allowed: () => allowed })
    await keep.restore()
    await keep.save()
    expect(m.files.has(FILE)).toBe(true)
    allowed = false
    await keep.save()
    expect(m.files.has(FILE)).toBe(false)
    expect(store.jar.size).toBe(2) // save never removes cookies (a Google sign-in may be under way)
    await keep.wipe()
    expect([...store.jar.values()].map((c) => c.name)).toEqual(['canvas_session'])
    expect(store.calls.flush).toBeGreaterThan(0)
    // a fresh run with a snapshot on disk and keeping not allowed: deleted unread
    const m2 = machine()
    writeSnapshot(m2, { v: 1, savedAt: T0, owner: null, cookies: [] })
    expect(await keepOf(fakeStore(), m2, { allowed: () => false }).restore()).toBe(0)
    expect(m2.files.has(FILE)).toBe(false)
  })

  it('no encryption (main also reports Linux basic_text so): nothing kept, a copy on disk deleted, cookies still session-only', async () => {
    const m = machine()
    writeSnapshot(m, { v: 1, savedAt: T0, owner: null, cookies: [] })
    m.available = false
    const store = fakeStore()
    const keep = keepOf(store, m)
    await keep.restore()
    expect(m.files.has(FILE)).toBe(false)
    keep.start()
    store.server(sid())
    await vi.advanceTimersByTimeAsync(2000)
    await keep.save()
    expect(m.files.size).toBe(0)
    expect(store.jar.get('SID\n.google.com\n/')!.session).toBe(true)
    // a broken encryptor counts as none
    const m2 = machine()
    m2.crypto.isEncryptionAvailable = async () => {
      throw new Error('keychain')
    }
    const k2 = keepOf(fakeStore([sid({ session: true, expirationDate: undefined })]), m2)
    await k2.restore()
    await k2.save()
    expect(m2.files.size).toBe(0)
  })

  it('sweep: leftover persistent Google cookies become session ones and are saved, then flushed; not allowed → removed', async () => {
    const exp = inYear()
    const store = fakeStore([sid({ expirationDate: exp }), gaps(), canvas()])
    const m = machine()
    const keep = keepOf(store, m)
    await keep.restore()
    await keep.sweep()
    expect([...store.jar.values()].every((c) => c.session)).toBe(true)
    expect(store.calls.flush).toBe(1)
    expect(snapshot(m).cookies.map((c) => [c.name, c.expirationDate])).toEqual([
      ['SID', exp],
      ['__Host-GAPS', gaps().expirationDate],
    ])
    const off = fakeStore([sid(), gaps(), canvas()])
    await keepOf(off, machine(), { allowed: () => false }).sweep()
    expect([...off.jar.values()].map((c) => c.name)).toEqual(['canvas_session'])
    expect(off.calls.flush).toBe(1)
  })

  it('debounce: changes within 1 s coalesce into one write; constant changes still write within 10 s', async () => {
    const store = fakeStore()
    const m = machine()
    const keep = keepOf(store, m)
    await keep.restore()
    keep.start()
    store.server(sid())
    await vi.advanceTimersByTimeAsync(500)
    store.server(gaps())
    await vi.advanceTimersByTimeAsync(999)
    expect(m.ops.filter((o) => o.startsWith('write'))).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(m.ops.filter((o) => o.startsWith('write'))).toHaveLength(1)
    expect(snapshot(m).cookies).toHaveLength(2)
    // SIDCC-style rotation every 500 ms: the 10 s cap still writes
    m.ops.length = 0
    for (let i = 0; i < 20; i++) {
      store.server(sid({ name: 'SIDCC', value: `${SECRET}-${i}` }))
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(m.ops.filter((o) => o.startsWith('write')).length).toBeGreaterThanOrEqual(1)
    // our own removals (a clear / wipe: 'explicit') schedule nothing
    m.ops.length = 0
    await vi.advanceTimersByTimeAsync(2000)
    m.ops.length = 0
    store.clear()
    await vi.advanceTimersByTimeAsync(2000)
    expect(m.ops).toEqual([])
    expect(m.files.has(FILE)).toBe(true)
  })

  it('a Google removal (sign-out) saves; nothing left → the snapshot is deleted', async () => {
    const store = fakeStore()
    const m = machine()
    const keep = keepOf(store, m)
    await keep.restore()
    keep.start()
    store.server(sid())
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.files.has(FILE)).toBe(true)
    const c = store.jar.get('SID\n.google.com\n/')!
    store.jar.delete('SID\n.google.com\n/')
    for (const l of store.listeners) l({}, c, 'expired-overwrite', true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.files.has(FILE)).toBe(false)
  })

  it('nothing saved before restore() or after detach(): an empty or cleared store never deletes the snapshot', async () => {
    const m = machine()
    writeSnapshot(m, { v: 1, savedAt: T0, owner: null, cookies: [] })
    const before = m.files.get(FILE)
    const keep = keepOf(fakeStore(), m)
    await keep.save()
    expect(m.files.get(FILE)).toBe(before)
    const store = fakeStore()
    const k2 = keepOf(store, m)
    await k2.restore()
    store.server(sid({ session: true, expirationDate: undefined }))
    await k2.save()
    const kept = m.files.get(FILE)
    k2.detach()
    store.clear()
    await k2.save()
    expect(m.files.get(FILE)).toBe(kept)
  })

  it('atomic write: tmp then rename; a failed rename leaves the old snapshot and no tmp', async () => {
    const store = fakeStore([sid({ session: true, expirationDate: undefined })])
    const m = machine()
    const keep = keepOf(store, m)
    await keep.restore()
    await keep.save()
    expect(m.ops).toEqual([`write ${FILE}.tmp`, `rename ${FILE}.tmp ${FILE}`])
    const old = m.files.get(FILE)
    m.failRename = true
    store.server(sid({ session: true, expirationDate: undefined, value: `${SECRET}-new` }))
    await keep.save()
    expect(m.files.get(FILE)).toBe(old)
    expect(m.files.has(`${FILE}.tmp`)).toBe(false)
    expect(logs).toContain('[SanoVids] google-test: failed (Error)')
  })
})

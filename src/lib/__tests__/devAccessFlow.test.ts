// electron/devaccess.cjs end to end with a fake 'electron' (ipcMain / powerMonitor / safeStorage), a real temp userData
// folder, real node:crypto, a throw-away Ed25519 key pinned in a temp package.json and an injected clock: unlock by code
// (once), link the authenticator (once per window, minimize closes it), unlock by 6 digits, replay, waits, keep / cap,
// expiry and clock-back pushes, restart (code re-verified; a dropped key locks), a bad file, the build-opened state,
// non-app senders, and nothing secret in the state, the log or the push. No real key, no network.
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import nodeFs from 'node:fs'
import Module, { createRequire } from 'node:module'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const req = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const R = req('../../../electron/devaccess-rules.cjs') as any

type Handler = (event: unknown, arg?: unknown) => Promise<Record<string, unknown>>
const handlers = new Map<string, Handler>()
const power = new EventEmitter()
const fakeElectron = {
  ipcMain: {
    handle: (ch: string, fn: Handler) => {
      if (handlers.has(ch)) throw new Error(`second handler for ${ch}`)
      handlers.set(ch, fn)
    },
    removeHandler: (ch: string) => handlers.delete(ch),
  },
  powerMonitor: power,
  safeStorage: {
    isEncryptionAvailable: () => true,
    // "DPAPI": reversible but not the plain text (enough to prove the file never holds the secret in clear)
    encryptString: (s: string) => Buffer.from(`ENC:${Buffer.from(s).toString('hex').split('').reverse().join('')}`),
    decryptString: (b: Buffer) => {
      const t = b.toString()
      if (!t.startsWith('ENC:') || safeState.broken) throw new Error('decrypt failed')
      return Buffer.from(t.slice(4).split('').reverse().join(''), 'hex').toString()
    },
  },
}
const safeState = { broken: false }

const injected: { id: string; previous: NodeModule | undefined }[] = []
function inject(id: string, exports: unknown) {
  const m = new Module(id)
  m.filename = id
  m.loaded = true
  m.exports = exports
  injected.push({ id, previous: req.cache[id] })
  req.cache[id] = m
}

interface DevAccess {
  initialArg(): string
  state(): Record<string, unknown>
  attachWindow(win: EventEmitter): void
  dispose(): void
}
let setupDevAccess: (o: Record<string, unknown>) => DevAccess
let root = ''
const key = (() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { privateKey, pin: { kid: 1, alg: 'ed25519', key: publicKey.export({ format: 'jwk' }).x as string } }
})()

const APP = { senderFrame: { url: 'app://bdp/index.html' } }
const OTHER = { senderFrame: { url: 'https://canvasapp.io.vn/' } }
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0)

class FakeWindow extends EventEmitter {
  sent: { channel: string; state: Record<string, unknown> }[] = []
  webContents = { send: (channel: string, state: Record<string, unknown>) => this.sent.push({ channel, state }) }
  isDestroyed = () => false
}

function makeCode(deviceCode: string, o: { hours?: number; link?: boolean; maxDays?: number; nowMs?: number } = {}): string {
  const payload = R.buildPayload({
    kid: 1,
    link: o.link ?? true,
    deviceId: R.parseDeviceCode(deviceCode),
    useByHours: R.useByHoursOf((o.nowMs ?? T0) + (o.hours ?? 4) * R.HOUR_MS),
    maxDays: o.maxDays ?? 0,
    nonce: crypto.randomBytes(5),
  })
  return R.formatCode(payload, new Uint8Array(crypto.sign(null, Buffer.from(R.signedMessage(payload)), key.privateKey)))
}

const hmac = (k: Uint8Array, m: Uint8Array) => crypto.createHmac('sha1', k).update(m).digest()
const totpAt = (secretB32: string, ms: number, d = 0) => R.hotp(R.base32Decode(secretB32), Math.floor(ms / 30000) + d, hmac)

describe('devaccess.cjs flow (fake electron, real files and crypto)', () => {
  beforeAll(() => {
    root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sanovids-devaccess-'))
    inject(req.resolve('electron'), fakeElectron)
    const id = req.resolve('../../../electron/devaccess.cjs')
    injected.push({ id, previous: req.cache[id] })
    delete req.cache[id]
    setupDevAccess = (req(id) as { setupDevAccess: typeof setupDevAccess }).setupDevAccess
  })
  afterAll(() => {
    for (const { id, previous } of injected.reverse()) {
      if (previous) req.cache[id] = previous
      else delete req.cache[id]
    }
    nodeFs.rmSync(root, { recursive: true, force: true })
  })

  const live: DevAccess[] = []
  afterEach(() => {
    for (const d of live.splice(0)) d.dispose()
    handlers.clear()
    power.removeAllListeners()
    safeState.broken = false
  })

  let n = 0
  function boot(o: { dir?: string; pins?: unknown[]; buildOpen?: boolean; platform?: string; clock?: { now: number } } = {}) {
    const dir = o.dir ?? nodeFs.mkdtempSync(nodePath.join(root, `u${++n}-`))
    const pkg = nodePath.join(dir, 'package.json.test')
    nodeFs.writeFileSync(pkg, JSON.stringify({ sanovids: { signers: ['X'], devUnlockKeys: o.pins ?? [key.pin] } }))
    const clock = o.clock ?? { now: T0 }
    const win = new FakeWindow()
    const d = setupDevAccess({
      userDataDir: dir,
      pkgJsonPath: pkg,
      buildOpen: o.buildOpen ?? false,
      isAppSender: (e: { senderFrame?: { url?: string } }) => !!e?.senderFrame?.url?.startsWith('app://bdp/'),
      getMainWindow: () => win,
      platform: o.platform ?? 'win32',
      now: () => clock.now,
    })
    d.attachWindow(win)
    live.push(d)
    const call = (ch: string, arg?: unknown, ev: unknown = APP) => handlers.get(`devAccess:${ch}`)!(ev, arg)
    return { dir, d, win, clock, call }
  }
  const file = (dir: string) => JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'dev-access.json'), 'utf8'))

  it('starts locked with a device; only app pages may call; the state carries nothing secret', async () => {
    const { dir, d, call } = boot()
    expect(d.initialArg()).toBe('--bdp-dev-access=locked')
    const st = await call('getState')
    expect(st.access).toBe('locked')
    expect(st.deviceCode).toMatch(/^.{4}-.{4}$/)
    expect(file(dir).device).toHaveLength(43)
    expect(JSON.stringify(st)).not.toContain(file(dir).device)
    expect(await call('getState', undefined, OTHER)).toEqual({ ok: false, error: 'not-allowed' })
    expect(await call('unlock', { code: makeCode(String(st.deviceCode)) }, OTHER)).toEqual({ ok: false, error: 'not-allowed' })
    expect((await call('getState')).access).toBe('locked')
  })

  it('a code unlocks once; another device / garbage / 6 digits without a link are refused', async () => {
    const { dir, call, clock } = boot()
    const dc = String((await call('getState')).deviceCode)
    expect(await call('unlock', { code: makeCode('0000-0000') })).toMatchObject({ ok: false, error: 'other-device', codeDevice: '0000-0000', thisDevice: dc })
    clock.now += 1500
    expect(await call('unlock', { code: 'hello' })).toMatchObject({ ok: false, error: 'malformed' })
    clock.now += 1500
    expect(await call('unlock', { code: '123456' })).toMatchObject({ ok: false, error: 'totp-none', thisDevice: dc })
    expect(await call('unlock', { code: '123456' })).toMatchObject({ ok: false, error: 'too-fast' }) // ≥ 1 s between tries
    clock.now += 1500
    const c = makeCode(dc, { nowMs: clock.now })
    const ok = await call('unlock', { code: c })
    expect(ok.ok).toBe(true)
    const st = ok.state as Record<string, unknown>
    expect(st).toMatchObject({ access: 'unlocked', method: 'code', until: clock.now + 7 * R.DAY_MS, linkUntil: clock.now + R.LINK_WINDOW_MS, linkStarted: false })
    const rec = file(dir)
    expect(rec.unlock.method).toBe('code')
    expect(rec.used).toHaveLength(1)
    // lock, then the same code again → used
    expect((await call('lock')).access).toBe('locked')
    clock.now += 1500
    expect(await call('unlock', { code: c })).toMatchObject({ ok: false, error: 'used' })
  })

  it('links the authenticator once per window, then unlocks with 6 digits (replay refused, Windows-encrypted)', async () => {
    const { dir, call, clock, win } = boot()
    const dc = String((await call('getState')).deviceCode)
    expect(await call('totpBegin')).toEqual({ ok: false, error: 'link-window' }) // locked: no window
    await call('unlock', { code: makeCode(dc) })
    const begin = await call('totpBegin')
    expect(begin.ok).toBe(true)
    expect(begin.label).toBe(`SanoVids · Máy ${dc.slice(0, 4)}`)
    const secret = (begin.secretGroups as string[]).join('')
    expect(begin.uri).toContain(`secret=${secret}`)
    expect(await call('totpBegin')).toEqual({ ok: false, error: 'link-used' })
    // the secret never shows up in the state or a push
    expect(JSON.stringify(await call('getState'))).not.toContain(secret)
    expect(JSON.stringify(win.sent)).not.toContain(secret)
    clock.now += 1500
    const wrong = totpAt(secret, clock.now) === '000000' ? '111111' : '000000'
    expect((await call('totpConfirm', { code: wrong })).ok).toBe(false)
    clock.now += 1500
    const linked = await call('totpConfirm', { code: totpAt(secret, clock.now) })
    expect(linked.ok).toBe(true)
    expect((linked.state as { totp: unknown; linkUntil: unknown }).totp).toMatchObject({ linked: true, lost: false })
    expect((linked.state as { linkUntil: unknown }).linkUntil).toBeNull()
    const rec = file(dir)
    expect(rec.totp.wrap).toBe('dpapi')
    expect(rec.totp.secret).toBeUndefined()
    expect(nodeFs.readFileSync(nodePath.join(dir, 'dev-access.json'), 'utf8')).not.toContain(secret)
    // lock, then 6 digits of a later step unlock; the same code again is a replay
    await call('lock')
    clock.now += 31_000
    const six = totpAt(secret, clock.now)
    const viaTotp = await call('unlock', { code: six })
    expect(viaTotp).toMatchObject({ ok: true })
    expect((viaTotp.state as { method: string; linkUntil: unknown }).method).toBe('totp')
    expect((viaTotp.state as { linkUntil: unknown }).linkUntil).toBeNull() // 6 digits never open a link window
    await call('lock')
    clock.now += 1500
    expect(await call('unlock', { code: six })).toMatchObject({ ok: false, error: 'totp-replay' })
    // the log names operations, never codes or secrets
    const log = nodeFs.readFileSync(nodePath.join(dir, 'logs', 'devaccess.log'), 'utf8')
    expect(log).toContain('unlock code ok')
    expect(log).not.toContain(secret)
    expect(log).not.toContain(six)
    expect(log).not.toContain(dc)
  })

  it('five wrong 6-digit codes wait 5 minutes (codes are not counted)', async () => {
    const { dir, call, clock } = boot()
    const dc = String((await call('getState')).deviceCode)
    await call('unlock', { code: makeCode(dc) })
    const secret = ((await call('totpBegin')).secretGroups as string[]).join('')
    clock.now += 1500
    await call('totpConfirm', { code: totpAt(secret, clock.now) })
    await call('lock')
    let last: Record<string, unknown> = {}
    for (let i = 0; i < 5; i++) {
      clock.now += 1500
      const c = totpAt(secret, clock.now, 40) // far away: wrong (not even skew)
      last = await call('unlock', { code: c })
    }
    expect(last).toMatchObject({ ok: false, error: 'totp-wrong' })
    expect(last.waitUntil).toBe(clock.now + 5 * 60_000)
    clock.now += 1500
    expect(await call('unlock', { code: totpAt(secret, clock.now) })).toMatchObject({ ok: false, error: 'wait' })
    expect(file(dir).fails.n).toBe(5)
    // an SV1 code still works while waiting (the recovery path)
    clock.now += 1500
    expect((await call('unlock', { code: makeCode(dc, { nowMs: clock.now }) })).ok).toBe(true)
  })

  // Regression: a verified SV1 code proves ownership and clears the wait, otherwise the authenticator could never be
  // (re)linked after a wait longer than the 5-minute link window — and the one-time code would be burned.
  it('an SV1 unlock clears the wait of earlier wrong 6-digit codes, so the link window can be used', async () => {
    const { dir, call, clock } = boot()
    const dc = String((await call('getState')).deviceCode)
    await call('unlock', { code: makeCode(dc) })
    const secret = ((await call('totpBegin')).secretGroups as string[]).join('')
    clock.now += 1500
    expect((await call('totpConfirm', { code: totpAt(secret, clock.now) })).ok).toBe(true)
    await call('lock')
    // 5 wrong → wait 5 min; past it, a 6th wrong → wait 10 min (longer than the link window)
    for (let i = 0; i < 5; i++) {
      clock.now += 1500
      await call('unlock', { code: totpAt(secret, clock.now, 40) })
    }
    clock.now += 5 * 60_000 + 1000
    const sixth = await call('unlock', { code: totpAt(secret, clock.now, 40) })
    expect(sixth).toMatchObject({ ok: false, error: 'totp-wrong', waitUntil: clock.now + 10 * 60_000 })
    expect(file(dir).fails.n).toBe(6)
    expect((await call('getState')).waitUntil).toBe(clock.now + 10 * 60_000)
    // the owner's recovery: a new SV1 code (link allowed) → unlocked, the wait is gone (in the file and the state)
    clock.now += 1500
    const ok = await call('unlock', { code: makeCode(dc, { nowMs: clock.now }) })
    expect(ok.ok).toBe(true)
    expect(ok.state).toMatchObject({ access: 'unlocked', method: 'code', waitUntil: null, linkUntil: clock.now + R.LINK_WINDOW_MS })
    expect(file(dir).fails).toEqual({ n: 0, waitUntil: 0 })
    // relinking inside the window now works with the right code
    const again = await call('totpBegin')
    expect(again.ok).toBe(true)
    const secret2 = (again.secretGroups as string[]).join('')
    clock.now += 1500
    const linked = await call('totpConfirm', { code: totpAt(secret2, clock.now) })
    expect(linked).toMatchObject({ ok: true })
    expect((linked.state as { totp: unknown }).totp).toMatchObject({ linked: true, lost: false })
    // and the new secret unlocks later
    await call('lock')
    clock.now += 31_000
    expect(await call('unlock', { code: totpAt(secret2, clock.now) })).toMatchObject({ ok: true })
  })

  it('keep / cap: setKeep only while unlocked, never past a code\'s max days; unlink only while unlocked', async () => {
    const { call, clock } = boot()
    const dc = String((await call('getState')).deviceCode)
    expect(await call('setKeep', { days: 30 })).toEqual({ ok: false, error: 'locked' })
    expect(await call('totpRemove')).toEqual({ ok: false, error: 'locked' })
    await call('unlock', { code: makeCode(dc, { maxDays: 2, link: false }) })
    const st = await call('getState')
    expect(st).toMatchObject({ access: 'unlocked', until: T0 + 2 * R.DAY_MS, capUntil: T0 + 2 * R.DAY_MS, linkUntil: null })
    expect(await call('setKeep', { days: 0 })).toEqual({ ok: false, error: 'cap' })
    expect(((await call('setKeep', { days: 30 })).state as { until: number }).until).toBe(T0 + 2 * R.DAY_MS)
    expect(((await call('setKeep', { days: 1 })).state as { until: number; keepDays: number }).until).toBe(clock.now + R.DAY_MS)
    expect(await call('setKeep', { days: 5 })).toEqual({ ok: false, error: 'bad-days' })
    expect((await call('totpRemove')).ok).toBe(true)
  })

  it('expiry and the clock going back lock and push the reason; minimize ends a link window', async () => {
    const { call, clock, win, d } = boot()
    const dc = String((await call('getState')).deviceCode)
    await call('setKeep', { days: 1 }) // locked: refused, keepDays stays 7
    await call('unlock', { code: makeCode(dc) })
    expect(d.state().linkUntil).toBe(T0 + R.LINK_WINDOW_MS)
    win.emit('minimize')
    expect(d.state().linkUntil).toBeNull()
    expect(await call('totpBegin')).toEqual({ ok: false, error: 'link-window' })
    clock.now += 7 * R.DAY_MS + 1
    power.emit('resume')
    expect((await call('getState')).access).toBe('locked')
    expect(win.sent.some((s) => s.channel === 'devAccess:state' && s.state.reason === 'expired')).toBe(true)
    // clock back
    clock.now += 1500
    await call('unlock', { code: makeCode(dc, { nowMs: clock.now }) })
    clock.now -= 10 * 60_000
    expect((await call('getState')).access).toBe('locked')
    expect(win.sent.some((s) => s.state.reason === 'clock-back')).toBe(true)
  })

  it('restart: a code unlock survives (re-verified); a dropped key locks it; a lost Windows key shows "lost"', async () => {
    const first = boot()
    const dc = String((await first.call('getState')).deviceCode)
    await first.call('unlock', { code: makeCode(dc) })
    const secret = ((await first.call('totpBegin')).secretGroups as string[]).join('')
    first.clock.now += 1500
    await first.call('totpConfirm', { code: totpAt(secret, first.clock.now) })
    first.d.dispose()
    handlers.clear()
    const again = boot({ dir: first.dir, clock: first.clock })
    expect(again.d.initialArg()).toBe('--bdp-dev-access=unlocked')
    expect((await again.call('getState')).deviceCode).toBe(dc)
    again.d.dispose()
    handlers.clear()
    const dropped = boot({ dir: first.dir, clock: first.clock, pins: [] })
    expect(dropped.d.initialArg()).toBe('--bdp-dev-access=locked')
    dropped.d.dispose()
    handlers.clear()
    safeState.broken = true
    const lost = boot({ dir: first.dir, clock: first.clock })
    const st = await lost.call('getState')
    expect(st.totp).toMatchObject({ linked: false, lost: true })
    lost.clock.now += 1500
    expect(await lost.call('unlock', { code: totpAt(secret, lost.clock.now) })).toMatchObject({ ok: false, error: 'totp-lost' })
  })

  it('a damaged file is set aside (dev-access.bad.json) and a new device is made', async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(root, 'bad-'))
    nodeFs.writeFileSync(nodePath.join(dir, 'dev-access.json'), '{"v":1,"device":"nope"}')
    const { call } = boot({ dir })
    expect((await call('getState')).access).toBe('locked')
    expect(nodeFs.existsSync(nodePath.join(dir, 'dev-access.bad.json'))).toBe(true)
    expect(file(dir).device).toHaveLength(43)
  })

  it('build-opened: access build, nothing written, unlock not needed, keep / link refused', async () => {
    const { dir, d, call } = boot({ buildOpen: true })
    expect(d.initialArg()).toBe('--bdp-dev-access=build')
    expect((await call('getState')).access).toBe('build')
    expect(nodeFs.existsSync(nodePath.join(dir, 'dev-access.json'))).toBe(false)
    expect(await call('unlock', { code: '123456' })).toMatchObject({ ok: true })
    expect(await call('setKeep', { days: 1 })).toEqual({ ok: false, error: 'build' })
    expect(await call('totpBegin')).toEqual({ ok: false, error: 'build' })
    expect(nodeFs.existsSync(nodePath.join(dir, 'dev-access.json'))).toBe(false)
  })

  it('Mac / other: the authenticator secret is stored plainly (0600), never through safeStorage', async () => {
    const { dir, call, clock } = boot({ platform: 'darwin' })
    const dc = String((await call('getState')).deviceCode)
    await call('unlock', { code: makeCode(dc) })
    const secret = ((await call('totpBegin')).secretGroups as string[]).join('')
    clock.now += 1500
    expect((await call('totpConfirm', { code: totpAt(secret, clock.now) })).ok).toBe(true)
    expect(file(dir).totp).toMatchObject({ wrap: 'none', secret })
  })
})

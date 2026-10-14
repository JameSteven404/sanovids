// A fake Electron for electron/seedvis.cjs (no Electron, no network, no real profile): ipcMain, an in-memory session
// with its permission handlers and webRequest hooks, net.request with scripted answers and upload progress,
// safeStorage (reversible, with unavailable / failing / hanging modes), the clipboard, the dialog, shell and app.
// Every request goes through the session's webRequest hooks first, like Chromium does: a cancelled one fails with
// net::ERR_BLOCKED_BY_CLIENT, and the headers the "server" sees are the ones left after onBeforeSendHeaders.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import mainSource from '../../../../electron/main.cjs?raw'

const require = createRequire(import.meta.url)
/** The CommonJS modules and Electron objects are untyped: tests treat them as any. */
export type Any = any

export const seedvisModule = require('../../../../electron/seedvis.cjs') as {
  setupSeedvis: (deps: Any) => { inFlightSubmits(): number; closeGuard(event: Any, o: Any): boolean; dispose(): void }
  CHANNELS: readonly string[]
  QUIT_GRACE_MS: number
}
export const rules = require('../../../../electron/seedvis-rules.cjs') as Any
export const keyRules = require('../../../../electron/seedvis-key-rules.cjs') as Any

/** main.cjs createDownloadPump, from its <canvasapp-downloads> block run as-is (the pump seedvis.cjs is given). */
export function mainPump(): Any {
  const m = /\/\/ <canvasapp-downloads>[^\n]*\n([\s\S]*?)\/\/ <\/canvasapp-downloads>/.exec(mainSource)
  if (!m) throw new Error('canvasapp-downloads block not found in electron/main.cjs')
  return new Function(`${m[1]}\nreturn createDownloadPump`)()
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
export async function settle(times = 6) {
  for (let i = 0; i < times; i++) await flush()
}

// ---------------------------------------------------------------------------------------------------------------
// net
// ---------------------------------------------------------------------------------------------------------------

export interface SeenRequest {
  method: string
  url: string
  /** Headers as the server receives them (after onBeforeSendHeaders). */
  headers: Record<string, string>
  body: Buffer
  options: Any
}

/** The incoming message of an answer: a byte stream with statusCode / headers (lower-case names). */
export function incoming(status: number, headers: Record<string, string>, chunks: (string | Uint8Array)[] = []): Any {
  const r = new Readable({ read() {} }) as Any
  r.statusCode = status
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  setImmediate(() => {
    for (const c of chunks) r.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c))
    r.push(null)
  })
  return r
}

export const jsonAnswer = (status: number, json: unknown, headers: Record<string, string> = {}) =>
  incoming(status, { 'content-type': 'application/json', ...headers }, [JSON.stringify(json)])

/**
 * The server's control over one request: answer, fail, redirect, report upload progress. `progress` sets what
 * getUploadProgress() returns from now on (null = the loader reports nothing).
 */
export interface Ctl {
  req: SeenRequest
  reply(res: Any): void
  fail(message: string): void
  redirect(url: string, status?: number): void
  progress(p: { active: boolean; started: boolean; current: number; total: number } | null): void
  /** Resolves when the client aborts this request. */
  aborted: Promise<void>
  isAborted(): boolean
  followed: string[]
}

export type Server = (ctl: Ctl) => void | Promise<void>

export class FakeClientRequest extends EventEmitter {
  headers: Record<string, string> = {}
  aborted = false
  private prog: Any = null
  private onAbort: () => void = () => undefined
  followed: string[] = []
  private redirectWaiter: ((follow: boolean) => void) | null = null
  constructor(
    public options: Any,
    private net: FakeNet,
  ) {
    super()
  }
  setHeader(name: string, value: string) {
    this.headers[name] = String(value)
  }
  getUploadProgress() {
    return this.prog ? { ...this.prog } : { active: false, started: false, current: 0, total: 0 }
  }
  followRedirect() {
    const w = this.redirectWaiter
    this.redirectWaiter = null
    if (w) w(true)
  }
  abort() {
    if (this.aborted) return
    this.aborted = true
    this.onAbort()
    setImmediate(() => this.emit('abort'))
  }
  end(body?: Uint8Array) {
    void this.run(body ? Buffer.from(body) : Buffer.alloc(0))
  }
  private async run(body: Buffer) {
    await flush()
    let url = String(this.options.url)
    const method = String(this.options.method || 'GET').toUpperCase()
    // every hop goes through the session's webRequest hooks
    for (let hop = 0; hop < 10; hop++) {
      const ses = this.options.session as FakeSession
      const verdict = ses.beforeRequest({ url, method })
      if (verdict.cancel) {
        this.net.blocked.push({ method, url })
        this.emit('error', new Error('net::ERR_BLOCKED_BY_CLIENT'))
        return
      }
      const headers = ses.beforeSendHeaders({ url, method, requestHeaders: { ...this.headers } })
      const seen: SeenRequest = { method, url, headers, body, options: this.options }
      this.net.seen.push(seen)
      let resolveAbort: () => void = () => undefined
      const aborted = new Promise<void>((resolve) => (resolveAbort = resolve))
      this.onAbort = resolveAbort
      if (this.aborted) resolveAbort()
      let next: string | null = null
      let decided = false
      const ctl: Ctl = {
        req: seen,
        reply: (res) => {
          if (this.aborted || decided) return
          decided = true
          this.emit('response', res)
        },
        fail: (message) => {
          if (this.aborted || decided) return
          decided = true
          this.emit('error', new Error(message))
          this.emit('close')
        },
        redirect: (to, status = 302) => {
          if (this.aborted || decided) return
          decided = true
          next = to
          this.emit('redirect', status, method, to, {})
        },
        progress: (p) => {
          this.prog = p
        },
        aborted,
        isAborted: () => this.aborted,
        followed: this.followed,
      }
      const following = new Promise<boolean>((resolve) => (this.redirectWaiter = resolve))
      await this.net.server(ctl)
      if (next === null) return
      const follow = await Promise.race([following, aborted.then(() => false)])
      if (!follow || this.aborted) return
      this.followed.push(next)
      url = next
    }
  }
}

export class FakeNet {
  seen: SeenRequest[] = []
  blocked: { method: string; url: string }[] = []
  requests: FakeClientRequest[] = []
  online = true
  server: Server = (ctl) => ctl.reply(jsonAnswer(200, { success: true, data: {} }))
  request(options: Any) {
    const r = new FakeClientRequest(options, this)
    this.requests.push(r)
    return r
  }
  isOnline() {
    return this.online
  }
}

// ---------------------------------------------------------------------------------------------------------------
// session, ipcMain, safeStorage, clipboard, dialog, shell, app
// ---------------------------------------------------------------------------------------------------------------

export class FakeSession {
  permissionRequest: Any = null
  permissionCheck: Any = null
  devicePermission: Any = null
  private onBefore: Any = null
  private onHeaders: Any = null
  webRequest = {
    onBeforeRequest: (fn: Any) => (this.onBefore = fn),
    onBeforeSendHeaders: (fn: Any) => (this.onHeaders = fn),
  }
  constructor(public partition: string) {}
  setPermissionRequestHandler(fn: Any) {
    this.permissionRequest = fn
  }
  setPermissionCheckHandler(fn: Any) {
    this.permissionCheck = fn
  }
  setDevicePermissionHandler(fn: Any) {
    this.devicePermission = fn
  }
  beforeRequest(details: { url: string; method: string }): { cancel: boolean } {
    let out = { cancel: false }
    if (this.onBefore) this.onBefore(details, (r: { cancel: boolean }) => (out = r))
    return out
  }
  beforeSendHeaders(details: { url: string; method: string; requestHeaders: Record<string, string> }): Record<string, string> {
    let out = details.requestHeaders
    if (this.onHeaders) this.onHeaders(details, (r: { requestHeaders: Record<string, string> }) => (out = r.requestHeaders))
    return out
  }
}

export class FakeIpc {
  handlers = new Map<string, (event: Any, arg?: Any) => Any>()
  handle(channel: string, fn: Any) {
    if (this.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
    this.handlers.set(channel, fn)
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel)
  }
}

export class FakeSender extends EventEmitter {
  constructor(public id: number) {
    super()
  }
}

/** Reversible stand-in for safeStorage: never stores the text as-is (XOR + a header), like the real one. */
export class FakeSafeStorage {
  available = true
  backend = 'gnome_libsecret'
  failDecrypt = false
  failEncrypt = false
  hangEncrypt = false
  hangDecrypt = false
  reEncrypt = false
  encryptCalls = 0
  decryptCalls = 0
  async isAsyncEncryptionAvailable() {
    return this.available
  }
  getSelectedStorageBackend() {
    return this.backend
  }
  async encryptStringAsync(text: string) {
    this.encryptCalls++
    if (this.hangEncrypt) return new Promise<Buffer>(() => undefined)
    if (this.failEncrypt) throw new Error('encryption failed')
    const b = Buffer.from(text, 'utf8')
    return Buffer.concat([Buffer.from('v10'), Buffer.from(b.map((x) => x ^ 0x5a))])
  }
  async decryptStringAsync(bytes: Uint8Array) {
    this.decryptCalls++
    if (this.hangDecrypt) return new Promise<Any>(() => undefined)
    if (this.failDecrypt) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    const b = Buffer.from(bytes)
    if (b.subarray(0, 3).toString() !== 'v10') throw new Error('bad header')
    return { result: Buffer.from(b.subarray(3).map((x) => x ^ 0x5a)).toString('utf8'), shouldReEncrypt: this.reEncrypt }
  }
}

export class FakeClipboard {
  text = ''
  cleared = 0
  readText() {
    return this.text
  }
  writeText(t: string) {
    this.text = t
  }
  clear() {
    this.text = ''
    this.cleared++
  }
}

export class FakeDialog {
  asked: Any[] = []
  answer: () => Promise<{ response: number }> = async () => ({ response: 0 })
  showMessageBox(a: Any, b?: Any) {
    this.asked.push(b === undefined ? { win: null, opts: a } : { win: a, opts: b })
    return this.answer()
  }
}

export class FakeWindow extends EventEmitter {
  destroyed = false
  closes = 0
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.closes++
  }
}

export interface Harness {
  gw: ReturnType<typeof seedvisModule.setupSeedvis>
  ipc: FakeIpc
  net: FakeNet
  ses: FakeSession
  safe: FakeSafeStorage
  clip: FakeClipboard
  dialog: FakeDialog
  opened: string[]
  quits: number
  logs: string[]
  dir: string
  win: FakeWindow
  sender: FakeSender
  /** Calls a channel as the SanoVids page (app://bdp/…) unless `from` says otherwise. */
  call(channel: string, arg?: Any, from?: string): Promise<Any>
  cleanup(): void
}

export interface HarnessOptions {
  platform?: string
  packaged?: boolean
  placement?: string
  dir?: string
  server?: Server
}

/** setupSeedvis with every Electron piece faked and userData in a fresh temp folder (never the real profile). */
export function harness(o: HarnessOptions = {}): Harness {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'sanovids-seedvis-test-'))
  const ipc = new FakeIpc()
  const net = new FakeNet()
  if (o.server) net.server = o.server
  const sessions = new Map<string, FakeSession>()
  const session = {
    fromPartition: (p: string) => {
      if (!sessions.has(p)) sessions.set(p, new FakeSession(p))
      return sessions.get(p)!
    },
  }
  const safe = new FakeSafeStorage()
  const clip = new FakeClipboard()
  const dialog = new FakeDialog()
  const opened: string[] = []
  const logs: string[] = []
  const win = new FakeWindow()
  const sender = new FakeSender(7)
  const h = {
    ipc,
    net,
    safe,
    clip,
    dialog,
    opened,
    quits: 0,
    logs,
    dir,
    win,
    sender,
  } as unknown as Harness
  const electron = {
    ipcMain: ipc,
    net,
    session,
    safeStorage: safe,
    clipboard: clip,
    dialog,
    shell: { openExternal: async (u: string) => void opened.push(u) },
    app: { quit: () => void (h.quits += 1) },
  }
  h.gw = seedvisModule.setupSeedvis({
    electron,
    isAppSender: (event: Any) => String(event && event.senderFrame && event.senderFrame.url).startsWith('app://bdp/'),
    getMainWindow: () => win,
    userDataDir: dir,
    placement: () => o.placement ?? 'installer',
    packaged: o.packaged ?? true,
    platform: o.platform ?? 'win32',
    createPump: mainPump(),
    log: (l: string) => void logs.push(l),
  })
  h.ses = sessions.get(rules.SEEDVIS_PARTITION)!
  h.call = async (channel, arg, from = 'app://bdp/index.html') => {
    const fn = ipc.handlers.get(channel)
    if (!fn) throw new Error(`no handler ${channel}`)
    return fn({ senderFrame: { url: from }, sender }, arg)
  }
  h.cleanup = () => {
    h.gw.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
  return h
}

/**
 * Saves `key` the way a user can while seedvis is unreachable: the field's key check fails with a network error,
 * then "Lưu mà chưa kiểm tra" sends the same key. The failed check is removed from net.seen / net.requests / logs so a
 * test counts only its own requests. → the second setKey answer (or the first one when it did not fail with 'network').
 */
export async function saveKeyUnverified(h: Harness, key: string = FAKE_KEY): Promise<Any> {
  const server = h.net.server
  const counts = { seen: h.net.seen.length, requests: h.net.requests.length, logs: h.logs.length }
  h.net.server = (ctl) => ctl.fail('net::ERR_CONNECTION_RESET')
  try {
    const checked = await h.call('seedvis:setKey', { key })
    if (checked.ok || checked.code !== 'network') return checked
    return await h.call('seedvis:setKey', { key, unverified: true })
  } finally {
    h.net.server = server
    h.net.seen.splice(counts.seen)
    h.net.requests.splice(counts.requests)
    h.logs.splice(counts.logs)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------------------------------------------

/** A key shaped like a real seedvis key — only ever a fake in tests. */
export const FAKE_KEY = 'sv_live_TESTONLYabcdefghijklmnopqrstuvwx0123'
export const OTHER_KEY = 'sv_live_TESTONLYzyxwvutsrqponmlkjihgfedcbA9876'
export const UUID = '407822d1-ff74-44a5-b939-9e563102e770'

/** Minimal valid image bytes (magic numbers + padding). */
export function png(size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(size, 16))
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return b
}
export function jpeg(size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(size, 16))
  b.set([0xff, 0xd8, 0xff, 0xe0])
  return b
}
export function webp(size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(size, 16))
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  return b
}
/** The first bytes of an MP4 (ftyp isom) followed by `size` filler bytes. */
export function mp4(size = 64, brand = 'isom'): Uint8Array {
  const b = new Uint8Array(Math.max(size, 16))
  b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...Buffer.from(brand.padEnd(4, ' '), 'latin1')])
  return b
}

export const seedanceBody = (over: Record<string, unknown> = {}) => ({
  model: 'seedance_2.0_fast',
  mode: 'text-to-video',
  prompt: 'Một con mèo đi dạo trên phố',
  aspect_ratio: '16:9',
  duration: 5,
  count: 1,
  ...over,
})

export const veoBody = (over: Record<string, unknown> = {}) => ({
  model: 'Veo-3.1',
  mode: 'text-to-video',
  prompt: 'A cinematic sunrise over the sea',
  aspect_ratio: '9:16',
  duration: '4s',
  upscale_video: 'none',
  count: 1,
  ...over,
})

export const createReq = (over: Record<string, unknown> = {}) => ({ route: 'generations.create', idempotencyKey: UUID, body: seedanceBody(), ...over })

/** seedvis' documented 202 answer to a submit. */
export const queued202 = (id = 'gen_123') => ({
  success: true,
  status: 202,
  message: null,
  data: {
    id,
    object: 'generation',
    status: 'queued',
    is_final: false,
    model: 'seedance_2.0_fast',
    mode: 'text-to-video',
    next: { action: 'poll', url: `https://seedvis.com/api/v1/developer/generations/${id}?wait=0`, after_seconds: 10 },
    outputs: [],
    references: [],
  },
})

export const completed = (id = 'gen_123', url = 'https://cdn.seedvis.com/result.mp4?Expires=1&Signature=abc') => ({
  success: true,
  status: 200,
  data: {
    id,
    object: 'generation',
    status: 'completed',
    is_final: true,
    next: { action: 'done' },
    outputs: [{ type: 'video', url }],
    references: [],
  },
})

export const accountInfo = (over: Record<string, unknown> = {}) => ({
  success: true,
  status: 200,
  data: {
    id: 42,
    email: 'user@example.com',
    api_enabled: true,
    plan: { code: 'pro', name: 'Pro' },
    credit_balance: 1200,
    rate_limit_per_minute: 120,
    poll_rate_limit_per_minute: 384,
    poll_rate_limit_per_job_per_minute: 20,
    concurrency_limit: 16,
    queue_limit: 32,
    ...over,
  },
})

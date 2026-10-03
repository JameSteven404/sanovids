// electron/updater.cjs end to end, with fake 'electron', 'electron-updater' and './signature.cjs' modules (real files in a
// temp folder, real hashing, the real rules): a refused file is never installed and never downloaded automatically
// again, a verified installer is bound to its content (install now / on quit), an older genuine release offered as a new
// one is refused, and electron-updater's cache is tidied (pending\ after an update, the stale blockmap after a refusal).
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import nodeFs from 'node:fs'
import Module, { createRequire } from 'node:module'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const req = createRequire(import.meta.url)
const rules = req('../../../electron/updater-rules.cjs') as {
  ERROR_TEXT: Record<string, string>
  INSTALLER_MIN_BYTES: number
}

const APP = 'SanoVidsFlowTest'
const PIN = 'A'.repeat(40)
const SIZE = rules.INSTALLER_MIN_BYTES
const HEADER = 1024
/** Whole seconds: Node's utimes keeps them exactly (sub-millisecond parts are rounded), so a restored LastWriteTime is identical. */
const FILE_TIME_S = 1_790_000_000

interface Verdict {
  ok: boolean
  status: string
  reason: string
  timestamped: boolean
  thumbprint?: string
  productVersion?: string
  productName?: string
}
interface FeedInfo {
  version: string
  files: { url: string; sha512: string; size: number }[]
  path: string
  sha512: string
  releaseDate: string
}
interface UpdState {
  status: string
  version?: string
  error?: { code: string; message: string }
}
type Handler = (event: unknown, arg?: unknown) => Promise<{ ok: boolean; code?: string; message?: string } & Partial<UpdState>>
interface Updater {
  onWindowReady(): void
  onQuit(exitCode: number): void
  isQuittingForUpdate(): boolean
}

const signed = (version: string): Verdict => ({ ok: true, status: 'signed', reason: 'ok', timestamped: true, thumbprint: PIN, productVersion: version, productName: APP })
const refusedVerdict = (reason: string, status = 'other-signer'): Verdict => ({ ok: false, status, reason, timestamped: true })

/** An "installer": the fake signature module reads its verdict from the first bytes; `seed` makes the content unique. */
function installer(verdict: Verdict, seed: string, size = SIZE): Buffer {
  const buf = Buffer.alloc(size)
  buf.write(JSON.stringify(verdict), 0, 'utf8')
  buf.write(seed, HEADER, 'utf8')
  return buf
}
const sha = (b: Buffer) => createHash('sha512').update(b).digest('base64')
function feed(version: string, bytes: Buffer, sha512 = sha(bytes)): FeedInfo {
  const url = `${APP}-Setup-${version}.exe`
  return { version, files: [{ url, sha512, size: bytes.length }], path: url, sha512, releaseDate: '2026-10-03T00:00:00.000Z' }
}

// ---- fake modules ----

const appState = { userData: '', version: '0.5.0' }
const appEvents = new EventEmitter()
const handlers = new Map<string, Handler>()
const fakeElectron = {
  app: {
    getPath: () => appState.userData,
    getVersion: () => appState.version,
    getName: () => APP,
    isPackaged: true,
    once: (ev: string, fn: (...a: unknown[]) => void) => appEvents.once(ev, fn),
  },
  ipcMain: { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) },
  powerMonitor: { on: () => undefined, removeListener: () => undefined },
  shell: { openExternal: async () => undefined },
}

const sigState = { pins: [PIN] as string[], calls: [] as string[] }
const fakeSignature = {
  SIGNATURE_TIMEOUT_MS: 60_000,
  readSignerPins: () => [...sigState.pins],
  checkFileSignature: async (file: string): Promise<Verdict> => {
    sigState.calls.push(nodePath.basename(file))
    try {
      const fd = nodeFs.openSync(file, 'r')
      const buf = Buffer.alloc(HEADER)
      nodeFs.readSync(fd, buf, 0, HEADER, 0)
      nodeFs.closeSync(fd)
      return JSON.parse(buf.toString('utf8').replace(/\0+$/, '')) as Verdict
    } catch {
      return { ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false }
    }
  },
}

/** What electron-updater 6.8.10 does around our hooks (NsisUpdater.doDownloadUpdate + AppUpdater.executeDownload). */
class FakeUpdater extends EventEmitter {
  logger: unknown = null
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  allowPrerelease = true
  fullChangelog = true
  disableWebInstaller = false
  disableDifferentialDownload = true
  installerPath: string | null = null
  quitAndInstallCalled = false
  quitAndInstallCalls = 0
  downloadCalls = 0
  cleared = 0
  served: { info: FeedInfo; bytes: Buffer } | null = null
  private hook: ((names: string[], file: string) => Promise<string | null>) | null = null
  declare verifySignature: (file: string) => Promise<string | null>

  constructor(readonly cacheDir: string) {
    super()
  }
  get verifyUpdateCodeSignature() {
    return this.hook
  }
  set verifyUpdateCodeSignature(v) {
    if (v) this.hook = v
  }
  get pending() {
    return nodePath.join(this.cacheDir, 'pending')
  }
  /** clear() calls that do nothing (like the real one while the just-run installer still holds its file: it swallows the error). */
  failingClears = 0
  async getOrCreateDownloadHelper() {
    return {
      cacheDirForPendingUpdate: this.pending,
      clear: async () => {
        this.cleared++
        if (this.failingClears > 0) {
          this.failingClears--
          return
        }
        nodeFs.rmSync(this.pending, { recursive: true, force: true })
        nodeFs.mkdirSync(this.pending, { recursive: true })
      },
    }
  }
  async checkForUpdates() {
    this.emit('checking-for-update')
    if (!this.served) this.emit('update-not-available', {})
    else this.emit('update-available', this.served.info)
    return { isUpdateAvailable: !!this.served }
  }
  async downloadUpdate() {
    this.downloadCalls++
    const { info, bytes } = this.served!
    nodeFs.mkdirSync(this.pending, { recursive: true })
    const temp = nodePath.join(this.pending, `temp-${info.path}`)
    nodeFs.writeFileSync(temp, bytes)
    if (sha(bytes) !== info.files[0].sha512) {
      nodeFs.rmSync(temp, { force: true })
      throw Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' })
    }
    const status = await this.verifySignature(temp)
    if (status != null) {
      nodeFs.rmSync(this.pending, { recursive: true, force: true }) // removeTempDirIfAny → helper.clear()
      throw Object.assign(new Error(`New version ${info.version} is not signed by the application owner: ${status}`), { code: 'ERR_UPDATER_INVALID_SIGNATURE' })
    }
    const final = nodePath.join(this.pending, info.path)
    nodeFs.renameSync(temp, final)
    this.finish(info, final)
    return [final]
  }
  /** An installer already in the cache from an earlier launch (validateDownloadedPath): no hook, straight to done(). */
  serveCached(info: FeedInfo, bytes: Buffer) {
    nodeFs.mkdirSync(this.pending, { recursive: true })
    const final = nodePath.join(this.pending, info.path)
    nodeFs.writeFileSync(final, bytes)
    this.finish(info, final)
  }
  private finish(info: FeedInfo, final: string) {
    nodeFs.utimesSync(final, FILE_TIME_S, FILE_TIME_S)
    this.installerPath = final
    this.emit('update-downloaded', { ...info, downloadedFile: final })
    // done() then copies the new version's blockmap next to the cached installer.exe.
    nodeFs.writeFileSync(nodePath.join(this.cacheDir, 'current.blockmap'), `blockmap ${info.version}`)
  }
  quitAndInstall() {
    this.quitAndInstallCalls++
    this.quitAndInstallCalled = true
  }
}
const fakeUpdaterModule: { autoUpdater: FakeUpdater | null } = { autoUpdater: null }

// ---- module cache plumbing (restored afterwards: other test files load the real modules) ----

const injected: { id: string; previous: NodeModule | undefined }[] = []
function inject(id: string, exports: unknown) {
  const m = new Module(id)
  m.filename = id
  m.loaded = true
  m.exports = exports
  injected.push({ id, previous: req.cache[id] })
  req.cache[id] = m
}

let setupUpdater: (o: { isAppSender: (e: unknown) => boolean; getMainWindow: () => null; profileSource: string }) => Updater
const savedExecPath = process.execPath
const savedPortable = process.env.PORTABLE_EXECUTABLE_FILE
let root = ''

describe.runIf(process.platform === 'win32')('updater.cjs flow (fake electron-updater, real files and hashes)', () => {
  beforeAll(() => {
    root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sanovids-updflow-'))
    // An NSIS install: the uninstaller next to the exe → kind 'installer'.
    const installDir = nodePath.join(root, 'install')
    nodeFs.mkdirSync(installDir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(installDir, `Uninstall ${APP}.exe`), 'x')
    process.execPath = nodePath.join(installDir, `${APP}.exe`)
    delete process.env.PORTABLE_EXECUTABLE_FILE
    inject(req.resolve('electron'), fakeElectron)
    inject(req.resolve('electron-updater'), fakeUpdaterModule)
    inject(req.resolve('../../../electron/signature.cjs'), fakeSignature)
    const updaterId = req.resolve('../../../electron/updater.cjs')
    injected.push({ id: updaterId, previous: req.cache[updaterId] })
    delete req.cache[updaterId]
    setupUpdater = (req(updaterId) as { setupUpdater: typeof setupUpdater }).setupUpdater
  })

  afterAll(() => {
    for (const { id, previous } of injected.reverse()) {
      if (previous) req.cache[id] = previous
      else delete req.cache[id]
    }
    process.execPath = savedExecPath
    if (savedPortable !== undefined) process.env.PORTABLE_EXECUTABLE_FILE = savedPortable
    nodeFs.rmSync(root, { recursive: true, force: true })
  })

  afterEach(() => {
    sigState.pins = [PIN]
    sigState.calls = []
    handlers.clear()
    appEvents.removeAllListeners()
    appState.version = '0.5.0'
  })

  let n = 0
  function boot(o: { userData?: string; updaterJson?: unknown; version?: string; failingClears?: number; pendingClearRetryMs?: number[] } = {}) {
    const userData = o.userData ?? nodeFs.mkdtempSync(nodePath.join(root, `p${++n}-`))
    if (o.updaterJson !== undefined) nodeFs.writeFileSync(nodePath.join(userData, 'updater.json'), JSON.stringify(o.updaterJson))
    appState.userData = userData
    if (o.version) appState.version = o.version
    const au = new FakeUpdater(nodePath.join(userData, 'cache'))
    au.failingClears = o.failingClears ?? 0
    fakeUpdaterModule.autoUpdater = au
    const updater = setupUpdater({
      isAppSender: () => true,
      getMainWindow: () => null,
      profileSource: 'env',
      ...(o.pendingClearRetryMs ? { pendingClearRetryMs: o.pendingClearRetryMs } : {}),
    })
    const invoke = (ch: string, arg?: unknown) => handlers.get(ch)!({ sender: {} }, arg)
    const state = async () => (await invoke('updates:getState')) as UpdState
    const file = (): Record<string, unknown> => {
      const p = nodePath.join(userData, 'updater.json')
      return nodeFs.existsSync(p) ? (JSON.parse(nodeFs.readFileSync(p, 'utf8')) as Record<string, unknown>) : {}
    }
    const log = () => nodeFs.readFileSync(nodePath.join(userData, 'logs', 'updater.log'), 'utf8')
    const settle = (statuses: string[]) => vi.waitFor(async () => expect(statuses).toContain((await state()).status), { timeout: 10_000, interval: 10 })
    return { userData, au, updater, invoke, state, file, log, settle }
  }

  /** A check that finds `info`, then (auto-download on) the download and every check after it. */
  async function checkAndSettle(b: ReturnType<typeof boot>) {
    expect((await b.invoke('updates:check')).ok).toBe(true)
    await b.settle(['ready', 'error'])
    return b.state()
  }

  it('a genuine installer: verified twice (hook + update-downloaded), ready, installs on quit while intact', async () => {
    const b = boot()
    const bytes = installer(signed('0.5.1'), 'genuine 0.5.1')
    b.au.served = { info: feed('0.5.1', bytes), bytes }
    const s = await checkAndSettle(b)
    expect(s).toMatchObject({ status: 'ready', version: '0.5.1' })
    expect(s.error).toBeUndefined()
    expect(sigState.calls).toEqual([`temp-${APP}-Setup-0.5.1.exe`, `${APP}-Setup-0.5.1.exe`])
    expect(b.au.autoInstallOnAppQuit).toBe(true)
    expect(b.log()).toContain('signature verified 0.5.1')
    b.updater.onQuit(0)
    expect(b.au.autoInstallOnAppQuit).toBe(true)
    expect(b.file().attempt).toMatchObject({ version: '0.5.1', from: '0.5.0' })
    expect(b.log()).toContain('install on quit 0.5.1')
  })

  it('install on quit: same size, LastWriteTime put back, other bytes → nothing installs, the stale blockmap goes', async () => {
    const b = boot()
    const bytes = installer(signed('0.5.1'), 'genuine 0.5.1')
    b.au.served = { info: feed('0.5.1', bytes), bytes }
    expect((await checkAndSettle(b)).status).toBe('ready')
    const target = b.au.installerPath!
    const st = nodeFs.statSync(target)
    const evil = installer(signed('0.5.1'), 'evil, same size') // still "signed" by its header: only the hash can tell
    nodeFs.writeFileSync(target, evil)
    nodeFs.utimesSync(target, FILE_TIME_S, FILE_TIME_S) // the LastWriteTime put back, exactly
    expect(nodeFs.statSync(target).mtimeMs).toBe(st.mtimeMs)
    expect(nodeFs.existsSync(nodePath.join(b.au.cacheDir, 'current.blockmap'))).toBe(true)
    b.updater.onQuit(0)
    expect(b.au.autoInstallOnAppQuit).toBe(false)
    expect(b.file().attempt).toBeUndefined()
    expect(b.log()).toContain('install on quit skipped: installer not verified')
    expect(nodeFs.existsSync(nodePath.join(b.au.cacheDir, 'current.blockmap'))).toBe(false)
  })

  it('a quit with a non-zero exit code never hashes or installs, and keeps the verified installer', async () => {
    const b = boot()
    const bytes = installer(signed('0.5.1'), 'genuine 0.5.1')
    b.au.served = { info: feed('0.5.1', bytes), bytes }
    expect((await checkAndSettle(b)).status).toBe('ready')
    b.updater.onQuit(1)
    expect(b.au.autoInstallOnAppQuit).toBe(true) // electron-updater itself skips exit code ≠ 0
    expect(b.file().attempt).toBeUndefined()
  })

  it('"Khởi động lại để cập nhật": re-verified, then quitAndInstall', async () => {
    const b = boot()
    const bytes = installer(signed('0.5.1'), 'genuine 0.5.1')
    b.au.served = { info: feed('0.5.1', bytes), bytes }
    expect((await checkAndSettle(b)).status).toBe('ready')
    expect(await b.invoke('updates:install')).toEqual({ ok: true })
    await new Promise((r) => setImmediate(r))
    expect(b.au.quitAndInstallCalls).toBe(1)
    expect(sigState.calls).toHaveLength(3) // hook, update-downloaded, install
    expect(b.file().attempt).toMatchObject({ version: '0.5.1' })
    expect(b.updater.isQuittingForUpdate()).toBe(true)
  })

  it('"Khởi động lại": a file swapped after the async re-check never runs (synchronous re-hash before quitAndInstall)', async () => {
    const b = boot()
    const bytes = installer(signed('0.5.1'), 'genuine 0.5.1')
    b.au.served = { info: feed('0.5.1', bytes), bytes }
    expect((await checkAndSettle(b)).status).toBe('ready')
    const target = b.au.installerPath!
    expect(await b.invoke('updates:install')).toEqual({ ok: true })
    // Between the reply and main's setImmediate: same size and mtime, other bytes.
    const st = nodeFs.statSync(target)
    const evil = installer(signed('0.5.1'), 'swapped in time')
    nodeFs.writeFileSync(target, evil)
    nodeFs.utimesSync(target, FILE_TIME_S, FILE_TIME_S) // the LastWriteTime put back, exactly
    await new Promise((r) => setImmediate(r))
    expect(b.au.quitAndInstallCalls).toBe(0)
    expect(b.updater.isQuittingForUpdate()).toBe(false)
    expect(await b.state()).toMatchObject({ status: 'error', error: { code: 'signature', message: rules.ERROR_TEXT.signature } })
    expect(nodeFs.existsSync(target)).toBe(false)
    expect(b.au.autoInstallOnAppQuit).toBe(false)
    expect(b.file().attempt).toBeUndefined()
    expect(b.file().rejected).toEqual([expect.objectContaining({ version: '0.5.1', sha512: sha(evil), reason: 'changed' })])
    expect(b.log()).toContain('install refused: the installer changed after its check')
  })

  it('another signer: refused in the hook, remembered by checksum, never downloaded automatically again; "Thử lại" retries', async () => {
    const b = boot()
    const bytes = installer(refusedVerdict('other-signer'), 'impostor 0.5.2')
    b.au.served = { info: feed('0.5.2', bytes), bytes }
    const s = await checkAndSettle(b)
    expect(s).toMatchObject({ status: 'error', version: '0.5.2', error: { code: 'signature', message: rules.ERROR_TEXT.signature } })
    expect(nodeFs.existsSync(b.au.pending) ? nodeFs.readdirSync(b.au.pending) : []).toEqual([])
    expect(b.file().rejected).toEqual([expect.objectContaining({ version: '0.5.2', sha512: sha(bytes), reason: 'other-signer' })])
    expect(b.au.downloadCalls).toBe(1)
    // Checked again: the same file is not downloaded, the error stays.
    expect((await b.invoke('updates:check')).ok).toBe(true)
    await b.settle(['error'])
    expect(b.au.downloadCalls).toBe(1)
    expect(await b.state()).toMatchObject({ status: 'error', error: { code: 'signature' } })
    expect(b.log()).toContain('auto-download skipped 0.5.2: this file was refused before (other-signer, 0.5.2)')
    // "Thử lại": forgotten, downloaded and checked again (and refused again).
    expect(await b.invoke('updates:download')).toEqual({ ok: true })
    await vi.waitFor(() => expect(b.au.downloadCalls).toBe(2), { timeout: 10_000, interval: 10 })
    await b.settle(['error'])
    expect(b.log()).toContain('retry 0.5.2: the refused file is downloaded and checked again')
    expect(b.file().rejected).toHaveLength(1)
  })

  it('across launches: the refused file stays refused; a re-uploaded correct file of the same version downloads', async () => {
    const first = boot()
    const bad = installer(refusedVerdict('not-signed', 'unsigned'), 'unsigned 0.5.2')
    first.au.served = { info: feed('0.5.2', bad), bytes: bad }
    expect((await checkAndSettle(first)).error?.code).toBe('signature')
    // Next launch, same data folder.
    const next = boot({ userData: first.userData })
    next.au.served = { info: feed('0.5.2', bad), bytes: bad }
    expect((await checkAndSettle(next)).error?.code).toBe('signature')
    expect(next.au.downloadCalls).toBe(0)
    // The author fixes the release: same version, another (genuine) file.
    const good = installer(signed('0.5.2'), 'genuine 0.5.2')
    next.au.served = { info: feed('0.5.2', good), bytes: good }
    expect((await checkAndSettle(next)).status).toBe('ready')
    expect(next.au.downloadCalls).toBe(1)
  })

  it('an older genuine release offered as a newer version → refused (wrong-version), never installed', async () => {
    const b = boot()
    const old = installer(signed('0.4.2'), 'genuine 0.4.2')
    b.au.served = { info: feed('9.9.9', old), bytes: old }
    const s = await checkAndSettle(b)
    expect(s).toMatchObject({ status: 'error', version: '9.9.9', error: { code: 'signature' } })
    expect(b.log()).toMatch(/signature wrong-version: file says SanoVidsFlowTest 0\.4\.2, offered 9\.9\.9, running 0\.5\.0/)
    expect(b.file().rejected).toEqual([expect.objectContaining({ reason: 'wrong-version' })])
    // A genuine but too small signed file (the uninstaller) offered as the update.
    const c = boot()
    const small = installer(signed('0.5.1'), 'uninstaller', 400_000)
    c.au.served = { info: feed('0.5.1', small), bytes: small }
    expect((await checkAndSettle(c)).error?.code).toBe('signature')
    expect(c.log()).toContain('signature not-installer')
  })

  it('the check could not decide (PowerShell in ConstrainedLanguage) → signature-unverified, retried a day later', async () => {
    const b = boot()
    const bytes = installer({ ok: false, status: 'unknown', reason: 'policy', timestamped: false }, 'genuine but not checkable')
    b.au.served = { info: feed('0.5.1', bytes), bytes }
    const s = await checkAndSettle(b)
    expect(s.error).toEqual({ code: 'signature-unverified', message: rules.ERROR_TEXT['signature-unverified'] })
    expect(b.file().rejected).toEqual([expect.objectContaining({ reason: 'policy' })])
    expect((await b.invoke('updates:check')).ok).toBe(true)
    await b.settle(['error'])
    expect(b.au.downloadCalls).toBe(1) // not again within the day
    // A launch more than a day later tries again.
    const later = boot({ updaterJson: { v: 1, autoDownload: true, rejected: [{ version: '0.5.1', sha512: sha(bytes), reason: 'policy', at: Date.now() - 25 * 60 * 60_000 }] } })
    later.au.served = { info: feed('0.5.1', bytes), bytes }
    await checkAndSettle(later)
    expect(later.au.downloadCalls).toBe(1)
  })

  it('a cached installer (no hook) that fails on update-downloaded: deleted, blockmap dropped, no install on quit', async () => {
    const tampered = installer(refusedVerdict('hash-mismatch', 'tampered'), 'tampered 0.5.1')
    const c = boot()
    c.au.serveCached(feed('0.5.1', tampered), tampered)
    await c.settle(['error'])
    expect(await c.state()).toMatchObject({ error: { code: 'signature' } })
    expect(nodeFs.existsSync(nodePath.join(c.au.pending, `${APP}-Setup-0.5.1.exe`))).toBe(false)
    expect(nodeFs.existsSync(nodePath.join(c.au.cacheDir, 'current.blockmap'))).toBe(false)
    expect(c.au.autoInstallOnAppQuit).toBe(false)
    c.updater.onQuit(0)
    expect(c.au.autoInstallOnAppQuit).toBe(false)
  })

  it('a downloaded file the feed did not announce (checksum) → refused as changed', async () => {
    const b = boot()
    const bytes = installer(signed('0.5.1'), 'genuine 0.5.1')
    const other = installer(signed('0.5.1'), 'another file')
    b.au.serveCached(feed('0.5.1', other, sha(other)), bytes) // announced: `other`; on disk: `bytes`
    await b.settle(['error'])
    expect(await b.state()).toMatchObject({ error: { code: 'signature' } })
    expect(b.log()).toContain('(sanovids-signature:changed)')
  })

  it('just updated: pending\\ is cleared once at startup, before any download', async () => {
    const userData = nodeFs.mkdtempSync(nodePath.join(root, 'upd-'))
    const pending = nodePath.join(userData, 'cache', 'pending')
    nodeFs.mkdirSync(pending, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(pending, `${APP}-Setup-0.5.0.exe`), 'old installer')
    const b = boot({ userData, version: '0.5.0', updaterJson: { v: 1, autoDownload: true, attempt: { version: '0.5.0', from: '0.4.9', at: Date.now() - 60_000 } } })
    await vi.waitFor(() => expect(b.au.cleared).toBe(1), { timeout: 5000, interval: 5 })
    expect(nodeFs.readdirSync(pending)).toEqual([])
    expect(b.log()).toContain('pending update files cleared after the update')
    expect(b.file().attempt).toBeUndefined()
    // No notice → no clearing.
    const plain = boot()
    await new Promise((r) => setTimeout(r, 20))
    expect(plain.au.cleared).toBe(0)
  })

  it('just updated, the installer that just ran still holds its file: the clear is checked and retried', async () => {
    const justUpdated = { v: 1, autoDownload: true, attempt: { version: '0.5.0', from: '0.4.9', at: Date.now() - 60_000 } }
    const prepare = () => {
      const userData = nodeFs.mkdtempSync(nodePath.join(root, 'updr-'))
      const pending = nodePath.join(userData, 'cache', 'pending')
      nodeFs.mkdirSync(pending, { recursive: true })
      nodeFs.writeFileSync(nodePath.join(pending, `${APP}-Setup-0.5.0.exe`), 'old installer')
      return { userData, pending }
    }
    // First clear does nothing (file locked, error swallowed) → retried → emptied.
    const one = prepare()
    const b = boot({ userData: one.userData, version: '0.5.0', updaterJson: justUpdated, failingClears: 1, pendingClearRetryMs: [30, 30] })
    await vi.waitFor(() => expect(b.log()).toContain('pending update files cleared after the update'), { timeout: 5000, interval: 5 })
    expect(b.au.cleared).toBe(2)
    expect(nodeFs.readdirSync(one.pending)).toEqual([])
    expect(b.log()).toContain(`pending update files not cleared yet (${APP}-Setup-0.5.0.exe): retry in 0 s`)
    // Never clears forever: gives up after the last delay.
    const two = prepare()
    const g = boot({ userData: two.userData, version: '0.5.0', updaterJson: justUpdated, failingClears: 9, pendingClearRetryMs: [20] })
    await vi.waitFor(() => expect(g.log()).toContain('pending update files not cleared (gave up)'), { timeout: 5000, interval: 5 })
    expect(g.au.cleared).toBe(2)
    expect(nodeFs.readdirSync(two.pending)).toEqual([`${APP}-Setup-0.5.0.exe`])
    // A retry never runs under a download (electron-updater writes its temp file in pending\).
    const three = prepare()
    const d = boot({ userData: three.userData, version: '0.5.0', updaterJson: justUpdated, failingClears: 1, pendingClearRetryMs: [2000] }) // far beyond the check below starting
    await vi.waitFor(() => expect(d.log()).toContain('pending update files not cleared yet'), { timeout: 5000, interval: 5 })
    const bytes = installer(signed('0.5.1'), 'genuine 0.5.1')
    d.au.served = { info: feed('0.5.1', bytes), bytes }
    expect((await checkAndSettle(d)).status).toBe('ready')
    await vi.waitFor(() => expect(d.log()).toContain('pending update files left to electron-updater'), { timeout: 20_000, interval: 5 })
    expect(d.au.cleared).toBe(1)
    expect(nodeFs.existsSync(nodePath.join(d.au.pending, `${APP}-Setup-0.5.1.exe`))).toBe(true)
  }, 40_000)

  it('no pinned signer: nothing downloads, the error says the check could not run', async () => {
    sigState.pins = []
    const b = boot()
    const bytes = installer(signed('0.5.1'), 'genuine 0.5.1')
    b.au.served = { info: feed('0.5.1', bytes), bytes }
    const s = await checkAndSettle(b)
    expect(s.error?.code).toBe('signature-unverified')
    expect(b.au.downloadCalls).toBe(0)
    expect(await b.invoke('updates:download')).toMatchObject({ ok: false, code: 'signature-unverified' })
  })
})

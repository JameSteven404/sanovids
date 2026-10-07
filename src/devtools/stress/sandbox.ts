// The in-app sandbox of a stress run: the user's project is saved and put aside, the run works on a temporary project
// of its own ("Thử nghiệm giới hạn <seed>", stored like any project so the real autosave / engine code runs), and
// everything is put back at the end — even after an error or the "Dừng" button:
//   • the user's project is reopened (switchProject) and the temporary one deleted with its videos (deleteProject +
//     the videos its takes stored during the run, see forgetMedia);
//   • the UI layout and the auto-download switch come back as they were; folder saves the temporary project left
//     waiting are forgotten;
//   • the app's own dev server / providers come back (session.ts).
// While it runs, guards block what a stress run must never do: requests to the internet (fetch / XHR / WebSocket /
// EventSource / sendBeacon outside this page's origin), new windows, file downloads, file / folder pickers and File
// System Access writes, confirm / alert / prompt dialogs. Every patched property is put back exactly as it was (an
// own property restored with its descriptor, an inherited one removed again), also when the run throws.
// Watchers keep the run on its own data: a folder node of the temporary project never keeps a real folder (a picked
// one is dropped at once: nothing is ever written there), choosing canvasapp.io.vn is undone and stops the run, and
// opening another project stops the run at once (the session's providers go first, so that project's queue never
// meets them; the runner never touches a project it did not load).
// Crash safety (manifest.ts): RUN_LOCK + the manifest 'bdp:stress:session'; 'bdp:active' stays on the user's project,
// and the next start removes what a run that never finished left behind.
import { DOWNLOAD_PREFS_KEY, useDownloadPrefs } from '../../lib/downloads'
import { activeProviderId, useProviderPrefs } from '../../providers'
import { refreshRealCredits } from '../../store/credits'
import { flush, importProjectFile, useSave } from '../../store/persist'
import { clearHistory, useProject } from '../../store/project'
import { currentRestartWork, onRunEvent, useRuns } from '../../store/runs'
import { toast } from '../../store/ui'
import {
  cleanupLeftovers as cleanupLeftoversWhen,
  forgetFolderSaves,
  forgetMedia,
  leftover,
  pinActiveProject,
  readManifest,
  rememberFolderIds,
  restoreUiLayout,
  restoreUser,
  uiLayout,
  updateManifest,
  withRunLock,
  writeManifest,
  type Manifest,
} from './manifest'
import { runStress } from './runner'
import { sessionActive, stopActiveSession } from './session'
import type { GeneratedProject } from './synth'
import type { StressEnv, StressOptions, StressReport, Violation } from './types'

export { lastReportSummary, leftover, rememberReport, MANIFEST_KEY, LAST_REPORT_KEY } from './manifest'

/** How long the end-of-run drain may wait in the app (real time). */
export const APP_DRAIN_MS = 60_000
/** Heartbeat of the manifest (only read where Web Locks are missing). */
const BEAT_MS = 10_000

/** A run of this window is going on (from the lock to the end of the clean-up). */
let running = false

/** Why a run cannot start now (Vietnamese), or null. */
export function startBlockedReason(): string | null {
  return blockedReason(false)
}

/** `locked`: asked by the run itself, which holds RUN_LOCK and wrote its manifest. */
function blockedReason(locked: boolean): string | null {
  if (activeProviderId() !== 'dev') return 'Chỉ chạy ở chế độ Phát triển (giả lập). Đang chọn canvasapp.io.vn thật trong Cài đặt — đổi về Phát triển rồi thử lại.'
  if (!locked && (running || sessionActive())) return 'Đang có một lần thử nghiệm chạy.'
  const save = useSave.getState()
  if (!save.ready) return 'Dự án chưa mở xong.'
  if (save.stale) return 'Dự án đang mở đã cũ (một tab khác lưu bản mới hơn). Tải lại trang trước.'
  // Real work of the open project (queued, being sent, running, downloading): never while it is in flight.
  const w = currentRestartWork()
  if (w.queued + w.processing > 0) return `Dự án của bạn còn ${w.queued + w.processing} video đang chờ / đang tạo — đợi xong (hoặc huỷ) rồi chạy thử nghiệm.`
  if (!locked && (leftover() || readManifest())) return 'Còn dữ liệu thử nghiệm của lần trước — bấm “Dọn dữ liệu thử nghiệm” trước.'
  return null
}

/** "Dọn dữ liệu thử nghiệm": remove what a crashed / closed run left behind. */
export function cleanupLeftovers(): Promise<string> {
  return cleanupLeftoversWhen(() => running || sessionActive())
}

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

export interface Guards {
  counters: Record<string, number>
  trips: Violation[]
  errors: string[]
  /** Put every patched property back (idempotent, never throws). */
  remove(): void
}

function sameOrigin(url: string): boolean {
  try {
    const u = new URL(url, location.href)
    if (u.protocol === 'blob:' || u.protocol === 'data:') return true
    return u.origin === location.origin
  } catch {
    return true // relative / unparsable: never leaves the page
  }
}

const REAL_HOSTS = /canvasapp\.io\.vn|seedvis\.com|sepay\.vn/i
const BLOCKED = 'ĐÃ CHẶN trong lúc thử nghiệm giới hạn.'

/**
 * Replace `obj[key]` for the run. The restore puts back exactly what was there: the same own property descriptor, or —
 * when the value was inherited (a prototype method) — no own property at all.
 */
function patch(obj: object, key: string, value: unknown, restore: (() => void)[]) {
  const own = Object.getOwnPropertyDescriptor(obj, key)
  Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: own?.enumerable ?? false })
  restore.push(() => {
    if (own) Object.defineProperty(obj, key, own)
    else delete (obj as Record<string, unknown>)[key]
  })
}

/** Install the guards. Throws (after putting back what it already patched) when one cannot be installed. */
export function installGuards(): Guards {
  const counters: Record<string, number> = {}
  const trips: Violation[] = []
  const errors: string[] = []
  const count = (k: string) => (counters[k] = (counters[k] ?? 0) + 1)
  const restore: (() => void)[] = []
  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    for (const r of restore.reverse()) {
      try {
        r()
      } catch {
        /* keep restoring the others */
      }
    }
  }
  const blockUrl = (url: string, via: string): boolean => {
    if (sameOrigin(url)) return false
    count(`Yêu cầu mạng bị chặn (${via})`)
    if (REAL_HOSTS.test(url)) trips.push({ invariant: 'S4', severity: 'error', kind: 'app', message: `Có yêu cầu tới máy chủ thật (${url.slice(0, 120)}) trong lúc thử nghiệm — đã chặn.` })
    return true
  }
  const w = window as unknown as Record<string, unknown>

  try {
    // network
    const origFetch = window.fetch
    patch(window, 'fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (blockUrl(url, 'fetch')) return Promise.reject(new TypeError(BLOCKED))
      return origFetch.call(window, input, init)
    }) as typeof fetch, restore)
    const origOpen = XMLHttpRequest.prototype.open
    patch(XMLHttpRequest.prototype, 'open', function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      if (blockUrl(String(url), 'XHR')) throw new TypeError(BLOCKED)
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
    }, restore)
    for (const [name, via] of [['WebSocket', 'WebSocket'], ['EventSource', 'EventSource']] as const) {
      const Orig = w[name] as (new (url: string | URL, opts?: unknown) => object) | undefined
      if (typeof Orig !== 'function') continue
      const Guarded = function (url: string | URL, opts?: unknown) {
        if (blockUrl(String(url).replace(/^ws/i, 'http'), via)) throw new TypeError(BLOCKED)
        return new Orig(url, opts)
      }
      Object.setPrototypeOf(Guarded, Orig) // static members (CONNECTING…)
      Guarded.prototype = Orig.prototype
      patch(window, name, Guarded, restore)
    }
    if (typeof navigator.sendBeacon === 'function') {
      const origBeacon = navigator.sendBeacon
      patch(navigator, 'sendBeacon', (url: string | URL, data?: BodyInit | null) => (blockUrl(String(url), 'sendBeacon') ? false : origBeacon.call(navigator, url, data)), restore)
    }
    patch(window, 'open', () => (count('Cửa sổ mới bị chặn'), null), restore)

    // downloads, file / folder pickers, File System Access writes
    const origClick = HTMLAnchorElement.prototype.click
    patch(HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) {
      if (this.hasAttribute('download')) {
        count('Tải file bị chặn')
        return
      }
      return origClick.call(this)
    }, restore)
    for (const name of ['showSaveFilePicker', 'showDirectoryPicker', 'showOpenFilePicker']) {
      if (!(name in w)) continue
      patch(window, name, () => {
        count('Hộp chọn file / thư mục bị chặn')
        return Promise.reject(new DOMException(BLOCKED, 'AbortError'))
      }, restore)
    }
    const FileHandle = w.FileSystemFileHandle as { prototype: object } | undefined
    if (FileHandle?.prototype && 'createWritable' in FileHandle.prototype) {
      patch(FileHandle.prototype, 'createWritable', () => {
        count('Ghi file vào thư mục bị chặn')
        return Promise.reject(new DOMException(BLOCKED, 'NotAllowedError'))
      }, restore)
    }

    // dialogs
    patch(window, 'confirm', () => (count('Hộp xác nhận (trả lời Huỷ)'), false), restore)
    patch(window, 'alert', () => void count('Hộp thông báo'), restore)
    patch(window, 'prompt', () => (count('Hộp nhập'), null), restore)

    // errors (R1)
    const origError = console.error
    patch(console, 'error', (...args: unknown[]) => {
      const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeText(a))).join(' ')
      if (/^Warning:/.test(text)) count('Cảnh báo React (bỏ qua)')
      else errors.push(text)
      origError.apply(console, args)
    }, restore)
    const onError = (e: ErrorEvent) => errors.push(`Lỗi: ${e.message}`)
    const onRejection = (e: PromiseRejectionEvent) => errors.push(`Promise bị từ chối không ai bắt: ${(e.reason as Error)?.message ?? String(e.reason)}`)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    restore.push(() => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    })
  } catch (e) {
    remove()
    throw new Error(`Không cài được rào chắn an toàn (${(e as Error)?.message ?? String(e)}) nên chưa chạy thử nghiệm.`)
  }

  return { counters, trips, errors, remove }
}

function safeText(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// ---------------------------------------------------------------------------------------------
// The app environment
// ---------------------------------------------------------------------------------------------

function appEnv(guards: Guards): StressEnv & { dispose(): void } {
  const longFrames: number[] = []
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (longFrames.length < 500) longFrames.push(Math.round(e.duration))
    })
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    observer = null // no Long Tasks API here
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  return {
    kind: 'app',
    // Real time passes by itself; a step yields to the page (rendering, timers) and waits when asked to.
    advance: (ms) => sleep(Math.max(0, ms)),
    clock: () => performance.now(),
    realSleep: sleep,
    putMedia: () => undefined,
    drainErrors: () => guards.errors.splice(0),
    drainBudgetMs: APP_DRAIN_MS,
    sample: () => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return { heap: mem?.usedJSHeapSize, dom: document.getElementsByTagName('*').length, longFrames: longFrames.splice(0) }
    },
    guardCounters: () => ({ ...guards.counters }),
    guardTrips: () => guards.trips.splice(0),
    dispose: () => observer?.disconnect(),
  }
}

export interface SandboxHooks {
  onFailure?: (project: unknown, takes: unknown) => void
  /** Restore phase messages for the UI ("Đang trả lại dự án của bạn…"). */
  onPhase?: (text: string) => void
}

/**
 * Run a stress session in the app, isolated from the user's data. Resolves with the report; throws only when the run
 * could not even start (the reason is in the message, nothing was changed).
 */
export async function runInSandbox(options: StressOptions, hooks: SandboxHooks = {}): Promise<StressReport> {
  const blocked = startBlockedReason()
  if (blocked) throw new Error(blocked)
  const res = await withRunLock(async () => {
    if (running || sessionActive()) throw new Error('Đang có một lần thử nghiệm chạy.')
    running = true
    try {
      return await runLocked(options, hooks)
    } finally {
      running = false
    }
  })
  if (!res.ok) throw new Error('Đang có một lần thử nghiệm chạy ở cửa sổ khác — đợi nó xong rồi thử lại.')
  return res.value
}

async function runLocked(options: StressOptions, hooks: SandboxHooks): Promise<StressReport> {
  // The lock is ours: a manifest now can only be a leftover of a run that is gone.
  if (readManifest()) throw new Error('Còn dữ liệu thử nghiệm của lần trước — bấm “Dọn dữ liệu thử nghiệm” trước.')
  if (!(await flush())) throw new Error('Chưa lưu được dự án đang mở nên chưa chạy thử nghiệm (để không mất thay đổi). Thử lại sau.')
  const blocked = blockedReason(true)
  if (blocked) throw new Error(blocked)
  const originalId = useProject.getState().project.id
  const layout = uiLayout()
  const manifest: Manifest = { originalId, tempId: null, startedAt: Date.now(), seed: options.seed ?? '', beat: Date.now(), ui: layout }
  writeManifest(manifest)
  const autoDownload = useDownloadPrefs.getState().autoDownload

  let guards: Guards | null = null
  let env: (StressEnv & { dispose(): void }) | null = null
  let tempId: string | null = null
  let restoring = false
  let stopReason: string | null = null
  const media = new Set<string>()
  const folderIds = new Set<string>()
  const offs: (() => void)[] = []
  const unwatch = () => {
    for (const off of offs.splice(0)) {
      try {
        off()
      } catch {
        /* keep going */
      }
    }
  }
  const stopWith = (reason: string) => {
    stopReason ??= reason
  }
  const bump = (key: string) => {
    if (guards) guards.counters[key] = (guards.counters[key] ?? 0) + 1
  }

  // Development mode only, for the whole run: choosing the real service is undone at once and ends the run.
  const watchProvider = () => {
    offs.push(
      useProviderPrefs.subscribe(() => {
        if (restoring || activeProviderId() === 'dev') return
        useProviderPrefs.getState().setProvider('dev')
        bump('Đổi sang canvasapp.io.vn (đã giữ Phát triển)')
        stopWith('Đã chọn canvasapp.io.vn thật trong lúc thử nghiệm: giữ chế độ Phát triển và dừng thử nghiệm.')
        toast('Đang chạy Test giới hạn: vẫn giữ chế độ Phát triển. Đổi sang canvasapp.io.vn sau khi thử nghiệm dừng.', { tone: 'warning', ms: 8000 })
      }),
    )
  }

  // The temporary project only: another project opened = stop now; folder nodes never keep a real folder; the videos
  // its takes store are deleted with it.
  const watchProject = (id: string) => {
    offs.push(
      useProject.subscribe((s, prev) => {
        if (restoring) return
        if (s.project.id !== id) {
          if (!stopReason) {
            stopWith('Đã mở dự án khác trong lúc thử nghiệm: dừng ngay để không đụng tới dự án đó.')
            stopActiveSession()
          }
          return
        }
        if (s.project.folders === prev.project.folders) return
        const folders = s.project.folders ?? []
        const fresh = folders.filter((f) => !folderIds.has(f.id)).map((f) => f.id)
        if (fresh.length) {
          for (const f of fresh) folderIds.add(f)
          rememberFolderIds(fresh)
        }
        const real = folders.filter((f) => f.path)
        if (real.length) {
          for (const f of real) useProject.getState().setFolderPlace(f.id, { name: f.name, path: null })
          bump('Chọn thư mục thật cho Thư mục thử nghiệm (đã bỏ)')
          toast('Thư mục của dự án thử nghiệm không lưu vào thư mục thật — đã bỏ thư mục vừa chọn.', { tone: 'warning', ms: 8000 })
        }
      }),
    )
    offs.push(
      onRunEvent((e) => {
        if (e.type !== 'completed' || useProject.getState().project.id !== id) return
        const t = useRuns.getState().takes.find((x) => x.id === e.takeId)
        if (t?.posterId) media.add(t.posterId)
        if (t?.videoId) media.add(t.videoId)
      }),
    )
  }

  const load = async (gen: GeneratedProject) => {
    // A stored project of its own: an empty stub through the normal import path (new id, list entry), then the
    // generated content under that id (the autosave writes it like any edit).
    const stub = { format: 'sanovids', version: 2, project: { name: gen.project.name, schemaVersion: 2, scenes: [], assets: [], presets: [] }, media: {} }
    await importProjectFile(new File([JSON.stringify(stub)], 'stress.sanovids.json', { type: 'application/json' }))
    const id = useProject.getState().project.id
    // Never write the generated content over the user's project.
    if (id === originalId) throw new Error('Không mở được dự án thử nghiệm.')
    tempId = id
    updateManifest({ tempId: id })
    pinActiveProject(originalId)
    watchProject(id)
    useProject.getState().loadProject({ ...gen.project, id })
    clearHistory()
    useRuns.getState().loadRuns({ takes: gen.takes, credits: 1000, spent: 0 })
  }

  let lastBeat = Date.now()
  try {
    useDownloadPrefs.setState({ autoDownload: false })
    guards = installGuards()
    env = appEnv(guards)
    watchProvider()
    const report = await runStress(
      {
        ...options,
        shouldStop: () => !!stopReason || !!options.shouldStop?.(),
        onProgress: (p) => {
          if (tempId) pinActiveProject(originalId)
          const now = Date.now()
          if (now - lastBeat > BEAT_MS) {
            lastBeat = now
            updateManifest({ beat: now })
          }
          options.onProgress?.(p)
        },
      },
      env,
      { load, onFailure: hooks.onFailure },
    )
    if (stopReason) report.notes.unshift(stopReason)
    return report
  } finally {
    restoring = true
    const phase = (text: string) => {
      try {
        hooks.onPhase?.(text)
      } catch {
        /* the UI text is a bonus: never skip the restore for it */
      }
    }
    phase('Đang trả lại dự án của bạn…')
    unwatch()
    try {
      env?.dispose()
    } catch {
      /* nothing to observe */
    }
    guards?.remove()
    let gone = false
    try {
      gone = await restoreUser(originalId, tempId)
    } catch {
      gone = false
    }
    await forgetMedia(media).catch(() => undefined)
    forgetFolderSaves([...folderIds])
    restoreUiLayout(layout)
    restoreAutoDownload(autoDownload)
    // Kept when the temporary project could not be deleted: "Dọn dữ liệu thử nghiệm" tries again.
    if (gone) writeManifest(null)
    void refreshRealCredits({ force: true }).catch(() => undefined)
    phase('')
  }
}

/**
 * The auto-download switch as it was. The run only turned it off in memory — unless a download setting was changed
 * meanwhile (that saves every download setting, the switch included): then it is saved back as well.
 */
function restoreAutoDownload(before: boolean) {
  let stored: unknown
  try {
    stored = (JSON.parse(localStorage.getItem(DOWNLOAD_PREFS_KEY) ?? 'null') as { autoDownload?: unknown } | null)?.autoDownload
  } catch {
    stored = undefined
  }
  if (typeof stored === 'boolean' && stored !== before) useDownloadPrefs.getState().set({ autoDownload: before })
  else if (useDownloadPrefs.getState().autoDownload !== before) useDownloadPrefs.setState({ autoDownload: before })
}

// The in-app sandbox of the stress tester (sandbox.ts + manifest.ts), in node with a fake page: every patched global
// comes back exactly as it was, a failed start never empties the user's takes, the run stops (and leaves the other
// project alone) when another project is opened or canvasapp.io.vn is chosen, folder nodes never keep a real folder,
// and a run that never finished is cleaned up at the next start — but never while its lock is held.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const page = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true })
  return { store }
})

const media = vi.hoisted(() => new Map<string, Blob>())
vi.mock('../../../lib/imageStore', () => {
  let n = 0
  return {
    putBlob: vi.fn(async (b: Blob, prefix = 'img') => {
      const id = `${prefix}_${++n}`
      media.set(id, b)
      return id
    }),
    getBlob: vi.fn(async (id: string) => media.get(id) ?? null),
    getUrl: vi.fn(async () => null),
    cachedUrl: () => null,
    deleteMedia: vi.fn(async (id: string) => void media.delete(id)),
    dataUrlToBlob: () => new Blob(),
    useMediaUrl: () => null,
  }
})

// store/persist: a tiny in-memory stand-in (the real one needs IndexedDB). `open` puts a stored project in the stores
// like persist.openProject does (bdp:active included).
const db = vi.hoisted(() => ({
  projects: new Map<string, { project: unknown; takes: unknown[] }>(),
  importFails: false,
  deleted: [] as string[],
  switched: [] as string[],
}))
vi.mock('../../../store/persist', async () => {
  const { create } = await import('zustand')
  const { useProject, emptyProject, clearHistory } = await import('../../../store/project')
  const { useRuns } = await import('../../../store/runs')
  const open = (id: string) => {
    const hit = db.projects.get(id)
    if (!hit) return false
    useProject.getState().loadProject(hit.project as ReturnType<typeof emptyProject>)
    clearHistory()
    useRuns.getState().loadRuns({ takes: hit.takes as never[], credits: 1000, spent: 0 })
    localStorage.setItem('bdp:active', id)
    return true
  }
  const save = () => {
    const p = useProject.getState().project
    db.projects.set(p.id, { project: p, takes: useRuns.getState().takes })
  }
  return {
    useSave: create(() => ({ ready: true, stale: false, status: 'idle', savedAt: null, projects: [] })),
    flush: vi.fn(async () => (save(), true)),
    importProjectFile: vi.fn(async () => {
      save()
      if (db.importFails) throw new Error('Không tạo được dự án: không ghi được vào bộ nhớ trình duyệt (bộ nhớ đầy?).')
      db.projects.set('prj_tmp', { project: { ...emptyProject('stub'), id: 'prj_tmp' }, takes: [] })
      open('prj_tmp')
    }),
    switchProject: vi.fn(async (id: string) => {
      db.switched.push(id)
      save()
      open(id)
    }),
    deleteProject: vi.fn(async (id: string) => {
      db.deleted.push(id)
      db.projects.delete(id)
    }),
  }
})

import { emptyProject, useProject } from '../../../store/project'
import { setEngineHooks, setEngineLockManager, useRuns } from '../../../store/runs'
import { devProvider, getProvider, useProviderPrefs } from '../../../providers'
import { useDownloadPrefs } from '../../../lib/downloads'
import { useUI } from '../../../store/ui'
import { deleteProject, switchProject } from '../../../store/persist'
import { installGuards, runInSandbox, startBlockedReason } from '../sandbox'
import { MANIFEST_KEY, parseManifest, recoverLeftover, cleanupLeftovers, writeManifest } from '../manifest'
import { sessionActive } from '../session'
import type { Take } from '../../../core/types'
import type { StressOptions, StressProgress } from '../types'

// ---- a fake page ----
class FakeElement {
  click() {
    return 'clicked'
  }
}
class FakeAnchor extends FakeElement {
  attrs = new Set<string>()
  hasAttribute(name: string) {
    return this.attrs.has(name)
  }
}
class FakeXHR {
  open(..._args: unknown[]) {
    return 'opened'
  }
}
class FakeSocket {
  static CONNECTING = 0
  constructor(public url: string) {}
}
class FakeNavigator {
  sendBeacon(_url: string) {
    return true
  }
}
class FakeFileHandle {
  createWritable() {
    return Promise.resolve('writer')
  }
}

let win: Record<string, unknown>
let origFetch: ReturnType<typeof vi.fn>
const realConsoleError = console.error

function fakePage() {
  origFetch = vi.fn(async () => 'fetched')
  win = {
    fetch: origFetch,
    confirm: () => true,
    alert: () => undefined,
    prompt: () => 'typed',
    open: () => ({}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    WebSocket: FakeSocket,
    EventSource: FakeSocket,
    showDirectoryPicker: async () => 'dir',
    showSaveFilePicker: async () => 'file',
    FileSystemFileHandle: FakeFileHandle,
  }
  vi.stubGlobal('window', win)
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  vi.stubGlobal('HTMLAnchorElement', FakeAnchor)
  vi.stubGlobal('navigator', Object.create(FakeNavigator.prototype))
  vi.stubGlobal('location', { href: 'http://localhost:5180/', origin: 'http://localhost:5180' })
  vi.stubGlobal('document', { getElementsByTagName: () => [] })
}

const descriptors = () => ({
  fetch: Object.getOwnPropertyDescriptor(win, 'fetch'),
  confirm: Object.getOwnPropertyDescriptor(win, 'confirm'),
  open: Object.getOwnPropertyDescriptor(win, 'open'),
  ws: Object.getOwnPropertyDescriptor(win, 'WebSocket'),
  picker: Object.getOwnPropertyDescriptor(win, 'showDirectoryPicker'),
  xhr: Object.getOwnPropertyDescriptor(FakeXHR.prototype, 'open'),
  anchorOwn: Object.getOwnPropertyDescriptor(FakeAnchor.prototype, 'click'),
  beaconOwn: Object.getOwnPropertyDescriptor(navigator, 'sendBeacon'),
  writable: Object.getOwnPropertyDescriptor(FakeFileHandle.prototype, 'createWritable'),
  consoleError: Object.getOwnPropertyDescriptor(console, 'error'),
})

const take = (id: string, sceneId: string): Take =>
  ({
    id,
    sceneId,
    number: 1,
    status: 'completed',
    progress: 100,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
    promptSnapshot: 'x',
    rawPromptSnapshot: 'x',
    refsSnapshot: [],
    videoRefsSnapshot: [],
    settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
    cost: 4,
    starred: false,
    posterId: null,
    videoId: 'video_user_1',
    error: null,
    position: null,
    provider: 'dev',
    remoteId: 'r1',
    charged: false,
  }) as Take

function openUserProject() {
  const p = { ...emptyProject('Phim của tôi'), id: 'prj_user' }
  useProject.getState().loadProject(p)
  useRuns.getState().loadRuns({ takes: [take('take_user_1', 'scn_user')], credits: 1000, spent: 0 })
  db.projects.set('prj_user', { project: p, takes: useRuns.getState().takes })
  localStorage.setItem('bdp:active', 'prj_user')
}

const opts = (extra: Partial<StressOptions> = {}): StressOptions => ({ scenarios: ['link-unlink'], seed: '5eedf00d', steps: 12, maxMs: 0, checkEvery: 100, stopOnFirst: true, tier: 'S', ...extra })

beforeEach(() => {
  page.store.clear()
  db.projects.clear()
  db.importFails = false
  db.deleted = []
  db.switched = []
  fakePage()
  setEngineLockManager(null)
  setEngineHooks({})
  useProviderPrefs.setState({ provider: 'dev' })
  useDownloadPrefs.setState({ autoDownload: true })
  openUserProject()
})

afterEach(() => {
  console.error = realConsoleError
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('guards', () => {
  it('block what a run must never do and put every property back exactly', async () => {
    const before = descriptors()
    expect(before.anchorOwn).toBeUndefined() // inherited from FakeElement
    expect(before.beaconOwn).toBeUndefined() // inherited from FakeNavigator
    const g = installGuards()
    const w = window as unknown as Record<string, (...a: unknown[]) => unknown>
    await expect(w.fetch('https://canvasapp.io.vn/api/me')).rejects.toThrow('ĐÃ CHẶN')
    expect(g.trips.map((t) => t.invariant)).toEqual(['S4'])
    expect(await w.fetch('/assets/x.js')).toBe('fetched')
    expect(origFetch).toHaveBeenCalledTimes(1)
    expect(() => new XMLHttpRequest().open('GET', 'https://example.org/')).toThrow('ĐÃ CHẶN')
    expect(() => new (window.WebSocket as unknown as new (u: string) => unknown)('wss://example.org/')).toThrow('ĐÃ CHẶN')
    expect((new (window.WebSocket as unknown as new (u: string) => FakeSocket)('ws://localhost:5180/hmr') as FakeSocket).url).toBe('ws://localhost:5180/hmr')
    expect(navigator.sendBeacon('https://example.org/')).toBe(false)
    expect(w.open('https://example.org/')).toBeNull()
    const a = new FakeAnchor()
    a.attrs.add('download')
    expect(a.click()).toBeUndefined()
    expect(new FakeAnchor().click()).toBe('clicked')
    await expect(w.showDirectoryPicker()).rejects.toThrow('ĐÃ CHẶN')
    await expect(new FakeFileHandle().createWritable()).rejects.toThrow('ĐÃ CHẶN')
    expect(w.confirm('?')).toBe(false)
    expect(w.prompt('?')).toBeNull()
    console.error('boom')
    expect(g.errors).toEqual(['boom'])
    expect(g.counters['Tải file bị chặn']).toBe(1)
    expect(g.counters['Hộp xác nhận (trả lời Huỷ)']).toBe(1)

    g.remove()
    g.remove() // idempotent
    expect(descriptors()).toEqual(before)
    expect(new FakeAnchor().click()).toBe('clicked')
    expect(Object.prototype.hasOwnProperty.call(FakeAnchor.prototype, 'click')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(navigator, 'sendBeacon')).toBe(false)
    expect(await (window as unknown as { fetch: (u: string) => Promise<unknown> }).fetch('https://example.org/')).toBe('fetched')
  })

  it('a guard that cannot be installed puts back the ones already in place and refuses', () => {
    const before = descriptors()
    Object.defineProperty(win, 'alert', { value: () => undefined, configurable: false, writable: false })
    expect(() => installGuards()).toThrow('Không cài được rào chắn')
    expect(descriptors()).toEqual(before)
  })
})

describe('runInSandbox', () => {
  it('a temporary project that cannot be opened never empties the user\'s takes', async () => {
    db.importFails = true
    const r = await runInSandbox(opts())
    expect(r.result).toBe('harness-error')
    expect(useProject.getState().project.id).toBe('prj_user')
    expect(useRuns.getState().takes.map((t) => t.id)).toEqual(['take_user_1'])
    expect(deleteProject).not.toHaveBeenCalled()
    expect(localStorage.getItem(MANIFEST_KEY)).toBeNull()
    expect(useDownloadPrefs.getState().autoDownload).toBe(true)
    expect(Object.getOwnPropertyDescriptor(win, 'fetch')?.value).toBe(origFetch)
    expect(sessionActive()).toBe(false)
  })

  it('runs on its own project and puts everything back', async () => {
    useUI.getState().setView('table')
    const seen: { active: string | null; autoDownload: boolean; manifest: string | null; project: string }[] = []
    const r = await runInSandbox(
      opts({
        onProgress: (_p: StressProgress) => {
          seen.push({ active: localStorage.getItem('bdp:active'), autoDownload: useDownloadPrefs.getState().autoDownload, manifest: localStorage.getItem(MANIFEST_KEY), project: useProject.getState().project.id })
          useUI.getState().setView('storyboard') // the run may change the layout
        },
      }),
    )
    expect(r.result).toBe('pass')
    expect(seen.length).toBe(12)
    // the run works on the temporary project; a restart in the middle would reopen the user's one
    expect(seen.every((s) => s.project === 'prj_tmp' && s.active === 'prj_user' && s.autoDownload === false)).toBe(true)
    expect(parseManifest(JSON.parse(seen[0].manifest!))).toMatchObject({ originalId: 'prj_user', tempId: 'prj_tmp' })
    // back: the user's project and takes, the temporary project deleted, the layout, auto-download, providers
    expect(switchProject).toHaveBeenCalledWith('prj_user')
    expect(db.deleted).toEqual(['prj_tmp'])
    expect(useProject.getState().project.id).toBe('prj_user')
    expect(useRuns.getState().takes.map((t) => t.id)).toEqual(['take_user_1'])
    expect(useUI.getState().view).toBe('table')
    expect(useDownloadPrefs.getState().autoDownload).toBe(true)
    expect(localStorage.getItem(MANIFEST_KEY)).toBeNull()
    expect(getProvider('dev')).toBe(devProvider())
    expect(sessionActive()).toBe(false)
  })

  it('opening another project stops the run at once and leaves that project alone', async () => {
    const other = { ...emptyProject('Dự án khác'), id: 'prj_other' }
    db.projects.set('prj_other', { project: other, takes: [take('take_other_1', 'scn_other')] })
    let providerAfterSwitch: unknown = null
    const r = await runInSandbox(
      opts({
        steps: 200,
        onProgress: (p: StressProgress) => {
          if (p.step !== 4) return
          void switchProject('prj_other') // the user opens another project from the list
          providerAfterSwitch = getProvider('dev')
        },
      }),
    )
    expect(r.result).toBe('stopped')
    expect(r.steps).toBeLessThan(10)
    expect(r.notes[0]).toContain('Đã mở dự án khác')
    // the session's providers were gone before that project's queue could start
    expect(providerAfterSwitch).toBe(devProvider())
    // that project stays open with its takes; the temporary one is deleted; nobody is switched back
    expect(useProject.getState().project.id).toBe('prj_other')
    expect(useRuns.getState().takes.map((t) => t.id)).toEqual(['take_other_1'])
    expect(db.deleted).toEqual(['prj_tmp'])
    expect(db.switched).toEqual(['prj_other'])
    expect(localStorage.getItem(MANIFEST_KEY)).toBeNull()
  })

  it('choosing canvasapp.io.vn during a run is undone and stops it; a picked real folder is dropped', async () => {
    const request = vi.fn(async () => {
      throw new Error('real canvasapp called')
    })
    win.bdpDesktop = { canvasapp: { request } }
    let folderPath: unknown = 'unset'
    const r = await runInSandbox(
      opts({
        steps: 200,
        onProgress: (p: StressProgress) => {
          if (p.step === 2) {
            const id = useProject.getState().addFolder({ name: 'Video', path: 'C:\\Users\\me\\Videos', position: { x: 0, y: 0 } })
            folderPath = useProject.getState().project.folders?.find((f) => f.id === id)?.path
          }
          if (p.step === 3) useProviderPrefs.getState().setProvider('canvasapp')
        },
      }),
    )
    expect(folderPath).toBeNull()
    expect(r.guards['Chọn thư mục thật cho Thư mục thử nghiệm (đã bỏ)']).toBe(1)
    expect(useProviderPrefs.getState().provider).toBe('dev')
    expect(r.result).toBe('stopped')
    expect(r.notes[0]).toContain('canvasapp.io.vn')
    expect(request).not.toHaveBeenCalled()
    expect(useProject.getState().project.id).toBe('prj_user')
  })

  it('a request to the real service during a run fails it (S4) and still puts everything back', async () => {
    const r = await runInSandbox(
      opts({
        steps: 50,
        onProgress: (p: StressProgress) => {
          if (p.step === 2) void window.fetch('https://seedvis.com/api').catch(() => undefined)
        },
      }),
    )
    expect(r.result).toBe('fail')
    expect(r.failure?.invariant).toBe('S4')
    expect(useProject.getState().project.id).toBe('prj_user')
    expect(Object.getOwnPropertyDescriptor(win, 'fetch')?.value).toBe(origFetch)
  })

  it('refuses to start over the leftovers of a run that never finished', async () => {
    writeManifest({ originalId: 'prj_user', tempId: 'prj_gone', startedAt: 1, seed: 'x' })
    expect(startBlockedReason()).toContain('Dọn dữ liệu thử nghiệm')
    await expect(runInSandbox(opts())).rejects.toThrow('Dọn dữ liệu thử nghiệm')
    expect(useProject.getState().project.id).toBe('prj_user')
  })
})

describe('leftovers of a run that never finished', () => {
  it('are cleaned up at the next start: temporary project, waiting folder saves, layout', async () => {
    localStorage.setItem('bdp:folder-waiting', JSON.stringify({ fld_stress: ['take_x'], fld_user: ['take_user_1'] }))
    useUI.getState().setView('storyboard')
    writeManifest({ originalId: 'prj_user', tempId: 'prj_tmp_old', startedAt: 1, seed: '5eedf00d', folderIds: ['fld_stress'], ui: { view: 'table', leftOpen: true, rightOpen: true, queueOpen: false, showMinimap: true, takeDisplay: 'all', edgeMode: 'selected' } })
    await recoverLeftover(() => false)
    expect(db.deleted).toEqual(['prj_tmp_old'])
    expect(switchProject).not.toHaveBeenCalled() // the user's project is the open one already
    expect(localStorage.getItem(MANIFEST_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem('bdp:folder-waiting') ?? '{}')).toEqual({ fld_user: ['take_user_1'] })
    expect(useUI.getState().view).toBe('table')
  })

  it('are left alone while their run still holds the lock (another window)', async () => {
    let held = true
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, _o: unknown, cb: (lock: unknown) => Promise<unknown>) => cb(held ? null : { name: 'x' }),
      },
    })
    writeManifest({ originalId: 'prj_user', tempId: 'prj_running', startedAt: Date.now(), seed: 'x' })
    expect(await cleanupLeftovers(() => false)).toContain('cửa sổ khác')
    expect(db.deleted).toEqual([])
    expect(localStorage.getItem(MANIFEST_KEY)).not.toBeNull()
    held = false
    expect(await cleanupLeftovers(() => false)).toContain('Đã xoá dự án thử nghiệm')
    expect(db.deleted).toEqual(['prj_running'])
  })

  it('a malformed manifest is ignored, never trusted', () => {
    expect(parseManifest({ originalId: 1, tempId: 'x' })).toBeNull()
    expect(parseManifest({ originalId: 'a', tempId: null, startedAt: 1, seed: 's', ui: { view: '<img>' }, folderIds: ['f', 3] })).toEqual({ originalId: 'a', tempId: null, startedAt: 1, seed: 's', folderIds: ['f'] })
  })
})

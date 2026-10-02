// Folder nodes ("Thư mục") and file names end to end, without a browser: the real queue engine (store/runs) with a
// fake provider, the real project store (wires, undo), the real folder actions, and a fake desktop bridge
// (window.bdpDesktop.files) standing in for electron/main.cjs. No network, no disk.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => new Map<string, Blob>())
vi.mock('../lib/imageStore', () => {
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

import { deleteSelection, downloadChosenTakesZip, downloadTake, edgeId, parseEdgeId, renameTake, takeFileBase } from '../actions'
import { DEFAULT_NAME_TEMPLATE } from '../core/nameTemplate'
import type { Project, Scene } from '../core/types'
import { linkScenesToFolder, linkTakesToFolder, removeFolderNode, saveTakeToFolder } from '../folderActions'
import type { DesktopFile, DesktopFilesBridge } from '../lib/desktopFiles'
import { useDownloadPrefs } from '../lib/downloads'
import { folderRuntime } from '../lib/saveFolders'
import { getProvider, registerProvider } from '../providers'
import { capabilitiesFromModels } from '../providers/capabilities'
import type { RemoteStatus, VideoProvider } from '../providers/types'
import { undo, useProject } from '../store/project'
import { setEngineHooks, setEngineLockManager, useRuns } from '../store/runs'
import { useUI } from '../store/ui'

const scene = (id: string, order: number, title: string): Scene => ({
  id,
  order,
  title,
  prompt: 'A hero walks',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: order * 300 },
  note: '',
})

const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes: [scene('s1', 1, 'Mở đầu'), scene('s2', 2, '')],
  folders: [{ id: 'f1', name: 'Phim', path: 'D:\\Phim', position: { x: 0, y: 0 }, mode: 'copy' }],
})

/** Fake provider: the test decides when a job is done. */
function fakeProvider() {
  const statuses = new Map<string, RemoteStatus>()
  const p: VideoProvider = {
    id: 'mock',
    label: 'mock',
    available: async () => ({ ok: true }),
    capabilities: (m) => capabilitiesFromModels(m, { maxConcurrency: 3, pollIntervalMs: 0, maxRefVideos: 10 }),
    submit: async (req) => {
      const remoteId = 'r_' + req.key
      statuses.set(remoteId, { remoteId, state: 'queued' })
      return { remoteId }
    },
    poll: async (ids) => ids.map((rid) => statuses.get(rid)!).filter(Boolean),
    fetchResult: async () => ({ video: new Blob(['VIDEO'], { type: 'video/mp4' }), poster: new Blob(['p'], { type: 'image/jpeg' }) }),
    cancel: () => undefined,
  }
  const finish = (takeId: string) => statuses.set('r_' + takeId, { remoteId: 'r_' + takeId, state: 'completed', progress: 100 })
  return { p, finish }
}

/** What electron/main.cjs would do: writes into allowlisted folders, a save dialog the test answers. */
function fakeDesktop() {
  const writes: { folderPath: string; files: DesktopFile[] }[] = []
  const saveAs: { suggestedName: string; title?: string; files: DesktopFile[] }[] = []
  const allowed = new Set(['D:\\Phim'])
  let dialogAnswer: string | null = 'E:\\Chọn\\Phim của tôi.mp4'
  const bridge: DesktopFilesBridge = {
    pickFolder: async () => ({ ok: false, code: 'canceled', message: 'Đã huỷ.', canceled: true }),
    folderStatus: async ({ folderPath }) => ({ ok: true, allowed: allowed.has(folderPath), exists: true }),
    writeToFolder: async (args) => {
      if (!allowed.has(args.folderPath)) return { ok: false, code: 'not-allowed', message: 'Thư mục này chưa được chọn trên máy này.' }
      writes.push(args)
      return { ok: true, names: args.files.map((f) => f.name) }
    },
    openFolder: async () => ({ ok: true }),
    saveAs: async (args) => {
      saveAs.push(args)
      if (!dialogAnswer) return { ok: false, code: 'canceled', message: 'Đã huỷ.', canceled: true }
      return { ok: true, path: dialogAnswer, names: ['Phim của tôi.mp4', ...(args.files.length > 1 ? ['Phim của tôi.txt'] : [])] }
    },
  }
  return {
    bridge,
    writes,
    saveAs,
    allowed,
    answer: (a: string | null) => {
      dialogAnswer = a
    },
  }
}

const realMock = getProvider('mock')
const takeOf = (id: string) => useRuns.getState().takes.find((t) => t.id === id)!
let desk: ReturnType<typeof fakeDesktop>
let prov: ReturnType<typeof fakeProvider>

/** Run a scene until its take is completed (and every save after it ran). */
async function runToCompletion(sceneId: string): Promise<string> {
  useRuns.getState().enqueue([sceneId])
  const id = useRuns.getState().takes[useRuns.getState().takes.length - 1].id
  await vi.advanceTimersByTimeAsync(250)
  prov.finish(id)
  await vi.advanceTimersByTimeAsync(500)
  expect(takeOf(id).status).toBe('completed')
  return id
}

beforeEach(() => {
  setEngineLockManager(null)
  setEngineHooks({})
  vi.useFakeTimers()
  desk = fakeDesktop()
  ;(globalThis as { window?: unknown }).window = { bdpDesktop: { version: 'test', files: desk.bridge } }
  prov = fakeProvider()
  registerProvider(prov.p)
  useProject.getState().loadProject(project())
  useProject.temporal.getState().clear()
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  useDownloadPrefs.setState({ withPrompt: true, askWhere: true, autoDownload: false, folderName: null })
})
afterEach(() => {
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  vi.advanceTimersByTime(250)
  vi.useRealTimers()
  registerProvider(realMock)
  delete (globalThis as { window?: unknown }).window
})
afterAll(() => {
  setEngineLockManager(undefined)
})

describe('edge ids of folder wires', () => {
  it('round-trips save / autosave ids', () => {
    expect(parseEdgeId(edgeId('save', 'tk_1', 'fld_2'))).toEqual({ kind: 'save', from: 'tk_1', to: 'fld_2' })
    expect(parseEdgeId(edgeId('autosave', 'scn_1', 'fld_2'))).toEqual({ kind: 'autosave', from: 'scn_1', to: 'fld_2' })
    expect(parseEdgeId('bogus:a->b')).toBeNull()
  })
})

describe('scene → folder (tự lưu)', () => {
  it('every take of the scene that finishes is copied into the folder, with its prompt .txt', async () => {
    linkScenesToFolder(['s1'], 'f1')
    expect(useProject.getState().project.folders![0].autoScenes).toEqual(['s1'])
    const id = await runToCompletion('s1')
    expect(desk.writes).toHaveLength(1)
    expect(desk.writes[0].folderPath).toBe('D:\\Phim')
    expect(desk.writes[0].files.map((f) => f.name)).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
    expect(new TextDecoder().decode(desk.writes[0].files[0].bytes)).toBe('VIDEO')
    expect(desk.writes[0].files[1].text).toBe('A hero walks')
    expect(folderRuntime('f1')).toMatchObject({ saved: 1, error: null })
    // other scenes are not saved there
    await runToCompletion('s2')
    expect(desk.writes).toHaveLength(1)
    expect(takeOf(id).status).toBe('completed')
  })

  it('without "kèm prompt" only the video is copied; a renamed take uses its new name', async () => {
    useDownloadPrefs.setState({ withPrompt: false })
    linkScenesToFolder(['s2'], 'f1')
    useRuns.getState().enqueue(['s2'])
    const id = useRuns.getState().takes[0].id
    await vi.advanceTimersByTimeAsync(250)
    renameTake(id, 'Cảnh / kết.mp4')
    expect(takeOf(id).fileName).toBe('Cảnh - kết')
    prov.finish(id)
    await vi.advanceTimersByTimeAsync(500)
    expect(desk.writes.map((w) => w.files.map((f) => f.name))).toEqual([['Cảnh - kết.mp4']])
  })

  it('a folder not picked on this computer is not written; the save waits for "Chọn lại thư mục"', async () => {
    desk.allowed.clear()
    linkScenesToFolder(['s1'], 'f1')
    await runToCompletion('s1')
    expect(desk.writes).toHaveLength(0)
    expect(folderRuntime('f1')).toMatchObject({ access: 'pick', pending: 1 })
    expect(useUI.getState().toasts.some((t) => /Chưa lưu được/.test(t.text))).toBe(true)
  })

  it('the wire is undoable and cut like other wires', () => {
    linkScenesToFolder(['s1'], 'f1')
    expect(useProject.getState().project.folders![0].autoScenes).toEqual(['s1'])
    undo()
    expect(useProject.getState().project.folders![0]).not.toHaveProperty('autoScenes')
    linkScenesToFolder(['s1'], 'f1')
    useUI.setState({ selectedIds: [], selectedEdgeIds: [edgeId('autosave', 's1', 'f1')] })
    deleteSelection()
    expect(useProject.getState().project.folders![0]).not.toHaveProperty('autoScenes')
  })
})

describe('take → folder (lưu)', () => {
  it('a finished video is copied when wired; a running one as soon as it finishes', async () => {
    const done = await runToCompletion('s1')
    linkTakesToFolder([done], 'f1')
    await vi.advanceTimersByTimeAsync(10)
    expect(desk.writes.map((w) => w.files[0].name)).toEqual(['S01_T1 - Mở đầu.mp4'])

    useRuns.getState().enqueue(['s2'])
    const later = useRuns.getState().takes.find((t) => t.sceneId === 's2')!.id
    await vi.advanceTimersByTimeAsync(250)
    linkTakesToFolder([later], 'f1')
    expect(desk.writes).toHaveLength(1)
    prov.finish(later)
    await vi.advanceTimersByTimeAsync(500)
    expect(desk.writes.map((w) => w.files[0].name)).toEqual(['S01_T1 - Mở đầu.mp4', 'S02_T1.mp4'])
    expect(useProject.getState().project.folders![0].takes).toEqual([done, later])
  })

  it('a video already saved there is not copied twice by a wire; the toast offers another copy', async () => {
    linkScenesToFolder(['s1'], 'f1')
    const id = await runToCompletion('s1')
    expect(desk.writes).toHaveLength(1)
    linkTakesToFolder([id], 'f1')
    await vi.advanceTimersByTimeAsync(10)
    expect(desk.writes).toHaveLength(1)
    const offer = useUI.getState().toasts.find((t) => t.action?.label === 'Lưu thêm bản nữa')
    expect(offer?.text).toMatch(/đã có trong thư mục “Phim”/)
    offer!.action!.run()
    await vi.advanceTimersByTimeAsync(10)
    expect(desk.writes).toHaveLength(2)
  })

  it('an explicit save writes again; a folder node removed from the canvas comes back with Undo', async () => {
    const id = await runToCompletion('s1')
    expect(await saveTakeToFolder(id, 'f1')).toBe(true)
    expect(await saveTakeToFolder(id, 'f1')).toBe(true)
    expect(desk.writes).toHaveLength(2)
    removeFolderNode('f1')
    expect(useProject.getState().project.folders).toEqual([])
    undo()
    expect(useProject.getState().project.folders![0].id).toBe('f1')
  })
})

describe('"Tên file" and "Hỏi nơi lưu & tên file"', () => {
  it('a take is named after its scene until renamed; an empty name goes back to the default', async () => {
    const id = await runToCompletion('s1')
    expect(takeFileBase(id)).toBe('S01_T1 - Mở đầu')
    expect(renameTake(id, '  Bản dựng cuối  ')).toBe('Bản dựng cuối')
    expect(takeFileBase(id)).toBe('Bản dựng cuối')
    expect(renameTake(id, '')).toBe('S01_T1 - Mở đầu')
    expect(takeOf(id)).not.toHaveProperty('fileName')
    // typing the default name stores nothing (it keeps following the scene title)
    renameTake(id, 'S01_T1 - Mở đầu')
    expect(takeOf(id)).not.toHaveProperty('fileName')
  })

  it('"Tải video" opens the save dialog (desktop) with the video + its prompt .txt', async () => {
    const id = await runToCompletion('s2')
    renameTake(id, 'Kết phim')
    expect(await downloadTake(id)).toBe(true)
    expect(desk.saveAs).toHaveLength(1)
    expect(desk.saveAs[0].suggestedName).toBe('Kết phim.mp4')
    expect(desk.saveAs[0].files.map((f) => f.name)).toEqual(['Kết phim.mp4', 'Kết phim.txt'])
    expect(useUI.getState().toasts.some((t) => t.text.includes('E:\\Chọn\\Phim của tôi.mp4'))).toBe(true)
  })

  it('closing the dialog saves nothing and says nothing', async () => {
    const id = await runToCompletion('s2')
    desk.answer(null)
    const before = useUI.getState().toasts.length
    expect(await downloadTake(id)).toBe(false)
    expect(desk.saveAs).toHaveLength(1)
    expect(useUI.getState().toasts.length).toBe(before)
  })

  it('an auto-download never asks', async () => {
    const id = await runToCompletion('s2')
    await downloadTake(id, { auto: true })
    expect(desk.saveAs).toHaveLength(0)
  })
})

describe('Cài đặt: "Cách đặt tên file", "Kèm file .txt", "Kèm prompts.txt trong file .zip"', () => {
  afterEach(() => useDownloadPrefs.setState({ nameTemplate: DEFAULT_NAME_TEMPLATE, zipPrompts: true }))

  it('the default name follows the template; a name typed for the take still wins', async () => {
    const id = await runToCompletion('s1')
    const untitled = await runToCompletion('s2')
    useDownloadPrefs.getState().set({ nameTemplate: '{project} - {scene}{take} ({title})' })
    expect(takeFileBase(id)).toBe('P - S01T1 (Mở đầu)')
    expect(takeFileBase(untitled)).toBe('P - S02T1')
    expect(renameTake(id, 'Bản cuối')).toBe('Bản cuối')
    expect(renameTake(id, '')).toBe('P - S01T1 (Mở đầu)')
    expect(takeOf(id)).not.toHaveProperty('fileName')
    // an invalid template is refused (the last valid one stays)
    useDownloadPrefs.getState().set({ nameTemplate: '{nope}' })
    expect(useDownloadPrefs.getState().nameTemplate).toBe('{project} - {scene}{take} ({title})')
    expect(await downloadTake(id)).toBe(true)
    expect(desk.saveAs[0].files.map((f) => f.name)).toEqual(['P - S01T1 (Mở đầu).mp4', 'P - S01T1 (Mở đầu).txt'])
  })

  it('"Kèm file .txt chứa prompt" off: the download is the video alone', async () => {
    const id = await runToCompletion('s1')
    useDownloadPrefs.getState().set({ withPrompt: false })
    expect(await downloadTake(id)).toBe(true)
    expect(desk.saveAs[0].files.map((f) => f.name)).toEqual(['S01_T1 - Mở đầu.mp4'])
  })

  it('the .zip of the chosen videos has prompts.txt only when the setting is on', async () => {
    await runToCompletion('s1')
    await runToCompletion('s2')
    // JSZip schedules its work with timers: let it run on real ones.
    const zipEntries = async () => {
      vi.useRealTimers()
      try {
        await downloadChosenTakesZip()
        const { default: JSZip } = await import('jszip')
        const zip = await JSZip.loadAsync(desk.saveAs[desk.saveAs.length - 1].files[0].bytes!)
        return Object.keys(zip.files).sort()
      } finally {
        vi.useFakeTimers()
      }
    }
    expect(await zipEntries()).toEqual(['S01_T1 - Mở đầu.mp4', 'S02_T1.mp4', 'prompts.txt'])
    useDownloadPrefs.getState().set({ zipPrompts: false })
    expect(await zipEntries()).toEqual(['S01_T1 - Mở đầu.mp4', 'S02_T1.mp4'])
  })
})

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
import { chooseFolderPlace, linkScenesToFolder, linkTakesToFolder, refreshFolderNode, removeFolderNode, saveTakeToFolder } from '../folderActions'
import type { DesktopFile, DesktopFilesBridge } from '../lib/desktopFiles'
import { useDownloadPrefs } from '../lib/downloads'
import { folderRuntime, markWaiting, parseFolderStats, parseFolderWaiting, waitingTakes } from '../lib/saveFolders'
import { getProvider, registerProvider } from '../providers'
import { capabilitiesFromModels } from '../providers/capabilities'
import type { RemoteStatus, VideoProvider } from '../providers/types'
import { redo, undo, useProject } from '../store/project'
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
    // New takes go to the active provider: development mode since v0.3.0 (the fake stands in for it).
    id: 'dev',
    label: 'dev',
    minPollIntervalMs: 0,
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
  /** What the folder picker answers (null = the user closes it). */
  let pickAnswer: string | null = null
  const bridge: DesktopFilesBridge = {
    pickFolder: async () => {
      if (!pickAnswer) return { ok: false, code: 'canceled', message: 'Đã huỷ.', canceled: true }
      allowed.add(pickAnswer)
      return { ok: true, path: pickAnswer, name: pickAnswer.slice(pickAnswer.lastIndexOf(String.fromCharCode(92)) + 1) }
    },
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
    pick: (p: string | null) => {
      pickAnswer = p
    },
  }
}

const realDev = getProvider('dev')
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
  markWaiting('f1', waitingTakes('f1'), false)
  useRuns.getState().loadRuns({ takes: [], credits: 1000, spent: 0 })
  vi.advanceTimersByTime(250)
  vi.useRealTimers()
  registerProvider(realDev)
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

describe('saves that wait for the folder', () => {
  it('a blocked save waits; once written, its "Chưa lưu được" toast goes away', async () => {
    desk.allowed.clear()
    linkScenesToFolder(['s1'], 'f1')
    const id = await runToCompletion('s1')
    expect(waitingTakes('f1')).toEqual([id])
    expect(folderRuntime('f1')).toMatchObject({ access: 'pick', pending: 1 })
    const warn = useUI.getState().toasts.find((t) => /Chưa lưu được/.test(t.text))
    expect(warn).toBeTruthy()
    // the folder is back (desktop: picked again on this computer / the drive plugged in): the node saves what waited
    desk.allowed.add('D:\\Phim')
    await refreshFolderNode('f1')
    expect(desk.writes.map((w) => w.files[0].name)).toEqual(['S01_T1 - Mở đầu.mp4'])
    expect(waitingTakes('f1')).toEqual([])
    expect(folderRuntime('f1')).toMatchObject({ access: 'ok', pending: 0 })
    expect(useUI.getState().toasts.some((t) => t.id === warn!.id)).toBe(false)
    expect(useUI.getState().toasts.some((t) => /Đã lưu S01·T1/.test(t.text))).toBe(true)
  })

  it('"Chọn lại thư mục" saves what waited, closes the warning, and is not an undo step', async () => {
    desk.allowed.clear()
    linkScenesToFolder(['s1'], 'f1')
    await runToCompletion('s1')
    const warn = useUI.getState().toasts.find((t) => /Chưa lưu được/.test(t.text))!
    desk.pick('E:\\Phim B')
    expect(await chooseFolderPlace('f1')).toBe(true)
    expect(desk.writes.map((w) => w.folderPath)).toEqual(['E:\\Phim B'])
    expect(useUI.getState().toasts.some((t) => t.id === warn.id)).toBe(false)
    expect(useProject.getState().project.folders![0]).toMatchObject({ name: 'Phim B', path: 'E:\\Phim B', autoScenes: ['s1'] })
    // Ctrl+Z undoes the wire, never the folder: the node keeps naming the folder its saves go to
    undo()
    expect(useProject.getState().project.folders![0]).toMatchObject({ name: 'Phim B', path: 'E:\\Phim B' })
    expect(useProject.getState().project.folders![0]).not.toHaveProperty('autoScenes')
    redo()
    expect(useProject.getState().project.folders![0]).toMatchObject({ name: 'Phim B', path: 'E:\\Phim B', autoScenes: ['s1'] })
    desk.pick(null)
  })

  it('a save is noted as waiting while it is written (an app closed in the middle writes it again later)', async () => {
    const id = await runToCompletion('s1')
    let during: string[] = []
    const write = desk.bridge.writeToFolder
    desk.bridge.writeToFolder = async (args) => {
      during = waitingTakes('f1')
      return write(args)
    }
    try {
      expect(await saveTakeToFolder(id, 'f1')).toBe(true)
    } finally {
      desk.bridge.writeToFolder = write
    }
    expect(during).toEqual([id])
    expect(waitingTakes('f1')).toEqual([])
  })

  it('the node checking its folder while a save is being written does not write it a second time', async () => {
    const id = await runToCompletion('s1')
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const write = desk.bridge.writeToFolder
    desk.bridge.writeToFolder = async (args) => {
      await gate
      return write(args)
    }
    try {
      const saving = saveTakeToFolder(id, 'f1')
      await vi.advanceTimersByTimeAsync(10)
      expect(waitingTakes('f1')).toEqual([id]) // noted while it is written
      const check = refreshFolderNode('f1') // e.g. the canvas is shown again meanwhile
      await vi.advanceTimersByTimeAsync(10)
      release()
      expect(await saving).toBe(true)
      await check
    } finally {
      desk.bridge.writeToFolder = write
    }
    expect(desk.writes).toHaveLength(1)
    expect(waitingTakes('f1')).toEqual([])
  })

  it('another problem (disk full) is said at once and not left waiting', async () => {
    const id = await runToCompletion('s1')
    const write = desk.bridge.writeToFolder
    desk.bridge.writeToFolder = async () => ({ ok: false, code: 'write-failed', message: 'Ổ đĩa đã đầy.' })
    try {
      expect(await saveTakeToFolder(id, 'f1')).toBe(false)
    } finally {
      desk.bridge.writeToFolder = write
    }
    expect(waitingTakes('f1')).toEqual([])
    expect(useUI.getState().toasts.some((t) => /Ổ đĩa đã đầy/.test(t.text))).toBe(true)
  })

  it('waiting saves of videos that were deleted are dropped', async () => {
    desk.allowed.clear()
    linkScenesToFolder(['s1'], 'f1')
    const id = await runToCompletion('s1')
    expect(waitingTakes('f1')).toEqual([id])
    useRuns.getState().removeTakes([id])
    desk.allowed.add('D:\\Phim')
    await refreshFolderNode('f1')
    expect(waitingTakes('f1')).toEqual([])
    expect(desk.writes).toHaveLength(0)
  })

  it('the list is kept in storage: a reload or a restart (or another tab) still has it', () => {
    const store = new Map<string, string>()
    const g = globalThis as { localStorage?: unknown }
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    }
    try {
      expect(markWaiting('f1', ['tA'], true)).toBe(1)
      expect(JSON.parse(store.get('bdp:folder-waiting')!)).toEqual({ f1: ['tA'] })
      // written by another tab / found after a restart, with a broken entry
      store.set('bdp:folder-waiting', JSON.stringify({ f1: ['tA', 'tB', 'tA', 7], bad: 'x', f2: [] }))
      expect(waitingTakes('f1')).toEqual(['tA', 'tB'])
      expect(markWaiting('f1', ['tA', 'tB'], false)).toBe(0)
      expect(store.has('bdp:folder-waiting')).toBe(false)
    } finally {
      delete g.localStorage
    }
  })
})

describe('folder links follow deleted videos and scenes', () => {
  it('a deleted video is no longer wired (nor counted) — undo / redo never bring the link back', async () => {
    const id = await runToCompletion('s1')
    linkTakesToFolder([id], 'f1')
    expect(useProject.getState().project.folders![0].takes).toEqual([id])
    useRuns.getState().removeTakes([id])
    expect(useProject.getState().project.folders![0]).not.toHaveProperty('takes')
    undo()
    expect(useProject.getState().project.folders![0]).not.toHaveProperty('takes')
    redo()
    expect(useProject.getState().project.folders![0]).not.toHaveProperty('takes')
  })

  it("a deleted scene's auto-save wire goes with it; Undo brings both back", () => {
    linkScenesToFolder(['s2'], 'f1')
    useProject.getState().deleteItems({ sceneIds: ['s2'] })
    expect(useProject.getState().project.folders![0]).not.toHaveProperty('autoScenes')
    undo()
    expect(useProject.getState().project.folders![0].autoScenes).toEqual(['s2'])
    useProject.getState().removeScenes(['s2'])
    expect(useProject.getState().project.folders![0]).not.toHaveProperty('autoScenes')
  })
})

describe('stored folder state is repaired value by value', () => {
  it('counters and saved-take lists of the wrong type never break saving', () => {
    const stats = parseFolderStats({
      f1: { saved: '3', takes: 'tk_abc', lastAt: 'x', lastName: 5 },
      f2: { takes: 5 },
      f3: { saved: 2.7, lastAt: 1000, lastName: 'S01.mp4', takes: ['t1', 't1', 7, 't2'] },
      f4: 'nope',
      f5: null,
    })
    expect(stats.f1).toEqual({ saved: 0, lastAt: null, lastName: null })
    expect(stats.f2).toEqual({ saved: 0, lastAt: null, lastName: null })
    expect(stats.f3).toEqual({ saved: 2, lastAt: 1000, lastName: 'S01.mp4', takes: ['t1', 't2'] })
    expect(stats).not.toHaveProperty('f4')
    expect(stats).not.toHaveProperty('f5')
    expect(parseFolderStats('x')).toEqual({})
    expect(parseFolderStats([1])).toEqual({})
  })

  it('the waiting list too', () => {
    expect(parseFolderWaiting({ f1: ['a', 'a', 1, 'b'], f2: 'x', f3: [] })).toEqual({ f1: ['a', 'b'] })
    expect(parseFolderWaiting(null)).toEqual({})
  })
})

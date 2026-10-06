// Folder nodes ("Thư mục") and file names end to end, without a browser: the real queue engine (store/runs) with a
// fake provider, the real project store (wires, undo), the real folder actions, and a fake desktop bridge
// (window.bdpDesktop.files) standing in for electron/main.cjs — including its ledger of written groups and
// files:trashSaved ("Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác"). No network, no disk.
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

import { deleteSelection, deleteTakes, downloadChosenTakesZip, downloadTake, edgeId, parseEdgeId, renameTake, takeFileBase } from '../actions'
import { cutEdge } from '../components/canvas/edges'
import { DEFAULT_NAME_TEMPLATE } from '../core/nameTemplate'
import type { Project, Scene, Take } from '../core/types'
import { afterSaveUnlinked, chooseFolderPlace, linkScenesToFolder, linkTakesToFolder, refreshFolderNode, removeFolderNode, saveTakeToFolder } from '../folderActions'
import type { DesktopFile, DesktopFilesBridge, SaveOwner, TrashSavedArgs, TrashSavedTakeResult } from '../lib/desktopFiles'
import { useDownloadPrefs } from '../lib/downloads'
import {
  expiredFolderTrashWaiting,
  folderRuntime,
  markTrashWaiting,
  markWaiting,
  ownedGroups,
  parseFolderOwned,
  parseFolderStats,
  parseFolderTrashWaiting,
  parseFolderWaiting,
  releaseOwned,
  setOwned,
  trashWaitingTakes,
  waitingTakes,
  wasSavedTo,
} from '../lib/saveFolders'
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

/** A group the fake main process recorded (electron/main.cjs saved-files.json). */
interface FakeGroup {
  id: string
  folderPath: string
  owner: SaveOwner
  names: string[]
  /** Like main's ledger: the primary went to the Recycle Bin, `names` are the companions that could not follow. */
  primaryTrashed?: boolean
}

/**
 * What electron/main.cjs would do: writes into allowlisted folders (recording each group written with an owner in its
 * ledger and answering its id), moves recorded groups to a fake Recycle Bin (only groups of that folder node / take,
 * never 'autosave' ones; per file what `fileState` says, default unchanged → trashed), a save dialog the test answers.
 */
function fakeDesktop() {
  const writes: { folderPath: string; files: DesktopFile[]; owner?: SaveOwner }[] = []
  const saveAs: { suggestedName: string; title?: string; files: DesktopFile[] }[] = []
  const allowed = new Set(['D:\\Phim'])
  const ledger = new Map<string, FakeGroup>()
  const trashCalls: TrashSavedArgs[] = []
  /** Files moved to the Recycle Bin, in order. */
  const bin: string[] = []
  /**
   * What a file is found like when moving it (renamed → missing, edited → changed, open in VLC → failed, a OneDrive
   * online-only file → cloud = 'failed' + cloud).
   */
  const fileState = new Map<string, 'missing' | 'changed' | 'failed' | 'cloud'>()
  let groupSeq = 0
  /** false: the folder cannot be reached (drive unplugged). */
  let exists = true
  let dialogAnswer: string | null = 'E:\\Chọn\\Phim của tôi.mp4'
  /** What the folder picker answers (null = the user closes it). */
  let pickAnswer: string | null = null
  const bridge: DesktopFilesBridge = {
    pickFolder: async () => {
      if (!pickAnswer) return { ok: false, code: 'canceled', message: 'Đã huỷ.', canceled: true }
      allowed.add(pickAnswer)
      return { ok: true, path: pickAnswer, name: pickAnswer.slice(pickAnswer.lastIndexOf(String.fromCharCode(92)) + 1) }
    },
    folderStatus: async ({ folderPath }) => ({ ok: true, allowed: allowed.has(folderPath), exists }),
    writeToFolder: async (args) => {
      if (!allowed.has(args.folderPath)) return { ok: false, code: 'not-allowed', message: 'Thư mục này chưa được chọn trên máy này.' }
      if (!exists) return { ok: false, code: 'missing', message: 'Không tìm thấy thư mục.' }
      writes.push(args)
      const names = args.files.map((f) => f.name)
      if (!args.owner) return { ok: true, names }
      const id = (++groupSeq).toString(16).padStart(16, '0')
      ledger.set(id, { id, folderPath: args.folderPath, owner: { ...args.owner }, names })
      return { ok: true, names, recorded: id }
    },
    trashSaved: async (args) => {
      trashCalls.push(JSON.parse(JSON.stringify(args)) as TrashSavedArgs)
      if (args.items.length > 200) return { ok: false, code: 'bad-request', message: 'Quá nhiều.' }
      if (!allowed.has(args.folderPath)) return { ok: false, code: 'not-allowed', message: 'Thư mục này chưa được chọn trên máy này.' }
      if (!exists) return { ok: false, code: 'missing', message: 'Không tìm thấy thư mục.' }
      const results: TrashSavedTakeResult[] = args.items.map(({ takeId, groupIds }) => {
        const mine = groupIds
          .map((g) => ledger.get(g))
          .filter((g): g is FakeGroup => !!g && g.owner.folderId === args.folderId && g.owner.takeId === takeId && g.owner.via !== 'autosave')
        const here = mine.filter((g) => g.folderPath === args.folderPath)
        if (!here.length) return { takeId, unknown: true, ...(mine.length ? { elsewhere: true } : {}), files: [] }
        const files: TrashSavedTakeResult['files'] = []
        const moveOne = (name: string, role: 'primary' | 'companion') => {
          const st = fileState.get(name) ?? 'trashed'
          if (st === 'trashed') bin.push(name)
          files.push(st === 'cloud' ? { name, role, result: 'failed', cloud: true } : { name, role, result: st })
          return st === 'cloud' ? 'failed' : st
        }
        /** Companions after a moved primary; the ones that could not follow stay recorded (main: primaryTrashed). */
        const companionsOf = (g: FakeGroup, list: string[]) => {
          const left = list.filter((c) => moveOne(c, 'companion') === 'failed')
          if (left.length) ledger.set(g.id, { ...g, names: left, primaryTrashed: true })
          else ledger.delete(g.id)
        }
        for (const g of here) {
          if (g.primaryTrashed) {
            companionsOf(g, g.names)
            continue
          }
          const [primary, ...companions] = g.names
          const p = moveOne(primary, 'primary')
          if (p === 'trashed') companionsOf(g, companions)
          else if (p !== 'failed') ledger.delete(g.id)
        }
        return { takeId, files }
      })
      return { ok: true, results }
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
    ledger,
    trashCalls,
    bin,
    fileState,
    setExists: (v: boolean) => {
      exists = v
    },
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

/** Wire a take into f1 ('save') without copying it (the store only, like a wire loaded with the project). */
const wire = (takeId: string) => void useProject.getState().linkFolder('f1', 'save', [takeId])
/** Let the folder lock, the fake bridge and the toasts settle. */
const settle = () => vi.advanceTimersByTimeAsync(20)
const lastToast = (re: RegExp) => [...useUI.getState().toasts].reverse().find((t) => re.test(t.text))
const folderTakes = () => useProject.getState().project.folders![0].takes ?? []

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
  useDownloadPrefs.setState({ withPrompt: true, askWhere: true, autoDownload: false, folderName: null, folderUnlinkTrash: true })
  useUI.setState({ toasts: [], selectedIds: [], selectedEdgeIds: [] })
})
afterEach(() => {
  markWaiting('f1', waitingTakes('f1'), false)
  markTrashWaiting('f1', trashWaitingTakes('f1'), false)
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
    wire(id)
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
    wire(id)
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
    wire(id)
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
    wire(id)
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

// ---------------------------------------------------------------------------------------------------------------
// "Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác" (plan §3.2): only what the cut wire itself copied,
// unchanged, goes to the Recycle Bin; Hoàn tác writes a new copy; never the auto-save wire's files, never a file that
// was already there, never the last copy.
describe('cutting a take → folder wire moves what it copied to the Recycle Bin', () => {
  /** A finished take wired into f1 and copied by that wire; returns its id and the ledger group written. */
  async function linkedAndCopied(sceneId = 's1') {
    const id = await runToCompletion(sceneId)
    linkTakesToFolder([id], 'f1')
    await settle()
    const group = desk.writes[desk.writes.length - 1]
    expect(group.owner).toEqual({ folderId: 'f1', takeId: id, via: 'link' })
    return { id, groupId: ownedGroups('f1', id)![0] }
  }
  const cut = (id: string) => cutEdge(edgeId('save', id, 'f1'))

  it('click-cut: the copy and its prompt .txt go to the Recycle Bin, the video no longer counts as saved there', async () => {
    const { id, groupId } = await linkedAndCopied()
    expect(groupId).toMatch(/^[0-9a-f]{16}$/)
    expect(wasSavedTo('f1', id)).toBe(true)
    const saved = folderRuntime('f1').saved
    expect(folderRuntime('f1').lastName).toBe('S01_T1 - Mở đầu.mp4')
    cut(id)
    expect(folderTakes()).toEqual([])
    await settle()
    expect(desk.trashCalls).toEqual([{ folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: id, groupIds: [groupId] }] }])
    expect(desk.bin).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
    expect(wasSavedTo('f1', id)).toBe(false)
    expect(folderRuntime('f1')).toMatchObject({ saved: saved - 1, lastName: null, trashing: false })
    expect(ownedGroups('f1', id)).toBeNull() // dealt with: released
    const t = lastToast(/Thùng rác/)!
    expect(t.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim” và chuyển “S01_T1 - Mở đầu.mp4” và file prompt .txt vào Thùng rác.')
    expect(t.action?.label).toBe('Hoàn tác')
  })

  it('Hoàn tác writes exactly one new copy (owned by the wire again); redo moves that copy too', async () => {
    const { id } = await linkedAndCopied()
    cut(id)
    await settle()
    lastToast(/Thùng rác/)!.action!.run() // Hoàn tác
    expect(folderTakes()).toEqual([id])
    await settle()
    expect(desk.writes).toHaveLength(2)
    expect(desk.writes[1].owner).toEqual({ folderId: 'f1', takeId: id, via: 'restore' })
    expect(lastToast(/Đã lưu lại/)!.text).toBe('Đã lưu lại S01·T1 vào “Phim” (bản cũ vẫn nằm trong Thùng rác).')
    const again = ownedGroups('f1', id)!
    expect(again).toHaveLength(1)
    redo()
    await settle()
    expect(desk.trashCalls).toHaveLength(2)
    expect(desk.trashCalls[1].items).toEqual([{ takeId: id, groupIds: again }])
    expect(desk.writes).toHaveLength(2)
  })

  it('Ctrl+Z of the wiring step moves only what that wiring copied (câu 9, điều 1)', async () => {
    const { id, groupId } = await linkedAndCopied()
    undo()
    expect(folderTakes()).toEqual([])
    await settle()
    expect(desk.trashCalls.map((c) => c.items)).toEqual([[{ takeId: id, groupIds: [groupId] }]])
    // redo brings the wire back: a new copy is written (the old one is in the Recycle Bin)
    redo()
    await settle()
    expect(desk.writes).toHaveLength(2)
    expect(desk.writes[1].owner?.via).toBe('restore')
  })

  it('"Lưu thêm bản nữa" while wired: both copies go ("2 bản")', async () => {
    const { id } = await linkedAndCopied()
    expect(await saveTakeToFolder(id, 'f1', { via: 'again' })).toBe(true)
    expect(desk.writes[desk.writes.length - 1].owner?.via).toBe('again')
    expect(ownedGroups('f1', id)).toHaveLength(2)
    cut(id)
    await settle()
    expect(desk.trashCalls[0].items[0].groupIds).toHaveLength(2)
    expect(lastToast(/Thùng rác/)!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim” và chuyển 2 bản (4 file) vào Thùng rác.')
  })

  it('nothing is moved: setting off, auto-save wire, take still auto-saved there', async () => {
    // setting off: the old wording, the record released (a wire made later never claims those files)
    const a = await linkedAndCopied()
    useDownloadPrefs.setState({ folderUnlinkTrash: false })
    cut(a.id)
    expect(lastToast(/vẫn còn/)!.text).toBe('Đã bỏ nối S01·T1 khỏi thư mục “Phim” (file đã lưu vẫn còn).')
    await settle()
    expect(ownedGroups('f1', a.id)).toBeNull()
    useDownloadPrefs.setState({ folderUnlinkTrash: true })

    // an auto-save wire (scene → folder) never moves files
    linkScenesToFolder(['s2'], 'f1')
    const b = await runToCompletion('s2')
    expect(desk.writes[desk.writes.length - 1].owner).toEqual({ folderId: 'f1', takeId: b, via: 'autosave' })
    cutEdge(edgeId('autosave', 's2', 'f1'))
    await settle()

    // the take's own wire cut while its scene still auto-saves there: kept
    const c = await runToCompletion('s1')
    linkTakesToFolder([c], 'f1')
    await settle()
    linkScenesToFolder(['s1'], 'f1')
    cut(c)
    await settle()
    expect(lastToast(/vẫn tự lưu/)).toBeTruthy()
    expect(desk.trashCalls).toEqual([])
  })

  it('never the last copy: SanoVids no longer has the video → the file in the folder is kept', async () => {
    const { id } = await linkedAndCopied()
    const take = useRuns.getState().takes.find((t) => t.id === id)!
    media.delete(take.videoId!)
    cut(id)
    await settle()
    expect(desk.trashCalls).toEqual([])
    expect(lastToast(/không còn bản video này/)).toBeTruthy()
  })

  it('an older desktop build (no trashSaved) or the web app: the old wording, no error', async () => {
    const { id } = await linkedAndCopied()
    delete (desk.bridge as { trashSaved?: unknown }).trashSaved
    cut(id)
    await settle()
    expect(lastToast(/vẫn còn/)!.text).toBe('Đã bỏ nối S01·T1 khỏi thư mục “Phim” (file đã lưu vẫn còn).')
    // web: no desktop bridge at all
    useUI.setState({ toasts: [] })
    wire(id)
    ;(globalThis as { window?: unknown }).window = {}
    cut(id)
    await settle()
    expect(lastToast(/vẫn còn/)).toBeTruthy()
    expect(desk.trashCalls).toEqual([])
  })

  it('review example 1: auto-save copied T1, its wire cut, T1 wired (nothing copied) → Ctrl+Z or a cut keeps the file', async () => {
    linkScenesToFolder(['s1'], 'f1')
    const id = await runToCompletion('s1')
    expect(desk.writes).toHaveLength(1)
    cutEdge(edgeId('autosave', 's1', 'f1'))
    await settle()
    linkTakesToFolder([id], 'f1') // "đã có trong thư mục rồi": not copied
    await settle()
    expect(desk.writes).toHaveLength(1)
    expect(ownedGroups('f1', id)).toEqual([])
    undo()
    await settle()
    expect(desk.trashCalls).toEqual([])
    expect(lastToast(/có từ trước/)!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. File trong thư mục có từ trước khi nối dây này nên được giữ.')
    // the same with a cut
    redo()
    await settle()
    cut(id)
    await settle()
    expect(desk.trashCalls).toEqual([])
  })

  it('review example 2: wired with the setting off, cut, setting on, wired again (nothing copied) → kept', async () => {
    useDownloadPrefs.setState({ folderUnlinkTrash: false })
    const { id } = await linkedAndCopied()
    cut(id)
    await settle()
    useDownloadPrefs.setState({ folderUnlinkTrash: true })
    linkTakesToFolder([id], 'f1')
    await settle()
    expect(desk.writes).toHaveLength(1)
    undo()
    await settle()
    redo()
    await settle()
    cut(id)
    await settle()
    expect(desk.trashCalls).toEqual([])
  })

  it('a wire made by an older build (no record of what it wrote): nothing is moved, "lưu từ bản SanoVids cũ"', async () => {
    const { id } = await linkedAndCopied()
    releaseOwned('f1', id) // as if wired / saved before this version
    cut(id)
    await settle()
    expect(desk.trashCalls).toEqual([])
    expect(lastToast(/bản SanoVids cũ/)).toBeTruthy()
    expect(wasSavedTo('f1', id)).toBe(true)
  })

  it('what the main process found: changed / failed (Thử lại) / missing', async () => {
    // edited after saving → kept, still counted as saved
    const a = await linkedAndCopied()
    desk.fileState.set('S01_T1 - Mở đầu.mp4', 'changed')
    cut(a.id)
    await settle()
    expect(lastToast(/đã bị sửa/)!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. Giữ lại “S01_T1 - Mở đầu.mp4” vì file đã bị sửa sau khi lưu.')
    expect(wasSavedTo('f1', a.id)).toBe(true)
    expect(ownedGroups('f1', a.id)).toBeNull()

    // open in VLC → failed, kept with its record; "Thử lại" once it is closed
    desk.fileState.clear()
    const b = await linkedAndCopied('s2')
    desk.fileState.set('S02_T1.mp4', 'failed')
    cut(b.id)
    await settle()
    const failed = lastToast(/không chuyển được/)!
    expect(failed.action?.label).toBe('Thử lại')
    expect(ownedGroups('f1', b.id)).toEqual([b.groupId])
    desk.fileState.delete('S02_T1.mp4')
    failed.action!.run()
    await settle()
    expect(desk.bin).toContain('S02_T1.mp4')
    expect(ownedGroups('f1', b.id)).toBeNull()

    // renamed → missing
    const c = await runToCompletion('s1')
    linkTakesToFolder([c], 'f1')
    await settle()
    desk.fileState.set(desk.writes[desk.writes.length - 1].files[0].name, 'missing')
    cut(c)
    await settle()
    expect(lastToast(/Không thấy file đã lưu/)).toBeTruthy()
  })

  it('the node now points at another folder: the files of the old one stay ("thư mục cũ")', async () => {
    const { id } = await linkedAndCopied()
    desk.pick('E:\\Phim B')
    await chooseFolderPlace('f1')
    cut(id)
    await settle()
    expect(desk.bin).toEqual([])
    expect(lastToast(/thư mục cũ/)).toBeTruthy()
    desk.pick(null)
  })

  it('"Lưu thêm bản nữa" from an old toast after the wire was cut writes nothing and says why', async () => {
    linkScenesToFolder(['s1'], 'f1')
    const id = await runToCompletion('s1') // auto-saved
    linkTakesToFolder([id], 'f1') // already there: the toast offers another copy
    const offer = lastToast(/đã có trong thư mục/)!
    cutEdge(edgeId('autosave', 's1', 'f1'))
    cut(id)
    await settle()
    const writes = desk.writes.length
    offer.action!.run()
    await settle()
    expect(desk.writes).toHaveLength(writes)
    expect(lastToast(/không còn nối với/)!.text).toBe('S01·T1 không còn nối với “Phim” — nối lại để lưu.')
  })

  it('bug A: a save waiting for its folder is not written once its wire was cut', async () => {
    desk.allowed.clear()
    useRuns.getState().enqueue(['s1'])
    const id = useRuns.getState().takes[useRuns.getState().takes.length - 1].id
    await vi.advanceTimersByTimeAsync(250)
    linkTakesToFolder([id], 'f1')
    prov.finish(id)
    await vi.advanceTimersByTimeAsync(500)
    expect(waitingTakes('f1')).toEqual([id])
    cut(id)
    await settle()
    expect(waitingTakes('f1')).toEqual([])
    desk.allowed.add('D:\\Phim')
    await refreshFolderNode('f1')
    expect(desk.writes).toHaveLength(0)
  })

  it('bug B: a wire cut while its copy is being written takes that copy along (after the write)', async () => {
    const id = await runToCompletion('s1')
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const write = desk.bridge.writeToFolder
    desk.bridge.writeToFolder = async (args) => {
      await gate
      return write(args)
    }
    try {
      linkTakesToFolder([id], 'f1')
      await settle()
      cut(id) // while writing
      await settle()
      expect(desk.trashCalls).toEqual([])
      release()
      await settle()
    } finally {
      desk.bridge.writeToFolder = write
    }
    expect(desk.writes).toHaveLength(1)
    expect(desk.trashCalls).toHaveLength(1)
    expect(desk.bin).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
    expect(wasSavedTo('f1', id)).toBe(false)
  })

  it('folder unreachable: the move waits, happens when the folder is back; wired again first → nothing waits', async () => {
    const a = await linkedAndCopied()
    desk.setExists(false)
    cut(a.id)
    await settle()
    expect(trashWaitingTakes('f1')).toEqual([a.id])
    expect(folderRuntime('f1').trashPending).toBe(1)
    expect(lastToast(/khi thư mục có lại/)).toBeTruthy()
    desk.setExists(true)
    await refreshFolderNode('f1')
    await settle()
    expect(desk.trashCalls).toHaveLength(2)
    expect(desk.bin).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
    expect(trashWaitingTakes('f1')).toEqual([])
    expect(lastToast(/file chờ xoá/)!.text).toBe('Đã chuyển 2 file chờ xoá vào Thùng rác (thư mục “Phim”).')

    // cut while away, then wired again before it is back: the pending move is dropped
    const b = await linkedAndCopied('s2')
    desk.setExists(false)
    cut(b.id)
    await settle()
    expect(trashWaitingTakes('f1')).toEqual([b.id])
    linkTakesToFolder([b.id], 'f1')
    expect(trashWaitingTakes('f1')).toEqual([])
    desk.setExists(true)
    const calls = desk.trashCalls.length
    await refreshFolderNode('f1')
    await settle()
    expect(desk.trashCalls).toHaveLength(calls)
  })

  it('deleting the video / the scene, removing the folder node or choosing another folder never moves files', async () => {
    const a = await linkedAndCopied()
    useRuns.getState().removeTakes([a.id])
    await settle()
    const b = await linkedAndCopied('s2')
    removeFolderNode('f1')
    await settle()
    undo()
    await settle()
    useProject.getState().deleteItems({ sceneIds: ['s2'] })
    await settle()
    undo()
    await settle()
    useProject.getState().setFolderPlace('f1', { name: 'Phim', path: 'D:\\Phim' })
    await settle()
    expect(desk.trashCalls).toEqual([])
    expect(folderTakes()).toEqual([b.id])
  })

  it('Delete of 450 wires into one folder: 3 calls (200 + 200 + 50), after one confirmation', async () => {
    const takes: Take[] = []
    for (let i = 0; i < 450; i++) {
      const videoId = `vid_bulk_${i}`
      media.set(videoId, new Blob(['V'], { type: 'video/mp4' }))
      takes.push({
        id: `tk_bulk_${i}`,
        sceneId: 's1',
        number: i + 1,
        status: 'completed',
        progress: 100,
        createdAt: 1,
        startedAt: 1,
        finishedAt: 2,
        promptSnapshot: 'p',
        rawPromptSnapshot: 'p',
        refsSnapshot: [],
        videoRefsSnapshot: [],
        settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
        cost: 0,
        starred: false,
        posterId: null,
        videoId,
        error: null,
        position: null,
        provider: 'dev',
      })
    }
    useRuns.getState().loadRuns({ takes, credits: 1000, spent: 0 })
    const ids = takes.map((t) => t.id)
    useProject.getState().linkFolder('f1', 'save', ids)
    ids.forEach((id, i) => setOwned('f1', id, [(0xa000 + i).toString(16).padStart(16, '0')]))
    const asked: string[] = []
    Object.assign((globalThis as { window?: object }).window!, { confirm: (q: string) => (asked.push(q), true) })
    useUI.setState({ selectedIds: [], selectedEdgeIds: ids.map((id) => edgeId('save', id, 'f1')) })
    deleteSelection()
    expect(asked).toEqual(['Bỏ nối 450 video khỏi thư mục “Phim” và chuyển các file SanoVids đã lưu của chúng vào Thùng rác của Windows?'])
    expect(folderTakes()).toEqual([])
    await settle()
    expect(desk.trashCalls.map((c) => c.items.length)).toEqual([200, 200, 50])
    // groups the fake ledger does not know: kept, said in one summary toast
    expect(lastToast(/lưu từ bản cũ/)).toBeTruthy()
  })

  it('Delete of 5 wires: Cancel at the question changes nothing', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const { id } = await linkedAndCopied(i % 2 ? 's2' : 's1')
      ids.push(id)
    }
    const before = useProject.getState().project
    Object.assign((globalThis as { window?: object }).window!, { confirm: () => false })
    useUI.setState({ selectedIds: [], selectedEdgeIds: ids.map((id) => edgeId('save', id, 'f1')) })
    deleteSelection()
    await settle()
    expect(useProject.getState().project).toBe(before)
    expect(desk.trashCalls).toEqual([])
    expect(ids.every((id) => ownedGroups('f1', id)?.length === 1)).toBe(true)
  })

  it('the video moved but its .txt could not follow: "Thử lại" moves the .txt alone, and Hoàn tác still writes a copy', async () => {
    const { id, groupId } = await linkedAndCopied()
    desk.fileState.set('S01_T1 - Mở đầu.txt', 'failed')
    cut(id)
    await settle()
    expect(desk.bin).toEqual(['S01_T1 - Mở đầu.mp4'])
    const partial = lastToast(/chưa chuyển được/)!
    expect(partial.text).toMatch(/^Đã bỏ nối S01·T1 khỏi “Phim” và chuyển “S01_T1 - Mở đầu.mp4” vào Thùng rác\. Còn 1 file chưa chuyển được/)
    expect(partial.action?.label).toBe('Thử lại')
    expect(ownedGroups('f1', id)).toEqual([groupId]) // kept for the retry
    desk.fileState.clear()
    partial.action!.run()
    await settle()
    // main answers the companion alone (its primary went before): that is the .txt moved, not "không thấy file"
    expect(desk.trashCalls[1].items).toEqual([{ takeId: id, groupIds: [groupId] }])
    expect(desk.bin).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
    expect(lastToast(/Không thấy file đã lưu/)).toBeUndefined()
    expect(lastToast(/S01_T1 - Mở đầu\.txt/)!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim” và chuyển “S01_T1 - Mở đầu.txt” vào Thùng rác.')
    expect(ownedGroups('f1', id)).toBeNull()
    // the cut moved the video: bringing the wire back writes a new copy
    undo()
    await settle()
    expect(folderTakes()).toEqual([id])
    expect(desk.writes).toHaveLength(2)
    expect(desk.writes[1].owner?.via).toBe('restore')
  })

  it('a OneDrive online-only file is kept without "Thử lại" (T12), and its record is released', async () => {
    const { id } = await linkedAndCopied()
    desk.fileState.set('S01_T1 - Mở đầu.mp4', 'cloud')
    cut(id)
    await settle()
    expect(desk.bin).toEqual([])
    const t = lastToast(/OneDrive/)!
    expect(t.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. Giữ “S01_T1 - Mở đầu.mp4” vì file đang chỉ có trên OneDrive (chưa tải về máy).')
    expect(t.action?.label).toBe('Hoàn tác')
    expect(wasSavedTo('f1', id)).toBe(true)
    expect(ownedGroups('f1', id)).toBeNull()
  })

  it('afterSaveUnlinked keeps the record of pairs whose files could not be moved, releases the others', async () => {
    const { id } = await linkedAndCopied()
    useProject.getState().unlinkFolder('f1', 'save', id)
    desk.fileState.set('S01_T1 - Mở đầu.mp4', 'failed')
    const out = await afterSaveUnlinked([{ folderId: 'f1', takeId: id }], { source: 'cut', toast: 'none' })
    expect(out.map((o) => o.kind)).toEqual(['failed'])
    expect(ownedGroups('f1', id)).toHaveLength(1)
  })

  /** The main process takes its time (hashing a big file on a USB disk): files:trashSaved answers once released. */
  function slowTrash() {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const real = desk.bridge.trashSaved!
    let started = 0
    desk.bridge.trashSaved = async (args) => {
      started++
      await gate
      return real(args)
    }
    return { release, started: () => started }
  }

  it('wired again by hand while the main process moves its files: the copy is written again, owned by the wire (never "đã có rồi")', async () => {
    const { id, groupId } = await linkedAndCopied()
    const main = slowTrash()
    cut(id)
    await settle()
    expect(main.started()).toBe(1) // main is hashing…
    useUI.setState({ toasts: [] })
    linkTakesToFolder([id], 'f1') // the user drags the video back to the folder
    await settle()
    expect(lastToast(/đã có trong thư mục/)).toBeUndefined()
    main.release()
    await settle()
    // the cut's copy went to the Recycle Bin; the wire that is back got a new copy, recorded as its own
    expect(folderTakes()).toEqual([id])
    expect(desk.bin).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
    expect(desk.writes).toHaveLength(2)
    expect(desk.writes[1].owner).toEqual({ folderId: 'f1', takeId: id, via: 'restore' })
    expect(wasSavedTo('f1', id)).toBe(true)
    const owned = ownedGroups('f1', id)!
    expect(owned).toHaveLength(1)
    expect(owned[0]).not.toBe(groupId)
    expect(lastToast(/Đã lưu lại/)!.text).toBe('Đã lưu lại S01·T1 vào “Phim” (bản cũ vẫn nằm trong Thùng rác).')
    expect(lastToast(/^Đã bỏ nối/)).toBeUndefined() // the undone cut is not announced
    // that new copy is the wire's: a later cut moves it
    cut(id)
    await settle()
    expect(desk.trashCalls.at(-1)!.items).toEqual([{ takeId: id, groupIds: owned }])
  })

  it('Ctrl+Z while the main process moves the files: exactly one copy is written again', async () => {
    const { id } = await linkedAndCopied()
    const main = slowTrash()
    cut(id)
    await settle()
    undo()
    await settle()
    main.release()
    await settle()
    expect(folderTakes()).toEqual([id])
    expect(desk.writes).toHaveLength(2)
    expect(desk.writes[1].owner?.via).toBe('restore')
  })

  it('a video deleted while its saved copy goes to the Recycle Bin waits — never the last copy only in the bin', async () => {
    const { id } = await linkedAndCopied()
    const videoId = takeOf(id).videoId!
    const main = slowTrash()
    cut(id)
    await settle()
    expect(main.started()).toBe(1)
    expect(deleteTakes([id], { confirm: false, toast: false })).toBe(0)
    expect(useRuns.getState().takes.some((t) => t.id === id)).toBe(true)
    expect(media.has(videoId)).toBe(true)
    expect(lastToast(/Chưa xoá/)!.text).toBe('Chưa xoá S01·T1: SanoVids đang chuyển file đã lưu vào Thùng rác — thử lại sau giây lát.')
    main.release()
    await settle()
    expect(desk.bin).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
    // once the move is done the video can be deleted (SanoVids had it while its copy was moved)
    expect(deleteTakes([id], { confirm: false, toast: false })).toBe(1)
    await settle()
    expect(media.has(videoId)).toBe(false)
  })

  it('the setting is decided at the gesture: off at the cut → the files stay, even when turned on before the folder is free', async () => {
    const { id } = await linkedAndCopied()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const write = desk.bridge.writeToFolder
    desk.bridge.writeToFolder = async (args) => {
      await gate
      return write(args)
    }
    try {
      void saveTakeToFolder(id, 'f1', { via: 'again' }) // holds the folder's lock while it is written
      await settle()
      useDownloadPrefs.setState({ folderUnlinkTrash: false })
      cut(id)
      expect(lastToast(/vẫn còn/)!.text).toBe('Đã bỏ nối S01·T1 khỏi thư mục “Phim” (file đã lưu vẫn còn).')
      useDownloadPrefs.setState({ folderUnlinkTrash: true }) // turned on meanwhile
      release()
      await settle()
    } finally {
      desk.bridge.writeToFolder = write
    }
    expect(desk.trashCalls).toEqual([])
    expect(desk.bin).toEqual([])
    expect(ownedGroups('f1', id)).toBeNull() // dealt with: a wire made later never claims those files
    expect(lastToast(/Thùng rác/)).toBeUndefined()
  })

  it('wired again by hand after a cut whose files wait for the folder: the new wire owns nothing (Ctrl+Z of it keeps the file)', async () => {
    const { id } = await linkedAndCopied()
    desk.setExists(false)
    cut(id)
    await settle()
    expect(trashWaitingTakes('f1')).toEqual([id])
    desk.setExists(true)
    linkTakesToFolder([id], 'f1') // "đã có trong thư mục rồi": nothing copied, the pending move dropped
    await settle()
    expect(trashWaitingTakes('f1')).toEqual([])
    expect(ownedGroups('f1', id)).toEqual([])
    const calls = desk.trashCalls.length
    undo()
    await settle()
    expect(desk.trashCalls).toHaveLength(calls)
    expect(desk.bin).toEqual([])
    expect(lastToast(/có từ trước/)).toBeTruthy()
  })

  it('Hoàn tác of a cut whose files wait for the folder: the wire is the same wire again (a later cut moves its copy)', async () => {
    const { id, groupId } = await linkedAndCopied()
    desk.setExists(false)
    cut(id)
    await settle()
    lastToast(/khi thư mục có lại/)!.action!.run() // Hoàn tác
    await settle()
    expect(trashWaitingTakes('f1')).toEqual([])
    expect(ownedGroups('f1', id)).toEqual([groupId])
    desk.setExists(true)
    cut(id)
    await settle()
    expect(desk.bin).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
  })

  it('a move that waited more than 30 days for its folder is dropped: its record released, the node says the files were kept', async () => {
    const { id } = await linkedAndCopied()
    desk.setExists(false)
    cut(id)
    await settle()
    expect(ownedGroups('f1', id)).toHaveLength(1)
    const expiredBefore = folderRuntime('f1').trashExpired
    vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000)
    expect(trashWaitingTakes('f1')).toEqual([])
    expect(ownedGroups('f1', id)).toBeNull()
    expect(folderRuntime('f1')).toMatchObject({ trashPending: 0, trashExpired: expiredBefore + 1 })
    // a wire made later owns nothing of it: Ctrl+Z / a cut keeps the file
    desk.setExists(true)
    linkTakesToFolder([id], 'f1')
    await settle()
    expect(ownedGroups('f1', id)).toEqual([])
  })

  /** Five finished videos wired into f1 in ONE step (each copied by that wiring). */
  async function fiveWired() {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await runToCompletion(i % 2 ? 's2' : 's1'))
    linkTakesToFolder(ids, 'f1')
    await settle()
    expect(ids.every((id) => ownedGroups('f1', id)?.length === 1)).toBe(true)
    return ids
  }

  it('Ctrl+Z of a step that wired 5 copied videos asks first; "Huỷ" keeps every file (the jump itself stays)', async () => {
    const ids = await fiveWired()
    const asked: string[] = []
    Object.assign((globalThis as { window?: object }).window!, { confirm: (q: string) => (asked.push(q), false) })
    undo()
    await settle()
    expect(asked).toEqual(['Bỏ nối 5 video khỏi thư mục “Phim” và chuyển các file SanoVids đã lưu của chúng vào Thùng rác của Windows?'])
    expect(folderTakes()).toEqual([])
    expect(desk.trashCalls).toEqual([])
    expect(desk.bin).toEqual([])
    expect(ids.every((id) => ownedGroups('f1', id) === null)).toBe(true)
    expect(lastToast(/Đã giữ nguyên/)!.text).toBe('Đã giữ nguyên các file đã lưu của 5 video (không chuyển vào Thùng rác).')
  })

  it('… and OK moves them (one call for the 5 videos)', async () => {
    const ids = await fiveWired()
    Object.assign((globalThis as { window?: object }).window!, { confirm: () => true })
    undo()
    await settle()
    expect(desk.trashCalls).toHaveLength(1)
    expect(desk.trashCalls[0].items.map((i) => i.takeId).sort()).toEqual([...ids].sort())
    expect(desk.bin).toHaveLength(10)
  })
})

describe('stored ownership record and "chờ xoá" list are repaired value by value', () => {
  it('bdp:folder-link-owned', () => {
    const g = '0123456789abcdef'
    expect(
      parseFolderOwned({
        'f1:t1': [g, g, 'nothex', 7, 'ABCDEF0123456789'],
        'f1:t2': [],
        nokey: [g],
        'f1:t3': 'x',
        'a:b:c': [g],
        '__proto__:x': [g],
      }),
    ).toEqual({ 'f1:t1': [g, 'ABCDEF0123456789'], 'f1:t2': [] })
    // at most 20 groups per pair (the most recent)
    const many = Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(16, '0'))
    expect(parseFolderOwned({ 'f:t': many })['f:t']).toEqual(many.slice(-20))
    expect(parseFolderOwned(null)).toEqual({})
    expect(parseFolderOwned([1])).toEqual({})
  })

  it('bdp:folder-trash-waiting (30 days at most)', () => {
    const now = 1_800_000_000_000
    const day = 24 * 3600 * 1000
    expect(
      parseFolderTrashWaiting(
        {
          f1: [
            { takeId: 't1', at: now - day },
            { takeId: 't1', at: now },
            { takeId: 't2', at: now - 31 * day },
            { takeId: 't3', at: 'x' },
            { takeId: '', at: now },
            'bad',
            { takeId: 't4', at: now + 3_600_000 },
          ],
          f2: 'x',
          f3: [],
        },
        now,
      ),
    ).toEqual({ f1: [{ takeId: 't1', at: now - day }] })
    expect(parseFolderTrashWaiting(null, now)).toEqual({})
    // the entries that expired (their record is released by saveFolders): well formed, older than 30 days, not waiting again
    expect(
      expiredFolderTrashWaiting(
        {
          f1: [
            { takeId: 't1', at: now - 40 * day },
            { takeId: 't1', at: now - day }, // waits again (cut again later): not expired
            { takeId: 't2', at: now - 31 * day },
            { takeId: 't2', at: now - 35 * day },
            { takeId: 't3', at: 'x' },
            { takeId: 't4', at: now + 3_600_000 }, // from the future: invalid, not expired
          ],
          f2: 'x',
        },
        now,
      ),
    ).toEqual([{ folderId: 'f1', takeId: 't2' }])
    expect(expiredFolderTrashWaiting(null, now)).toEqual([])
  })
})

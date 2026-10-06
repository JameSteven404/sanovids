// Saving generated videos to disk: one-click download, batch zip, and optional auto-download when a take finishes.
// "Hỏi nơi lưu & tên file" (askWhere, default on): a click on "Tải video" / the zip opens a save dialog — the desktop
// app's native one (lib/desktopFiles.ts), Chromium's save picker, else (Firefox / Safari) the browser download with a
// toast saying why. Otherwise: when the user picked a folder (File System Access API), files are written there
// directly; else the browser (or the desktop app) saves them to the Downloads folder.
// Folder nodes on the canvas ("Thư mục") write through lib/saveFolders.ts.
import { createStore, del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import { companionFor, freeNames, safeFileName } from '../core/fileNames'
import { checkNameTemplate, DEFAULT_NAME_TEMPLATE } from '../core/nameTemplate'
import { desktopFiles, toDesktopFiles } from './desktopFiles'
import { getBlob } from './imageStore'

export { freeNames, numberedName, safeFileName } from '../core/fileNames'

/** Small settings database (IndexedDB): folder handles live here (they cannot go to localStorage). */
export const settingsStore = createStore('ban-dung-phim-settings', 'kv')
const store = settingsStore
const DIR_KEY = 'download-directory'

export interface DownloadPrefs {
  /** Save video + prompt automatically when a take finishes. */
  autoDownload: boolean
  /** Name of the chosen folder (null = browser Downloads). */
  folderName: string | null
  /** Also save a .txt with the prompt next to each video (like canvasapp). Folder nodes follow it too. */
  withPrompt: boolean
  /**
   * "Hỏi nơi lưu & tên file": a click on Tải video / the zip asks where to save and under which name (save dialog).
   * Auto-downloads and folder nodes never ask.
   */
  askWhere: boolean
  /** "Tải .zip các video chọn" adds a prompts.txt with the prompt of every video (default on). */
  zipPrompts: boolean
  /** Default file name of a video (core/nameTemplate), e.g. '{scene}_{take} - {title}'. A take's own "Tên file" wins. */
  nameTemplate: string
  /**
   * "Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác" (default on; desktop app only): cutting a take → folder
   * wire moves the files that wire itself copied there, unchanged, to the Recycle Bin (core/folderTrash, folderActions).
   */
  folderUnlinkTrash: boolean
}

export const DOWNLOAD_PREFS_KEY = 'bdp:pref:downloads'
export const DEFAULT_DOWNLOAD_PREFS: DownloadPrefs = {
  autoDownload: false,
  folderName: null,
  withPrompt: true,
  askWhere: true,
  zipPrompts: true,
  nameTemplate: DEFAULT_NAME_TEMPLATE,
  folderUnlinkTrash: true,
}
const BOOL_KEYS = ['autoDownload', 'withPrompt', 'askWhere', 'zipPrompts', 'folderUnlinkTrash'] as const

/** The valid part of `patch` (wrong types, an invalid name template… are left out). */
export function validDownloadPatch(patch: unknown): Partial<DownloadPrefs> {
  const out: Partial<DownloadPrefs> = {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  const p = patch as Partial<Record<keyof DownloadPrefs, unknown>>
  for (const k of BOOL_KEYS) if (typeof p[k] === 'boolean') out[k] = p[k]
  if (p.folderName === null || (typeof p.folderName === 'string' && p.folderName.trim())) out.folderName = p.folderName as string | null
  if (p.nameTemplate !== undefined) {
    const c = checkNameTemplate(p.nameTemplate)
    if (c.ok) out.nameTemplate = c.template
  }
  return out
}

/** Stored JSON → prefs: every value checked, anything missing or wrong falls back to its default. */
export function parseDownloadPrefs(raw: string | null | undefined): DownloadPrefs {
  if (!raw) return { ...DEFAULT_DOWNLOAD_PREFS }
  try {
    return { ...DEFAULT_DOWNLOAD_PREFS, ...validDownloadPatch(JSON.parse(raw)) }
  } catch {
    return { ...DEFAULT_DOWNLOAD_PREFS }
  }
}

function readPrefs(): DownloadPrefs {
  try {
    return parseDownloadPrefs(localStorage.getItem(DOWNLOAD_PREFS_KEY))
  } catch {
    return { ...DEFAULT_DOWNLOAD_PREFS }
  }
}

export const useDownloadPrefs = create<DownloadPrefs & { set: (patch: Partial<DownloadPrefs>) => void }>()((setState, getState) => ({
  ...readPrefs(),
  set: (patch) => {
    const next = validDownloadPatch(patch)
    if (!Object.keys(next).length) return
    setState(next)
    const { autoDownload, folderName, withPrompt, askWhere, zipPrompts, nameTemplate, folderUnlinkTrash } = getState()
    try {
      localStorage.setItem(DOWNLOAD_PREFS_KEY, JSON.stringify({ autoDownload, folderName, withPrompt, askWhere, zipPrompts, nameTemplate, folderUnlinkTrash }))
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
  },
}))

/** Folder writing is available (Chromium browsers and the desktop app). */
export const canPickFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

/** File System Access writer (Chromium). */
export interface FsWritable {
  write(d: Blob | string): Promise<void>
  close(): Promise<void>
}
export interface FsFileHandle {
  name: string
  createWritable(): Promise<FsWritable>
}
/** File System Access directory handle (Chromium); stored in IndexedDB, survives restarts (permission may not). */
export interface DirHandle {
  name: string
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>
  getFileHandle(name: string, o?: { create: boolean }): Promise<FsFileHandle>
}

export async function pickDownloadFolder(): Promise<string | null> {
  if (!canPickFolder()) return null
  try {
    const handle = (await (window as unknown as { showDirectoryPicker(o: { mode: 'readwrite' }): Promise<DirHandle> }).showDirectoryPicker({
      mode: 'readwrite',
    })) as DirHandle
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return null
    await set(DIR_KEY, handle, store)
    useDownloadPrefs.getState().set({ folderName: handle.name })
    return handle.name
  } catch {
    return null // user cancelled
  }
}

export async function clearDownloadFolder() {
  await del(DIR_KEY, store).catch(() => undefined)
  useDownloadPrefs.getState().set({ folderName: null })
}

/**
 * The chosen folder and whether we may write to it (asks again when `interactive`, i.e. right after a click).
 * After a browser/app restart the permission is usually back to "ask", so a background save has none.
 */
async function folderAccess(interactive: boolean): Promise<{ handle: DirHandle | null; granted: boolean }> {
  let handle: DirHandle | null
  try {
    handle = ((await get(DIR_KEY, store)) as DirHandle | undefined) ?? null
  } catch {
    return { handle: null, granted: false }
  }
  if (!handle) {
    // Site data was cleared: stop showing a folder we no longer have.
    if (useDownloadPrefs.getState().folderName) useDownloadPrefs.getState().set({ folderName: null })
    return { handle: null, granted: false }
  }
  try {
    let perm = await handle.queryPermission({ mode: 'readwrite' })
    if (perm !== 'granted' && interactive) perm = await handle.requestPermission({ mode: 'readwrite' })
    return { handle, granted: perm === 'granted' }
  } catch {
    return { handle, granted: false }
  }
}

/** Call at the start of a click handler that saves later (e.g. after zipping): asks for the folder permission while the click still counts. */
export async function prepareFolderAccess(): Promise<void> {
  await folderAccess(true)
}

export interface FileToSave {
  name: string
  data: Blob | string
}

export interface SaveResult {
  /** folder = written to the chosen folder · browser = browser download (Downloads) · pending = waits for the folder permission */
  to: 'folder' | 'browser' | 'pending'
  /** Name of the chosen folder (also when it could not be used). */
  folder?: string
  /** Final file names, in order (a " (2)" suffix instead of overwriting an existing file). */
  names: string[]
  /** Why the chosen folder was not used. */
  reason?: 'no-permission' | 'missing-folder'
  /** Earlier auto-downloads that were waiting for the permission and got saved too. */
  alsoSaved?: number
}

export const errName = (e: unknown) => (e as { name?: string } | null)?.name ?? ''

async function fileExists(dir: DirHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch (e) {
    if (errName(e) === 'NotFoundError') return false
    if (errName(e) === 'TypeMismatchError') return true // a folder with that name
    throw e
  }
}

/** Vietnamese text for a file-system error (the browser's messages are English). */
export function fsError(e: unknown): Error {
  switch (errName(e)) {
    case 'QuotaExceededError':
      return new Error('Ổ đĩa đã đầy.')
    case 'NoModificationAllowedError':
    case 'InvalidModificationError':
    case 'InvalidStateError':
      return new Error('File đang bị chương trình khác mở hoặc khoá.')
    case 'TypeMismatchError':
      return new Error('Đã có một thư mục trùng tên với file.')
    default:
      return e instanceof Error ? e : new Error(String(e))
  }
}

/** Write a group of files without overwriting anything already in the folder. Returns the names used. */
export async function writeGroup(dir: DirHandle, files: FileToSave[]): Promise<string[]> {
  const names = await freeNames(
    files.map((f) => f.name),
    (n) => fileExists(dir, n),
  )
  for (let i = 0; i < files.length; i++) {
    const fh = await dir.getFileHandle(names[i], { create: true })
    const w = await fh.createWritable()
    await w.write(files[i].data)
    await w.close()
  }
  return names
}

/** Auto-downloads waiting for the folder permission (one group per take), saved by the next click that grants it. */
const pending: FileToSave[][] = []
export const pendingDownloadCount = () => pending.reduce((n, g) => n + g.length, 0)

/** Plain browser download (anchor): the browser / desktop app puts it in Downloads (numbered on a clash). */
export function browserDownload(file: FileToSave) {
  const blob = typeof file.data === 'string' ? new Blob([file.data], { type: 'text/plain;charset=utf-8' }) : file.data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

/**
 * Save files to the chosen folder, or through the browser download. `interactive` = triggered by a click
 * (may show a permission prompt for the folder). An existing file is never overwritten (" (2)" is added).
 * A background save (auto-download) without the folder permission keeps the files until a click grants it
 * (`to: 'pending'`) instead of silently sending them to Downloads.
 */
export async function saveFiles(files: FileToSave[], interactive: boolean): Promise<SaveResult> {
  const { handle, granted } = await folderAccess(interactive)
  if (handle && granted) {
    let names: string[]
    try {
      names = await writeGroup(handle, files)
    } catch (e) {
      // Folder moved/deleted or permission withdrawn: the browser download still works.
      if (!fallsBack(e)) throw fsError(e)
      for (const f of files) browserDownload(f)
      return { to: 'browser', folder: handle.name, names: files.map((f) => f.name), reason: errName(e) === 'NotFoundError' ? 'missing-folder' : 'no-permission' }
    }
    // The permission is back: save what was waiting for it too (what fails keeps waiting).
    let alsoSaved = 0
    try {
      while (pending.length) {
        await writeGroup(handle, pending[0])
        alsoSaved += pending.shift()!.length
      }
    } catch {
      /* stays pending */
    }
    return { to: 'folder', folder: handle.name, names, alsoSaved }
  }
  if (handle && !interactive) {
    pending.push(files)
    return { to: 'pending', folder: handle.name, names: files.map((f) => f.name) }
  }
  for (const f of files) browserDownload(f)
  return { to: 'browser', folder: handle?.name, names: files.map((f) => f.name), reason: handle ? 'no-permission' : undefined }
}

/** Errors after which the browser download is used instead of the folder. */
const fallsBack = (e: unknown) => errName(e) === 'NotFoundError' || errName(e) === 'NotAllowedError'

/**
 * From a click (toast button): ask for the folder permission and save every waiting auto-download — to the
 * folder, or to Downloads when the permission is refused or the folder is gone. Null when nothing was waiting.
 */
export async function savePendingDownloads(): Promise<SaveResult | null> {
  if (!pending.length) return null
  let rest = pending.splice(0)
  const { handle, granted } = await folderAccess(true)
  const names: string[] = []
  let reason: SaveResult['reason'] = handle ? 'no-permission' : undefined
  if (handle && granted) {
    try {
      while (rest.length) {
        names.push(...(await writeGroup(handle, rest[0])))
        rest = rest.slice(1)
      }
      return { to: 'folder', folder: handle.name, names }
    } catch (e) {
      if (!fallsBack(e)) {
        pending.unshift(...rest) // keep what was not written
        throw fsError(e)
      }
      reason = errName(e) === 'NotFoundError' ? 'missing-folder' : 'no-permission'
    }
  }
  const left = rest.flat()
  for (const f of left) browserDownload(f)
  return { to: 'browser', folder: handle?.name, names: left.map((f) => f.name), reason }
}

export function extOfBlob(blob: Blob, fallback = 'webm'): string {
  const t = blob.type
  if (t.includes('mp4')) return 'mp4'
  if (t.includes('webm')) return 'webm'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('png')) return 'png'
  return fallback
}

/**
 * Files for one take: `<base>.<ext>` (video, or poster when there is no video) + `<base>.txt` with the prompt.
 * EMPTY when that video / poster is missing from storage — never a lone prompt .txt that would look like a download.
 */
export async function takeFiles(
  take: { videoId: string | null; posterId: string | null; promptSnapshot: string },
  base: string,
  withPrompt: boolean,
): Promise<FileToSave[]> {
  const id = take.videoId ?? take.posterId
  const blob = id ? await getBlob(id) : null
  if (!blob) return []
  const files: FileToSave[] = [{ name: `${safeFileName(base)}.${extOfBlob(blob, take.videoId ? 'webm' : 'jpg')}`, data: blob }]
  if (withPrompt && take.promptSnapshot) files.push({ name: `${safeFileName(base)}.txt`, data: take.promptSnapshot })
  return files
}

// ---------------- "Hỏi nơi lưu & tên file" (askWhere) ----------------
/** How a "save as" goes on (prepareSaveAs → runSaveAs). */
export type SaveAsPlan =
  /** Desktop app: the native dialog opens when the files are handed over (no click deadline there). */
  | { kind: 'desktop'; title?: string }
  /** Chromium: the save picker already ran (it must open while the click still counts); the file is written there. */
  | { kind: 'picker'; handle: FsFileHandle }
  /** No save dialog in this browser: normal download (Downloads) — the caller says why in a toast. */
  | { kind: 'fallback' }

export interface SaveAsResult {
  /** chosen = saved where the user picked · browser = no dialog available, browser download · canceled = dialog closed */
  to: 'chosen' | 'browser' | 'canceled'
  /** Desktop app: full path of the saved file. */
  path?: string
  /** Final names: the chosen one first, then the files saved next to it (prompt .txt). */
  names: string[]
}

type SavePicker = (o: { suggestedName?: string; id?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FsFileHandle>

const PICKER_TYPES: Record<string, { description: string; mime: string }> = {
  mp4: { description: 'Video MP4', mime: 'video/mp4' },
  webm: { description: 'Video WebM', mime: 'video/webm' },
  mov: { description: 'Video MOV', mime: 'video/quicktime' },
  zip: { description: 'Tệp nén ZIP', mime: 'application/zip' },
  jpg: { description: 'Ảnh JPEG', mime: 'image/jpeg' },
  png: { description: 'Ảnh PNG', mime: 'image/png' },
  txt: { description: 'Văn bản', mime: 'text/plain' },
}

/** "clip.MP4" → "mp4" ('' without extension). */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** A save dialog exists here (desktop app, or a Chromium browser). */
export function canSaveAs(): boolean {
  return !!desktopFiles() || (typeof window !== 'undefined' && 'showSaveFilePicker' in window)
}

/**
 * Step 1 of a "save as". In a browser the save picker must open while the click still counts: call this at the start
 * of the click handler, before reading or zipping anything slow. 'canceled' = the user closed the picker.
 */
export async function prepareSaveAs(suggestedName: string, opts: { title?: string } = {}): Promise<SaveAsPlan | 'canceled'> {
  if (desktopFiles()) return { kind: 'desktop', title: opts.title }
  const w = typeof window !== 'undefined' ? (window as unknown as { showSaveFilePicker?: SavePicker }) : null
  if (!w?.showSaveFilePicker) return { kind: 'fallback' }
  const ext = extOf(suggestedName)
  const type = PICKER_TYPES[ext]
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: safeFileName(suggestedName),
      id: 'sanovids-save',
      ...(type ? { types: [{ description: type.description, accept: { [type.mime]: ['.' + ext] } }] } : {}),
    })
    return { kind: 'picker', handle }
  } catch (e) {
    if (errName(e) === 'AbortError') return 'canceled'
    // No user activation left (SecurityError) or a blocked picker: the normal download still works.
    return { kind: 'fallback' }
  }
}

/**
 * Step 2: save `files` — files[0] where the user chose (under the chosen name), the others (the prompt .txt) next to
 * it with the same base name: written by the desktop app beside the video (never overwriting), downloaded by the
 * browser (a web page cannot write next to a file it was given).
 */
export async function runSaveAs(plan: SaveAsPlan, files: FileToSave[]): Promise<SaveAsResult> {
  if (!files.length) return { to: 'canceled', names: [] }
  if (plan.kind === 'desktop') {
    const bridge = desktopFiles()
    if (!bridge) throw new Error('Bản desktop này chưa có hộp thoại lưu file.')
    const res = await bridge.saveAs({ suggestedName: files[0].name, title: plan.title, files: await toDesktopFiles(files) })
    if (res.ok) return { to: 'chosen', path: res.path, names: res.names }
    if (res.canceled) return { to: 'canceled', names: [] }
    throw new Error(res.message)
  }
  if (plan.kind === 'picker') {
    try {
      const w = await plan.handle.createWritable()
      await w.write(files[0].data)
      await w.close()
    } catch (e) {
      throw fsError(e)
    }
    const names = [plan.handle.name]
    for (const f of files.slice(1)) {
      const name = companionFor(plan.handle.name, f.name)
      browserDownload({ name, data: f.data })
      names.push(name)
    }
    return { to: 'chosen', names }
  }
  for (const f of files) browserDownload(f)
  return { to: 'browser', names: files.map((f) => f.name) }
}

/** Both steps at once (the files are ready: nothing slow happens before the dialog). */
export async function saveFilesAs(files: FileToSave[], opts: { title?: string } = {}): Promise<SaveAsResult> {
  if (!files.length) return { to: 'canceled', names: [] }
  const plan = await prepareSaveAs(files[0].name, opts)
  if (plan === 'canceled') return { to: 'canceled', names: [] }
  return runSaveAs(plan, files)
}

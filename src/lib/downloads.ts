// Saving generated videos to disk: one-click download, batch zip, and optional auto-download when a take finishes.
// When the user picked a folder (File System Access API), files are written there directly; otherwise the browser
// (or the desktop app) saves them to the Downloads folder.
import { createStore, del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import { getBlob } from './imageStore'

const store = createStore('ban-dung-phim-settings', 'kv')
const DIR_KEY = 'download-directory'

export interface DownloadPrefs {
  /** Save video + prompt automatically when a take finishes. */
  autoDownload: boolean
  /** Name of the chosen folder (null = browser Downloads). */
  folderName: string | null
  /** Also save a .txt with the prompt next to each video (like canvasapp). */
  withPrompt: boolean
}

function readPrefs(): DownloadPrefs {
  try {
    const raw = localStorage.getItem('bdp:pref:downloads')
    if (raw) return { autoDownload: false, folderName: null, withPrompt: true, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { autoDownload: false, folderName: null, withPrompt: true }
}

export const useDownloadPrefs = create<DownloadPrefs & { set: (patch: Partial<DownloadPrefs>) => void }>()((setState, getState) => ({
  ...readPrefs(),
  set: (patch) => {
    setState(patch)
    const { autoDownload, folderName, withPrompt } = getState()
    try {
      localStorage.setItem('bdp:pref:downloads', JSON.stringify({ autoDownload, folderName, withPrompt }))
    } catch {
      /* ignore */
    }
  },
}))

/** Folder writing is available (Chromium browsers and the desktop app). */
export const canPickFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

interface DirHandle {
  name: string
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>
  getFileHandle(name: string, o?: { create: boolean }): Promise<{ createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }> }>
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

/** "S01_T1.webm", 2 → "S01_T1 (2).webm" (the same rule as the browser / desktop app downloads). */
export function numberedName(name: string, n: number): string {
  if (n < 2) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

/**
 * Names for a group of files (a video and its .txt) that do not exist yet: the same " (n)" suffix for the whole
 * group, so the pair stays matched.
 */
export async function freeNames(names: string[], exists: (name: string) => boolean | Promise<boolean>): Promise<string[]> {
  for (let n = 1; n < 1000; n++) {
    const candidate = names.map((x) => numberedName(x, n))
    let free = true
    for (const c of candidate) {
      if (await exists(c)) {
        free = false
        break
      }
    }
    if (free) return candidate
  }
  return names.map((x) => numberedName(x, Date.now()))
}

const errName = (e: unknown) => (e as { name?: string } | null)?.name ?? ''

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
function fsError(e: unknown): Error {
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
async function writeGroup(dir: DirHandle, files: FileToSave[]): Promise<string[]> {
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

export function safeFileName(name: string): string {
  return (
    name
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video'
  )
}

function browserDownload(file: FileToSave) {
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

/** Files for one take: `<base>.<ext>` (video, or poster when there is no video) + `<base>.txt` with the prompt. */
export async function takeFiles(take: { videoId: string | null; posterId: string | null; promptSnapshot: string }, base: string, withPrompt: boolean) {
  const files: FileToSave[] = []
  const id = take.videoId ?? take.posterId
  const blob = id ? await getBlob(id) : null
  if (blob) files.push({ name: `${safeFileName(base)}.${extOfBlob(blob, take.videoId ? 'webm' : 'jpg')}`, data: blob })
  if (withPrompt && take.promptSnapshot) files.push({ name: `${safeFileName(base)}.txt`, data: take.promptSnapshot })
  return files
}

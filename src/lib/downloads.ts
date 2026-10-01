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
  getFileHandle(name: string, o: { create: boolean }): Promise<{ createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }> }>
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

/** The chosen folder if we still have write permission (asks again when `interactive`). */
async function writableFolder(interactive: boolean): Promise<DirHandle | null> {
  const handle = (await get(DIR_KEY, store).catch(() => null)) as DirHandle | null
  if (!handle) return null
  try {
    let perm = await handle.queryPermission({ mode: 'readwrite' })
    if (perm !== 'granted' && interactive) perm = await handle.requestPermission({ mode: 'readwrite' })
    return perm === 'granted' ? handle : null
  } catch {
    return null
  }
}

export interface FileToSave {
  name: string
  data: Blob | string
}

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
 * (may show a permission prompt for the folder). Returns where the files went.
 */
export async function saveFiles(files: FileToSave[], interactive: boolean): Promise<{ to: 'folder' | 'browser'; folder?: string }> {
  const folder = await writableFolder(interactive)
  if (folder) {
    for (const f of files) {
      const fh = await folder.getFileHandle(f.name, { create: true })
      const w = await fh.createWritable()
      await w.write(f.data)
      await w.close()
    }
    return { to: 'folder', folder: folder.name }
  }
  for (const f of files) browserDownload(f)
  return { to: 'browser' }
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

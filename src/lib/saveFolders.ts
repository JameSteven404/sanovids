// "Thư mục" nodes: where their files go and how they are written (the node data lives in Project.folders).
//   Desktop app: through window.bdpDesktop.files (lib/desktopFiles.ts) — the main process writes only into folders the
//     user picked in this app (its allowlist), never overwriting.
//   Web (Chromium): a File System Access directory handle per folder id, kept in IndexedDB. After a restart the browser
//     usually asks again before writing ("Cấp lại quyền": needs a click). Firefox / Safari cannot write folders.
// Runtime state of each node (access, counters, last error, saves waiting for the permission) is the small store below;
// its counters and the saves still waiting are kept per browser / computer (localStorage), not in the project.
import { del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import type { SaveFolder } from '../core/types'
import { desktopFiles, toDesktopFiles } from './desktopFiles'
import { errName, fsError, settingsStore, writeGroup, type DirHandle, type FileToSave } from './downloads'

/**
 * ok          writable now
 * ask         web: the browser must be allowed again to write there (a click on "Cấp lại quyền")
 * pick        no folder chosen on this computer / browser (or not allowed here): "Chọn lại thư mục"
 * missing     the folder is gone (renamed, moved, deleted, drive unplugged)
 * unsupported this browser cannot write into folders
 * checking    being looked at
 */
export type FolderAccess = 'ok' | 'ask' | 'pick' | 'missing' | 'unsupported' | 'checking'

export interface FolderRuntime {
  access: FolderAccess
  /** Videos saved into this folder (this browser / computer). */
  saved: number
  lastAt: number | null
  /** File name of the last video saved. */
  lastName: string | null
  /** Last problem (Vietnamese), cleared by the next successful save. */
  error: string | null
  /** Auto-saves waiting for the folder permission (web) — saved by "Cấp lại quyền". */
  pending: number
  /** A save is being written. */
  busy: boolean
}

const STATS_KEY = 'bdp:folder-stats'
/** Per folder id: counters for the node, and the takes already saved there (a wire never copies one twice by itself). */
export interface FolderStats {
  saved: number
  lastAt: number | null
  lastName: string | null
  takes?: string[]
}
type Stats = Record<string, FolderStats>
/** Take ids remembered per folder (the most recent ones). */
const MAX_REMEMBERED_TAKES = 500

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Folder ids as object keys ('__proto__' would set the prototype, not a key). */
const isKey = (k: string) => !!k && k !== '__proto__'
/** Ids without duplicates or non-strings; past `max` the most recent ones (the end of the list). */
const idList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x && x.length <= 200))].slice(-max) : []

/**
 * bdp:folder-stats as stored, repaired value by value: a broken entry must never break a save ("3" + 1, a string
 * where the take list should be). Entries that are not objects are dropped.
 */
export function parseFolderStats(raw: unknown): Stats {
  const out: Stats = {}
  if (!isRecord(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!isKey(id) || !isRecord(v)) continue
    const entry: FolderStats = {
      saved: typeof v.saved === 'number' && Number.isFinite(v.saved) && v.saved >= 0 ? Math.floor(v.saved) : 0,
      lastAt: typeof v.lastAt === 'number' && Number.isFinite(v.lastAt) && v.lastAt > 0 ? v.lastAt : null,
      lastName: typeof v.lastName === 'string' && v.lastName ? v.lastName.slice(0, 300) : null,
    }
    const takes = idList(v.takes, MAX_REMEMBERED_TAKES)
    if (takes.length) entry.takes = takes
    out[id] = entry
  }
  return out
}

/** A stored JSON value (null when there is none, or when storage cannot be read). */
function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}
let stats: Stats = parseFolderStats(readJson(STATS_KEY))
function writeStats() {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats))
  } catch {
    /* quota / private mode: counters are only a convenience */
  }
}

const EMPTY: FolderRuntime = { access: 'checking', saved: 0, lastAt: null, lastName: null, error: null, pending: 0, busy: false }

interface FolderStatusState {
  byId: Record<string, FolderRuntime>
  patch: (id: string, patch: Partial<FolderRuntime>) => void
}

export const useFolderStatus = create<FolderStatusState>()((setState) => ({
  byId: {},
  patch: (id, patch) =>
    setState((s) => {
      const cur = s.byId[id] ?? runtimeSeed(id)
      const next = { ...cur, ...patch }
      if ((Object.keys(next) as (keyof FolderRuntime)[]).every((k) => next[k] === cur[k]) && s.byId[id]) return s
      return { byId: { ...s.byId, [id]: next } }
    }),
}))

function runtimeSeed(id: string): FolderRuntime {
  const st = stats[id]
  const pending = waitingCache[id]?.length ?? 0
  if (!st && !pending) return EMPTY
  return { ...EMPTY, saved: st?.saved ?? 0, lastAt: st?.lastAt ?? null, lastName: st?.lastName ?? null, pending }
}

/** Runtime state of a folder node (a stable object until it changes). */
export function folderRuntime(id: string): FolderRuntime {
  return useFolderStatus.getState().byId[id] ?? runtimeSeed(id)
}

const patch = (id: string, p: Partial<FolderRuntime>) => useFolderStatus.getState().patch(id, p)

/** Count a save: the node shows "Đã lưu N video · lần cuối HH:MM". */
export function noteFolderSaved(id: string, names: string[], takeId?: string) {
  const cur = folderRuntime(id)
  const next = { saved: cur.saved + 1, lastAt: Date.now(), lastName: names[0] ?? null }
  const takes = (stats[id]?.takes ?? []).filter((t) => t !== takeId)
  if (takeId) takes.push(takeId)
  stats = { ...stats, [id]: { ...next, takes: takes.slice(-MAX_REMEMBERED_TAKES) } }
  writeStats()
  patch(id, { ...next, error: null, access: 'ok' })
}

/** Was this take already saved into this folder (on this computer / browser)? */
export function wasSavedTo(folderId: string, takeId: string): boolean {
  return !!stats[folderId]?.takes?.includes(takeId)
}

// ---------------- saves still waiting (per browser / computer, kept across reloads and restarts) ----------------
// A save that could not be written yet (permission to give again, folder to choose again) waits here, and so does a
// save while it is being written (an app closed in the middle leaves it here, so it is written again later).
const WAITING_KEY = 'bdp:folder-waiting'
/** Saves remembered per folder (the most recent ones). */
const MAX_WAITING = 200
type Waiting = Record<string, string[]>

/** bdp:folder-waiting as stored (folder id → take ids), repaired. */
export function parseFolderWaiting(raw: unknown): Waiting {
  const out: Waiting = {}
  if (!isRecord(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!isKey(id)) continue
    const ids = idList(v, MAX_WAITING)
    if (ids.length) out[id] = ids
  }
  return out
}

/** Last known list (also what is used where there is no localStorage: tests, a blocked storage). */
let waitingCache: Waiting = parseFolderWaiting(readJson(WAITING_KEY))

/** The stored list, read again each time (another tab may have saved or added some meanwhile). */
function readWaiting(): Waiting {
  try {
    if (typeof localStorage === 'undefined') return waitingCache
    waitingCache = parseFolderWaiting(readJson(WAITING_KEY))
  } catch {
    /* storage not readable: keep the last known list */
  }
  return waitingCache
}
function writeWaiting(all: Waiting) {
  waitingCache = all
  try {
    if (Object.keys(all).length) localStorage.setItem(WAITING_KEY, JSON.stringify(all))
    else localStorage.removeItem(WAITING_KEY)
  } catch {
    /* quota / private mode: the list still holds for this session */
  }
}

/** Takes waiting to be saved into this folder (oldest first). */
export function waitingTakes(folderId: string): string[] {
  return readWaiting()[folderId] ?? []
}

/** Add (`on`) or remove takes from the folder's waiting list; the node shows "N video chờ lưu". Returns how many wait. */
export function markWaiting(folderId: string, takeIds: readonly string[], on: boolean): number {
  const all = { ...readWaiting() }
  const cur = all[folderId] ?? []
  const drop = new Set(takeIds)
  const next = on ? [...cur.filter((t) => !drop.has(t)), ...takeIds].slice(-MAX_WAITING) : cur.filter((t) => !drop.has(t))
  if (next.length !== cur.length || next.some((t, i) => t !== cur[i])) {
    if (next.length) all[folderId] = next
    else delete all[folderId]
    writeWaiting(all)
  }
  patch(folderId, { pending: next.length })
  return next.length
}

// Another tab saved / queued some: keep the "chờ lưu" counts of the nodes shown here right.
function onStorage(e: StorageEvent) {
  if (e.key !== WAITING_KEY && e.key !== null) return
  const all = readWaiting()
  for (const id of Object.keys(useFolderStatus.getState().byId)) patch(id, { pending: all[id]?.length ?? 0 })
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', onStorage)
  if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener('storage', onStorage))
}

// ---------------- where folders can be used ----------------
const hasDirPicker = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

/** Folder nodes work here: the desktop app, or a browser with the File System Access API (Chrome, Edge). */
export function canUseFolders(): boolean {
  return !!desktopFiles() || hasDirPicker()
}

// ---------------- web: one directory handle per folder id ----------------
const handleKey = (folderId: string) => `folder-dir:${folderId}`

async function folderHandle(folderId: string): Promise<DirHandle | null> {
  try {
    return ((await get(handleKey(folderId), settingsStore)) as DirHandle | undefined) ?? null
  } catch {
    return null
  }
}

/** Keep the browser's handle of a folder node (picked just now) under its id. */
export async function rememberFolderHandle(folderId: string, handle: unknown): Promise<void> {
  if (handle) await set(handleKey(folderId), handle, settingsStore).catch(() => undefined)
}

/** Duplicate of a project: its folder node (new id) keeps the original's folder (web: the same directory handle). */
export async function copyFolderHandle(fromId: string, toId: string): Promise<void> {
  const handle = await folderHandle(fromId)
  if (handle) await rememberFolderHandle(toId, handle)
}

export async function forgetFolderHandle(folderId: string): Promise<void> {
  await del(handleKey(folderId), settingsStore).catch(() => undefined)
}

export interface PickedFolder {
  name: string
  /** Desktop: absolute path (now allowed for writes). Web: null. */
  path: string | null
  /** Web: the directory handle to remember under the folder id. */
  handle: DirHandle | null
}

/**
 * Let the user choose a folder (call from a click: the browser needs it). null = cancelled or impossible here
 * (`reason` says why when it was not a plain cancel).
 */
export async function pickFolderLocation(): Promise<{ picked: PickedFolder | null; reason?: string }> {
  const bridge = desktopFiles()
  if (bridge) {
    const res = await bridge.pickFolder()
    if (res.ok) return { picked: { name: res.name, path: res.path, handle: null } }
    return { picked: null, reason: res.canceled ? undefined : res.message }
  }
  if (!hasDirPicker()) return { picked: null, reason: UNSUPPORTED_TEXT }
  try {
    const picker = (window as unknown as { showDirectoryPicker(o: { mode: 'readwrite'; id?: string }): Promise<DirHandle> }).showDirectoryPicker
    const handle = await picker.call(window, { mode: 'readwrite', id: 'sanovids-folder' })
    let perm = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt' as PermissionState)
    if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState)
    if (perm !== 'granted') return { picked: null, reason: 'Trình duyệt chưa cho phép ghi vào thư mục này.' }
    return { picked: { name: handle.name, path: null, handle } }
  } catch (e) {
    return { picked: null, reason: errName(e) === 'AbortError' ? undefined : fsError(e).message }
  }
}

export const UNSUPPORTED_TEXT = 'Trình duyệt này không ghi được vào thư mục trên máy — dùng Chrome / Edge hoặc app SanoVids desktop.'

// ---------------- access ----------------
/** Can SanoVids write into this folder right now? (Updates the node's runtime state.) */
export async function checkFolderAccess(folder: SaveFolder): Promise<FolderAccess> {
  const access = await accessOf(folder)
  patch(folder.id, { access })
  return access
}

async function accessOf(folder: SaveFolder): Promise<FolderAccess> {
  const bridge = desktopFiles()
  if (bridge) {
    if (!folder.path) return 'pick'
    try {
      const st = await bridge.folderStatus({ folderPath: folder.path })
      if (!st.ok) return 'pick'
      if (!st.allowed) return 'pick'
      return st.exists ? 'ok' : 'missing'
    } catch {
      return 'pick'
    }
  }
  if (!hasDirPicker()) return 'unsupported'
  const handle = await folderHandle(folder.id)
  if (!handle) return 'pick'
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'ok' : 'ask'
  } catch {
    return 'ask'
  }
}

/** From a click ("Cấp lại quyền"): ask the browser for the write permission again. Desktop: just checks. */
export async function requestFolderAccess(folder: SaveFolder): Promise<FolderAccess> {
  if (desktopFiles() || !hasDirPicker()) return checkFolderAccess(folder)
  const handle = await folderHandle(folder.id)
  let access: FolderAccess = 'pick'
  if (handle) {
    try {
      access = (await handle.requestPermission({ mode: 'readwrite' })) === 'granted' ? 'ok' : 'ask'
    } catch {
      access = 'ask'
    }
  }
  patch(folder.id, access === 'ok' ? { access, error: null } : { access })
  return access
}

export type FolderWriteResult = { ok: true; names: string[] } | { ok: false; access: FolderAccess; message: string }

const ACCESS_TEXT: Record<Exclude<FolderAccess, 'ok' | 'checking'>, string> = {
  ask: 'Trình duyệt cần bạn cho phép ghi vào thư mục này lần nữa.',
  pick: 'Chưa chọn thư mục trên máy này (hoặc chưa được cấp quyền).',
  missing: 'Không tìm thấy thư mục (đã đổi tên, chuyển hoặc xoá?).',
  unsupported: UNSUPPORTED_TEXT,
}

/**
 * Write a group of files (video + prompt .txt) into a folder node's folder, never overwriting (" (2)" for the
 * whole group). `interactive` = right after a click: the browser may show its permission prompt.
 */
export async function writeToFolder(folder: SaveFolder, files: FileToSave[], interactive: boolean): Promise<FolderWriteResult> {
  const fail = (access: Exclude<FolderAccess, 'ok' | 'checking'>, message = ACCESS_TEXT[access]): FolderWriteResult => {
    patch(folder.id, { access, error: message })
    return { ok: false, access, message }
  }
  const bridge = desktopFiles()
  if (bridge) {
    if (!folder.path) return fail('pick')
    const res = await bridge.writeToFolder({ folderPath: folder.path, files: await toDesktopFiles(files) })
    if (res.ok) return { ok: true, names: res.names }
    if (res.code === 'not-allowed') return fail('pick')
    if (res.code === 'missing') return fail('missing')
    patch(folder.id, { error: res.message })
    return { ok: false, access: 'ok', message: res.message }
  }
  if (!hasDirPicker()) return fail('unsupported')
  const handle = await folderHandle(folder.id)
  if (!handle) return fail('pick')
  let perm: PermissionState = 'prompt'
  try {
    perm = await handle.queryPermission({ mode: 'readwrite' })
    if (perm !== 'granted' && interactive) perm = await handle.requestPermission({ mode: 'readwrite' })
  } catch {
    perm = 'denied'
  }
  if (perm !== 'granted') return fail('ask')
  try {
    const names = await writeGroup(handle, files)
    return { ok: true, names }
  } catch (e) {
    if (errName(e) === 'NotFoundError') return fail('missing')
    if (errName(e) === 'NotAllowedError') return fail('ask')
    const message = fsError(e).message
    patch(folder.id, { error: message })
    return { ok: false, access: 'ok', message }
  }
}

/** Desktop: show the folder in Explorer / Finder. */
export async function revealFolder(folder: SaveFolder): Promise<string | null> {
  const bridge = desktopFiles()
  if (!bridge || !folder.path) return 'Chỉ mở được thư mục trong app SanoVids desktop.'
  const res = await bridge.openFolder({ folderPath: folder.path })
  return res.ok ? null : res.message
}

/** Mark a node busy / not busy (spinner while a save is written). */
export function setFolderBusy(id: string, busy: boolean) {
  patch(id, { busy })
}

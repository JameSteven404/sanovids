// "Thư mục" nodes: where their files go and how they are written (the node data lives in Project.folders).
//   Desktop app: through window.bdpDesktop.files (lib/desktopFiles.ts) — the main process writes only into folders the
//     user picked in this app (its allowlist), never overwriting.
//   Web (Chromium): a File System Access directory handle per folder id, kept in IndexedDB. After a restart the browser
//     usually asks again before writing ("Cấp lại quyền": needs a click). Firefox / Safari cannot write folders.
// Runtime state of each node (access, counters, last error, saves waiting for the permission) is the small store below;
// its counters and the saves still waiting are kept per browser / computer (localStorage), not in the project.
// Desktop app, "Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác" (core/folderTrash, folderActions):
//   - every folder write names its owner (folder node, take, where it comes from: SaveVia); the main process records
//     the written group in its own ledger and answers its id (`recorded`);
//   - the ownership record bdp:folder-link-owned keeps, per "folderId:takeId", the groups the take → folder wire itself
//     wrote (never the auto-save wire's): only those may later be moved to the Recycle Bin (trashSavedFiles);
//   - bdp:folder-trash-waiting keeps cut wires whose folder could not be reached, moved when it is back (≤ 30 days).
import { del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import { checkTrashAnswer, TRASH_BATCH_MAX, TRASH_GROUPS_MAX, TRASH_WAIT_DAYS, trashBatches } from '../core/folderTrash'
import type { SaveFolder } from '../core/types'
import { desktopFiles, toDesktopFiles, type SaveVia, type TrashSavedItem, type TrashSavedTakeResult } from './desktopFiles'
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
  /** Cut wires whose files wait for the folder to come back before going to the Recycle Bin (desktop). */
  trashPending: number
  /** Files are being moved to the Recycle Bin. */
  trashing: boolean
  /** Cut wires (this session) whose files waited longer than TRASH_WAIT_DAYS: no longer moved, their files stay. */
  trashExpired: number
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

const EMPTY: FolderRuntime = { access: 'checking', saved: 0, lastAt: null, lastName: null, error: null, pending: 0, busy: false, trashPending: 0, trashing: false, trashExpired: 0 }

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
  const trashPending = trashWaitingCache[id]?.length ?? 0
  if (!st && !pending && !trashPending) return EMPTY
  return { ...EMPTY, saved: st?.saved ?? 0, lastAt: st?.lastAt ?? null, lastName: st?.lastName ?? null, pending, trashPending }
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

/**
 * Files of a take went to the Recycle Bin: it no longer counts as saved there (a wire made again copies it again),
 * the counter goes down by the copies moved (never below 0), and "lần cuối" no longer names a file that is gone.
 */
export function forgetSavedTake(folderId: string, takeId: string, copies: number, trashedNames: readonly string[]) {
  const cur = stats[folderId]
  if (!cur) return
  const takes = (cur.takes ?? []).filter((t) => t !== takeId)
  const saved = Math.max(0, cur.saved - Math.max(0, Math.floor(copies)))
  const lastName = cur.lastName && trashedNames.includes(cur.lastName) ? null : cur.lastName
  const next: FolderStats = { saved, lastAt: cur.lastAt, lastName }
  if (takes.length) next.takes = takes
  stats = { ...stats, [folderId]: next }
  writeStats()
  patch(folderId, { saved, lastName })
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

// ---------------- what a take → folder wire wrote itself (desktop; per computer) ----------------
// "folderId:takeId" → ledger group ids (electron/main.cjs `recorded`) written FOR that 'save' wire: the copy made when
// it was wired, "Lưu thêm bản nữa" while it exists, its waiting save, the copy written again after Hoàn tác. Never the
// auto-save wire's writes. [] = the wire exists but copied nothing (the file was already there). No key = nothing is
// known (wired by an older build, storage cleared, another computer): nothing is ever moved then.
const OWNED_KEY = 'bdp:folder-link-owned'
/** Pairs remembered (the most recent ones). */
const MAX_OWNED_KEYS = 5000
/** Ledger group id: 16 hex characters. */
export const GROUP_ID_RE = /^[0-9a-f]{16}$/i
type Owned = Record<string, string[]>

const ownedKey = (folderId: string, takeId: string) => `${folderId}:${takeId}`
const isOwnedKey = (k: string) => k.length <= 401 && /^[^:]{1,200}:[^:]{1,200}$/.test(k) && !k.startsWith('__proto__')

/** bdp:folder-link-owned as stored, repaired value by value (never throws). */
export function parseFolderOwned(raw: unknown): Owned {
  const out: Owned = {}
  if (!isRecord(raw)) return out
  const entries = Object.entries(raw).filter(([k, v]) => isOwnedKey(k) && Array.isArray(v))
  for (const [k, v] of entries.slice(-MAX_OWNED_KEYS)) {
    out[k] = [...new Set((v as unknown[]).filter((x): x is string => typeof x === 'string' && GROUP_ID_RE.test(x)))].slice(-TRASH_GROUPS_MAX)
  }
  return out
}

let ownedCache: Owned = parseFolderOwned(readJson(OWNED_KEY))

function readOwned(): Owned {
  try {
    if (typeof localStorage === 'undefined') return ownedCache
    ownedCache = parseFolderOwned(readJson(OWNED_KEY))
  } catch {
    /* storage not readable: keep the last known record */
  }
  return ownedCache
}
function writeOwned(all: Owned) {
  const keys = Object.keys(all)
  if (keys.length > MAX_OWNED_KEYS) for (const k of keys.slice(0, keys.length - MAX_OWNED_KEYS)) delete all[k]
  ownedCache = all
  try {
    if (Object.keys(all).length) localStorage.setItem(OWNED_KEY, JSON.stringify(all))
    else localStorage.removeItem(OWNED_KEY)
  } catch {
    /* quota / private mode: the record still holds for this session */
  }
}

/** Groups the take → folder wire wrote itself; null = nothing known about this pair. */
export function ownedGroups(folderId: string, takeId: string): string[] | null {
  const v = readOwned()[ownedKey(folderId, takeId)]
  return v ? [...v] : null
}

/** ownedGroups of many pairs, reading the record once (a Delete may cut hundreds of wires). */
export function ownedGroupsOf(pairs: readonly { folderId: string; takeId: string }[]): (string[] | null)[] {
  const all = readOwned()
  return pairs.map((p) => {
    const v = all[ownedKey(p.folderId, p.takeId)]
    return v ? [...v] : null
  })
}

/** A write for the 'save' wire was recorded by the main process as `groupId`. */
export function addOwned(folderId: string, takeId: string, groupId: string) {
  if (!GROUP_ID_RE.test(groupId)) return
  const all = { ...readOwned() }
  const k = ownedKey(folderId, takeId)
  const cur = all[k] ?? []
  delete all[k] // re-inserted last: the most recently used pairs are the ones kept
  all[k] = [...cur.filter((g) => g !== groupId), groupId].slice(-TRASH_GROUPS_MAX)
  writeOwned(all)
}

/** Set what the wire owns (e.g. [] = wired but nothing copied: the file was already there). */
export function setOwned(folderId: string, takeId: string, groupIds: readonly string[]) {
  const all = { ...readOwned() }
  const k = ownedKey(folderId, takeId)
  delete all[k]
  all[k] = [...new Set(groupIds.filter((g) => GROUP_ID_RE.test(g)))].slice(-TRASH_GROUPS_MAX)
  writeOwned(all)
}

/** The wire is gone and its files were dealt with: what is left in the folder is the user's now. */
export function releaseOwned(folderId: string, takeId: string | readonly string[]) {
  const all = readOwned()
  const keys = (typeof takeId === 'string' ? [takeId] : takeId).map((t) => ownedKey(folderId, t)).filter((k) => k in all)
  if (!keys.length) return
  const next = { ...all }
  for (const k of keys) delete next[k]
  writeOwned(next)
}

// ---------------- cut wires waiting for their folder (desktop; per computer) ----------------
// A wire cut while its folder could not be reached (drive unplugged…): its files go to the Recycle Bin when the folder
// is back (folderActions.refreshFolderNode), within TRASH_WAIT_DAYS. The groups to move stay in the ownership record.
const TRASH_WAITING_KEY = 'bdp:folder-trash-waiting'
const MAX_TRASH_WAITING = 200
const TRASH_WAIT_MS = TRASH_WAIT_DAYS * 24 * 3600 * 1000
export interface TrashWaitingEntry {
  takeId: string
  /** When the wire was cut (ms). */
  at: number
}
type TrashWaiting = Record<string, TrashWaitingEntry[]>

/** bdp:folder-trash-waiting as stored, repaired (older than TRASH_WAIT_DAYS, from the future, duplicates, wrong types dropped). */
export function parseFolderTrashWaiting(raw: unknown, now = Date.now()): TrashWaiting {
  const out: TrashWaiting = {}
  if (!isRecord(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!isKey(id) || !Array.isArray(v)) continue
    const seen = new Set<string>()
    const list: TrashWaitingEntry[] = []
    for (const e of v) {
      if (!isRecord(e) || typeof e.takeId !== 'string' || !e.takeId || e.takeId.length > 200) continue
      if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at <= 0 || now - e.at > TRASH_WAIT_MS || e.at - now > 60_000) continue
      if (seen.has(e.takeId)) continue
      seen.add(e.takeId)
      list.push({ takeId: e.takeId, at: e.at })
    }
    if (list.length) out[id] = list.slice(-MAX_TRASH_WAITING)
  }
  return out
}

/**
 * Entries of bdp:folder-trash-waiting (as stored) that expired: well formed but older than TRASH_WAIT_DAYS, for a take
 * the folder no longer waits for otherwise. Their files stay where they are; the caller releases their ownership record.
 */
export function expiredFolderTrashWaiting(raw: unknown, now = Date.now()): { folderId: string; takeId: string }[] {
  const out: { folderId: string; takeId: string }[] = []
  if (!isRecord(raw)) return out
  const kept = parseFolderTrashWaiting(raw, now)
  for (const [folderId, v] of Object.entries(raw)) {
    if (!isKey(folderId) || !Array.isArray(v)) continue
    const live = new Set((kept[folderId] ?? []).map((e) => e.takeId))
    const seen = new Set<string>()
    for (const e of v) {
      if (!isRecord(e) || typeof e.takeId !== 'string' || !e.takeId || e.takeId.length > 200) continue
      if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at <= 0 || now - e.at <= TRASH_WAIT_MS) continue
      if (live.has(e.takeId) || seen.has(e.takeId)) continue
      seen.add(e.takeId)
      out.push({ folderId, takeId: e.takeId })
    }
  }
  return out
}

let trashWaitingCache: TrashWaiting = parseFolderTrashWaiting(readJson(TRASH_WAITING_KEY))

function readTrashWaiting(): TrashWaiting {
  try {
    // No storage (tests, blocked): the list of this session, still expiring.
    const raw: unknown = typeof localStorage === 'undefined' ? trashWaitingCache : readJson(TRASH_WAITING_KEY)
    const now = Date.now()
    trashWaitingCache = parseFolderTrashWaiting(raw, now)
    const expired = expiredFolderTrashWaiting(raw, now)
    if (expired.length) forgetExpiredTrashWaiting(expired)
  } catch {
    /* storage not readable: keep the last known list */
  }
  return trashWaitingCache
}

/**
 * Cut wires whose files waited too long for their folder: dropped from the stored list, their ownership record released
 * (what is left in the folder is the user's: a wire made later never claims it), counted on the node ("đã giữ file").
 */
function forgetExpiredTrashWaiting(expired: readonly { folderId: string; takeId: string }[]) {
  writeTrashWaiting(trashWaitingCache)
  const byFolder = new Map<string, string[]>()
  for (const e of expired) byFolder.set(e.folderId, [...(byFolder.get(e.folderId) ?? []), e.takeId])
  for (const [folderId, takeIds] of byFolder) {
    releaseOwned(folderId, takeIds)
    const cur = useFolderStatus.getState().byId[folderId] ?? runtimeSeed(folderId)
    patch(folderId, { trashExpired: cur.trashExpired + takeIds.length, trashPending: trashWaitingCache[folderId]?.length ?? 0 })
  }
}
function writeTrashWaiting(all: TrashWaiting) {
  trashWaitingCache = all
  try {
    if (Object.keys(all).length) localStorage.setItem(TRASH_WAITING_KEY, JSON.stringify(all))
    else localStorage.removeItem(TRASH_WAITING_KEY)
  } catch {
    /* quota / private mode: the list still holds for this session */
  }
}

/** Takes whose cut wire waits for this folder (oldest first). */
export function trashWaitingTakes(folderId: string): string[] {
  return (readTrashWaiting()[folderId] ?? []).map((e) => e.takeId)
}

/** Add (`on`) or remove takes from the folder's "chờ xoá" list; the node shows "N file chờ xoá". Returns how many wait. */
export function markTrashWaiting(folderId: string, takeIds: readonly string[], on: boolean, now = Date.now()): number {
  const all = { ...readTrashWaiting() }
  const cur = all[folderId] ?? []
  const drop = new Set(takeIds)
  const next = on
    ? [...cur.filter((e) => !drop.has(e.takeId)), ...[...drop].map((takeId) => ({ takeId, at: now }))].slice(-MAX_TRASH_WAITING)
    : cur.filter((e) => !drop.has(e.takeId))
  if (next.length !== cur.length || next.some((e, i) => e.takeId !== cur[i].takeId || e.at !== cur[i].at)) {
    if (next.length) all[folderId] = next
    else delete all[folderId]
    writeTrashWaiting(all)
  }
  patch(folderId, { trashPending: next.length })
  return next.length
}

// Another tab saved / queued / cut some: keep the "chờ lưu" / "chờ xoá" counts of the nodes shown here right.
function onStorage(e: StorageEvent) {
  if (e.key !== WAITING_KEY && e.key !== TRASH_WAITING_KEY && e.key !== null) return
  const all = readWaiting()
  const trash = readTrashWaiting()
  for (const id of Object.keys(useFolderStatus.getState().byId)) patch(id, { pending: all[id]?.length ?? 0, trashPending: trash[id]?.length ?? 0 })
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

/**
 * `recorded` (desktop, with an owner): the main process's ledger id of the group just written — the only way those
 * files can later go to the Recycle Bin. Missing when nothing was recorded (web, no owner, ledger error, older build).
 */
export type FolderWriteResult = { ok: true; names: string[]; recorded?: string } | { ok: false; access: FolderAccess; message: string }

/** Who a folder write is for: the take, and where it comes from (lib/desktopFiles SaveVia). */
export interface FolderWriteOwner {
  takeId: string
  via: SaveVia
}

const ACCESS_TEXT: Record<Exclude<FolderAccess, 'ok' | 'checking'>, string> = {
  ask: 'Trình duyệt cần bạn cho phép ghi vào thư mục này lần nữa.',
  pick: 'Chưa chọn thư mục trên máy này (hoặc chưa được cấp quyền).',
  missing: 'Không tìm thấy thư mục (đã đổi tên, chuyển hoặc xoá?).',
  unsupported: UNSUPPORTED_TEXT,
}

/**
 * Write a group of files (video + prompt .txt) into a folder node's folder, never overwriting (" (2)" for the
 * whole group). `interactive` = right after a click: the browser may show its permission prompt. `owner` (desktop):
 * the main process records the group under this folder node / take (answering its id in `recorded`).
 */
export async function writeToFolder(folder: SaveFolder, files: FileToSave[], interactive: boolean, owner?: FolderWriteOwner): Promise<FolderWriteResult> {
  const fail = (access: Exclude<FolderAccess, 'ok' | 'checking'>, message = ACCESS_TEXT[access]): FolderWriteResult => {
    patch(folder.id, { access, error: message })
    return { ok: false, access, message }
  }
  const bridge = desktopFiles()
  if (bridge) {
    if (!folder.path) return fail('pick')
    const res = await bridge.writeToFolder({
      folderPath: folder.path,
      files: await toDesktopFiles(files),
      ...(owner ? { owner: { folderId: folder.id, takeId: owner.takeId, via: owner.via } } : {}),
    })
    if (res.ok) return typeof res.recorded === 'string' && GROUP_ID_RE.test(res.recorded) ? { ok: true, names: res.names, recorded: res.recorded } : { ok: true, names: res.names }
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

// ---------------- Recycle Bin (desktop) ----------------
/** Moving saved files to the Recycle Bin can be asked for here (the desktop app with files:trashSaved). */
export function canTrashSaved(): boolean {
  return typeof desktopFiles()?.trashSaved === 'function'
}

/** Takes a files:trashSaved call could not handle, and why. */
export interface TrashProblem {
  /** missing: the folder is gone (wait for it) · pick: not chosen on this computer · unsupported: no bridge · error: retry. */
  access: 'missing' | 'pick' | 'unsupported' | 'error'
  message: string
  takeIds: string[]
}

export interface TrashFilesOutcome {
  /** One answer per take of the calls that worked (checked: core/folderTrash checkTrashAnswer). */
  results: TrashSavedTakeResult[]
  problems: TrashProblem[]
}

/**
 * Ask the main process to move what these takes' wires wrote into this folder node's folder to the Recycle Bin (only
 * ledger groups `groupIds`, only files still exactly as written; never deleted for good). Calls of ≤ TRASH_BATCH_MAX
 * takes. The node shows "Đang chuyển file vào Thùng rác…" meanwhile. Never throws.
 */
export async function trashSavedFiles(folder: SaveFolder, items: readonly TrashSavedItem[]): Promise<TrashFilesOutcome> {
  const out: TrashFilesOutcome = { results: [], problems: [] }
  const asked = items.filter((i) => i.groupIds.length)
  if (!asked.length) return out
  const bridge = desktopFiles()
  if (!bridge || typeof bridge.trashSaved !== 'function') {
    out.problems.push({ access: 'unsupported', message: 'Chỉ có trong app SanoVids desktop.', takeIds: asked.map((i) => i.takeId) })
    return out
  }
  if (!folder.path) {
    out.problems.push({ access: 'pick', message: ACCESS_TEXT.pick, takeIds: asked.map((i) => i.takeId) })
    return out
  }
  patch(folder.id, { trashing: true })
  try {
    const batches = trashBatches(asked, TRASH_BATCH_MAX)
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]
      const takeIds = batch.map((i) => i.takeId)
      let res: Awaited<ReturnType<NonNullable<typeof bridge.trashSaved>>>
      try {
        res = await bridge.trashSaved({
          folderPath: folder.path,
          folderId: folder.id,
          items: batch.map((i) => ({ takeId: i.takeId, groupIds: i.groupIds.slice(-TRASH_GROUPS_MAX) })),
        })
      } catch (e) {
        res = { ok: false, code: 'failed', message: (e as Error)?.message || String(e) }
      }
      if (res && res.ok === true) {
        const { results, unanswered } = checkTrashAnswer(res, takeIds)
        out.results.push(...results)
        if (unanswered.length) out.problems.push({ access: 'error', message: 'SanoVids không nhận được kết quả.', takeIds: unanswered })
        continue
      }
      const code = (res as { code?: unknown } | undefined)?.code
      const message = typeof (res as { message?: unknown } | undefined)?.message === 'string' ? (res as { message: string }).message : 'Lỗi không rõ.'
      // The folder is gone / not allowed here: the remaining batches would get the same answer.
      const rest = batches.slice(b).flatMap((x) => x.map((i) => i.takeId))
      if (code === 'not-allowed') {
        patch(folder.id, { access: 'pick' })
        out.problems.push({ access: 'pick', message: ACCESS_TEXT.pick, takeIds: rest })
        break
      }
      if (code === 'missing') {
        patch(folder.id, { access: 'missing' })
        out.problems.push({ access: 'missing', message: ACCESS_TEXT.missing, takeIds: rest })
        break
      }
      out.problems.push({ access: 'error', message, takeIds })
    }
  } finally {
    patch(folder.id, { trashing: false })
  }
  return out
}

// Local persistence. Projects and runs live in IndexedDB (no ~5 MB localStorage limit); media blobs live in
// their own IndexedDB store (lib/imageStore). A small synchronous localStorage backup of the open project is
// written when the page is hidden/closed with unsaved edits, because IndexedDB writes may not finish during unload.
// Also project management (list / create / switch / duplicate / delete / export / import).
//
// Several tabs/windows (web + installed PWA) share the same IndexedDB. Rules that keep them from destroying each
// other's work (see core/storageRules.ts):
// - a tab only writes what it changed (dirty tracking), never its whole copy "just in case";
// - every write carries a revision stamp, checked in the same transaction: a tab whose copy is older than what
//   another tab saved stops autosaving that project and asks for a reload instead of overwriting newer data;
// - the project list is merged in IndexedDB (read + write in one transaction), never replaced by a tab's memory;
// - other tabs are told about saves (BroadcastChannel) and reload a project they have no unsaved changes to.
import { createStore, get, set, update } from 'idb-keyval'
import { create } from 'zustand'
import { takeCode } from '../core/compile'
import { newId } from '../core/ids'
import { dropVideoRefs, migrateProject } from '../core/migrate'
import { createDemoProject } from '../core/seed'
import { backupWins, isForeignWrite, nextStamp, sortByUpdated, upsertById, type BackupInfo, type RevStamp } from '../core/storageRules'
import type { Project, Take } from '../core/types'
import { dataUrlToBlob, deleteMedia, getBlob, putBlob } from '../lib/imageStore'
import { clearHistory, emptyProject, useProject } from './project'
import { useRuns } from './runs'
import { useUI } from './ui'

export interface ProjectMeta {
  id: string
  name: string
  updatedAt: number
  scenes: number
}

interface SaveState {
  status: 'idle' | 'saving' | 'saved' | 'error'
  savedAt: number | null
  projects: ProjectMeta[]
  ready: boolean
  /** The open project was saved by another tab/window after this one loaded it: this tab no longer autosaves it. */
  stale: boolean
}

export const useSave = create<SaveState>()(() => ({ status: 'idle', savedAt: null, projects: [], ready: false, stale: false }))

interface RunsData {
  takes: Take[]
  credits: number
  spent: number
}

const db = createStore('ban-dung-phim-data', 'kv')
const K = {
  index: 'index',
  project: (id: string) => `project:${id}`,
  runs: (id: string) => `runs:${id}`,
  rev: (id: string) => `rev:${id}`,
}
const LS = {
  active: 'bdp:active',
  /** Emergency backup of one project (one slot per project, so switching never overwrites another one's). */
  backup: (id: string) => `bdp:backup:${id}`,
  backupPrefix: 'bdp:backup:',
  /** Old single backup slot (no revision), read once at startup. */
  legacyBackup: 'bdp:backup',
  // v1 (localStorage) keys, migrated once
  v1Index: 'bdp:projects',
  v1Project: (id: string) => `bdp:project:${id}`,
  v1Runs: (id: string) => `bdp:runs:${id}`,
}

/** This page load. Revision stamps written by it carry this id. */
const TAB_ID = newId('tab')

// ---------------- low-level ----------------
async function idbGet<T>(key: string): Promise<T | null> {
  try {
    return ((await get(key, db)) as T | undefined) ?? null
  } catch {
    return null
  }
}
async function idbSet(key: string, value: unknown): Promise<boolean> {
  try {
    await set(key, value, db)
    return true
  } catch {
    return false
  }
}
function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function lsSet(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
function lsRemove(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}

async function readProject(id: string): Promise<Project | null> {
  const raw = await idbGet<unknown>(K.project(id))
  return raw ? migrateProject(raw) : null
}
async function readRuns(id: string): Promise<RunsData | null> {
  return idbGet<RunsData>(K.runs(id))
}
async function readStamp(id: string): Promise<RevStamp | null> {
  return idbGet<RevStamp>(K.rev(id))
}

function metaOf(p: Project): ProjectMeta {
  return { id: p.id, name: p.name, updatedAt: p.updatedAt, scenes: p.scenes.length }
}

async function writeIndex(list: ProjectMeta[]) {
  const sorted = sortByUpdated(list)
  useSave.setState({ projects: sorted })
  await idbSet(K.index, sorted)
}

/** Change the stored project list in one transaction (other tabs may have added or removed projects). */
async function updateIndex(fn: (list: ProjectMeta[]) => ProjectMeta[]): Promise<void> {
  const out: { list: ProjectMeta[] | null } = { list: null }
  try {
    await update<ProjectMeta[]>(K.index, (stored) => (out.list = sortByUpdated(fn(stored ?? useSave.getState().projects))), db)
  } catch {
    return
  }
  if (out.list) useSave.setState({ projects: out.list })
}

async function refreshIndex() {
  const stored = await idbGet<ProjectMeta[]>(K.index)
  if (stored) useSave.setState({ projects: sortByUpdated(stored) })
}

// ---------------- other tabs ----------------
type Message = { tab: string; type: 'saved' | 'deleted'; projectId: string }
const channel: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sanovids:data')
  } catch {
    return null
  }
})()
function broadcast(type: Message['type'], projectId: string) {
  try {
    channel?.postMessage({ tab: TAB_ID, type, projectId } satisfies Message)
  } catch {
    /* closed */
  }
}

// ---------------- revisions ----------------
/** Revision each project's in-memory copy is based on (what this tab loaded or last wrote). */
const baseRevs = new Map<string, number | null>()
/** Projects another tab saved (or deleted) after this tab loaded them: never written by this tab again. */
const stale = new Set<string>()

type WriteResult = 'ok' | 'conflict' | 'error'

/**
 * Write `entries` of a project together with a new revision stamp (and its row in the project list) in one
 * IndexedDB transaction — only when no other tab wrote the project since this tab's copy was loaded/saved.
 */
async function guardedWrite(projectId: string, entries: [string, unknown][], meta?: ProjectMeta): Promise<WriteResult> {
  if (stale.has(projectId)) return 'conflict'
  try {
    const res = await db('readwrite', (store) =>
      new Promise<{ conflict: boolean; stamp: RevStamp | null; index: ProjectMeta[] | null }>((resolve, reject) => {
        const out = { conflict: false, stamp: null as RevStamp | null, index: null as ProjectMeta[] | null }
        const req = store.get(K.rev(projectId))
        req.onsuccess = () => {
          const stored = (req.result as RevStamp | undefined) ?? null
          if (isForeignWrite(stored, baseRevs.get(projectId) ?? null, TAB_ID)) {
            out.conflict = true
            return // nothing written; the transaction just completes
          }
          out.stamp = nextStamp(stored, TAB_ID)
          for (const [key, value] of entries) store.put(value, key)
          store.put(out.stamp, K.rev(projectId))
          if (meta) {
            const ireq = store.get(K.index)
            ireq.onsuccess = () => {
              out.index = upsertById((ireq.result as ProjectMeta[] | undefined) ?? useSave.getState().projects, meta)
              store.put(out.index, K.index)
            }
          }
        }
        const tx = store.transaction
        tx.oncomplete = () => resolve(out)
        tx.onabort = tx.onerror = () => reject(tx.error)
      }),
    )
    if (res.conflict) {
      markStale(projectId)
      return 'conflict'
    }
    baseRevs.set(projectId, res.stamp!.rev)
    if (res.index) useSave.setState({ projects: res.index })
    broadcast('saved', projectId)
    return 'ok'
  } catch {
    return 'error'
  }
}

/** Another tab owns newer data of this project: stop writing it from here and tell the user. */
function markStale(projectId: string, why: 'saved' | 'deleted' = 'saved') {
  if (stale.has(projectId)) return
  stale.add(projectId)
  if (useProject.getState().project.id !== projectId) return
  cancelPendingSaves()
  removeOwnBackup(projectId)
  useSave.setState({ status: 'error', stale: true })
  useUI
    .getState()
    .toast(
      why === 'deleted'
        ? 'Dự án này đã bị xoá ở một tab/cửa sổ khác. Tab này ngừng tự lưu — tải lại trang để làm tiếp.'
        : 'Dự án này vừa được lưu ở một tab/cửa sổ khác. Tab này ngừng tự lưu để không ghi đè bản mới hơn — tải lại để làm tiếp.',
      { tone: 'warning', ms: 30000, action: { label: 'Tải lại', run: () => window.location.reload() } },
    )
}

// ---------------- dirty tracking ----------------
/** Project / runs as last written to (or loaded from) storage. Different object = unsaved changes. */
let savedProject: Project | null = null
let savedRuns: RunsData | null = null
/** Order of in-memory project versions, so an older save never drops the backup of a newer version. */
let editSeq = 0
const seqOf = new WeakMap<Project, number>()
/** Sequence number of the open project's version in its emergency backup (0 = no backup by this tab). */
let backupSeq = 0

const projectDirty = () => useProject.getState().project !== savedProject
function runsDirty() {
  const r = useRuns.getState()
  return !savedRuns || r.takes !== savedRuns.takes || r.credits !== savedRuns.credits || r.spent !== savedRuns.spent
}
const hasUnsaved = () => projectDirty() || runsDirty() || !!projectTimer || !!runsTimer

// ---------------- save status ----------------
let projectSaveOk = true
let runsSaveOk = true
function reportSave() {
  if (useSave.getState().stale) return
  const ok = projectSaveOk && runsSaveOk
  useSave.setState({ status: ok ? 'saved' : 'error', savedAt: ok ? Date.now() : useSave.getState().savedAt })
}

async function saveProjectNow(p: Project): Promise<WriteResult> {
  if (!useSave.getState().stale) useSave.setState({ status: 'saving' })
  // Listed with the save time: after an undo the project carries the (older) time of the restored snapshot.
  const res = await guardedWrite(p.id, [[K.project(p.id), p]], { ...metaOf(p), updatedAt: Math.max(p.updatedAt, Date.now()) })
  const open = useProject.getState().project.id === p.id
  if (res === 'ok' && open) {
    savedProject = p
    // The backup holds this version or an older one: storage has it now.
    if (backupSeq && (seqOf.get(p) ?? 0) >= backupSeq) {
      removeOwnBackup(p.id)
      backupSeq = 0
    }
  }
  if (res === 'conflict' || !open) return res
  const wasOk = projectSaveOk
  projectSaveOk = res === 'ok'
  reportSave()
  if (!projectSaveOk && wasOk) useUI.getState().toast('Không lưu được dự án vào bộ nhớ trình duyệt (bộ nhớ đầy?).', { tone: 'error' })
  return res
}

async function saveRunsNow(projectId: string): Promise<WriteResult> {
  const { takes, credits, spent } = useRuns.getState()
  const data: RunsData = { takes, credits, spent }
  const res = await guardedWrite(projectId, [[K.runs(projectId), data]])
  const open = useProject.getState().project.id === projectId
  if (res === 'ok' && open) savedRuns = data
  if (res === 'conflict' || !open) return res
  const wasOk = runsSaveOk
  runsSaveOk = res === 'ok'
  if (!runsSaveOk || !wasOk) reportSave()
  if (!runsSaveOk && wasOk) useUI.getState().toast('Không lưu được các take và credit.', { tone: 'error' })
  return res
}

/** Synchronous emergency copy of the open project (survives a tab close while an IndexedDB write is pending). */
function writeBackup(p: Project): boolean {
  const info: BackupInfo = { baseRev: baseRevs.get(p.id) ?? null, tab: TAB_ID }
  const ok = lsSet(LS.backup(p.id), { project: p, savedAt: Date.now(), ...info })
  if (ok) backupSeq = Math.max(backupSeq, seqOf.get(p) ?? 0)
  return ok
}
type StoredBackup = BackupInfo & { project: unknown; savedAt?: number }

/** Remove the backup slot of a project unless another tab (same project open there) wrote it. */
function removeOwnBackup(id: string) {
  const b = lsGet<StoredBackup>(LS.backup(id))
  if (b && b.tab && b.tab !== TAB_ID && !backupLoadedFrom.has(b.tab)) return
  lsRemove(LS.backup(id))
}
/** Tabs whose backups this tab opened a project from (it now owns those edits). */
const backupLoadedFrom = new Set<string>()

interface Loaded {
  project: Project
  runs: RunsData | null
  rev: number | null
  /** The project came from an emergency backup newer than the stored copy (not written back yet). */
  unsaved: boolean
}

/** Project, runs and revision of `id`; a newer emergency backup of it wins over the stored copy. */
async function loadProjectData(id: string): Promise<Loaded | null> {
  const [stored, runs, stamp] = await Promise.all([readProject(id), readRuns(id), readStamp(id)])
  if (stamp?.deleted) return null
  const backup = lsGet<StoredBackup>(LS.backup(id))
  if (backup?.project && backupWins(backup, stamp)) {
    try {
      const project = migrateProject(backup.project)
      if (backup.tab) backupLoadedFrom.add(backup.tab)
      return { project, runs, rev: stamp?.rev ?? null, unsaved: true }
    } catch {
      /* unreadable backup: use the stored copy */
    }
  }
  return stored ? { project: stored, runs, rev: stamp?.rev ?? null, unsaved: false } : null
}

function openProject({ project: p, runs, rev, unsaved }: Loaded) {
  useProject.getState().loadProject(p)
  clearHistory()
  useRuns.getState().loadRuns(runs)
  useUI.getState().clearSelection()
  // Loading is not an edit: nothing to save (the subscriptions may have armed the timers).
  cancelPendingSaves()
  lsSet(LS.active, p.id)
  baseRevs.set(p.id, rev)
  stale.delete(p.id)
  const loaded = useProject.getState().project
  seqOf.set(loaded, ++editSeq)
  // A project restored from its backup keeps that backup until it is written.
  backupSeq = unsaved ? editSeq : 0
  savedProject = unsaved ? null : loaded
  const r = useRuns.getState()
  savedRuns = { takes: r.takes, credits: r.credits, spent: r.spent }
  projectSaveOk = runsSaveOk = true
  useSave.setState({ status: 'saved', savedAt: Date.now(), stale: false })
  void updateIndex((list) => upsertById(list, metaOf(p)))
  if (unsaved) scheduleProjectSave()
}

// ---------------- autosave ----------------
let started = false
let projectTimer: ReturnType<typeof setTimeout> | null = null
let runsTimer: ReturnType<typeof setTimeout> | null = null
let runsDirtySince = 0
const PROJECT_DEBOUNCE_MS = 400
const RUNS_DEBOUNCE_MS = 800
/** Running jobs change progress every tick, so the debounce alone would never fire during a batch. */
const RUNS_MAX_WAIT_MS = 3000

function cancelPendingSaves() {
  if (projectTimer) clearTimeout(projectTimer)
  if (runsTimer) clearTimeout(runsTimer)
  projectTimer = runsTimer = null
  runsDirtySince = 0
}

function scheduleProjectSave() {
  if (stale.has(useProject.getState().project.id)) return
  useSave.setState({ status: 'saving' })
  if (projectTimer) clearTimeout(projectTimer)
  projectTimer = setTimeout(() => {
    projectTimer = null
    if (projectDirty()) void saveProjectNow(useProject.getState().project)
    else reportSave()
  }, PROJECT_DEBOUNCE_MS)
}

function scheduleRunsSave() {
  if (stale.has(useProject.getState().project.id)) return
  if (runsTimer) clearTimeout(runsTimer)
  const now = Date.now()
  if (!runsDirtySince) runsDirtySince = now
  const wait = Math.max(0, Math.min(RUNS_DEBOUNCE_MS, runsDirtySince + RUNS_MAX_WAIT_MS - now))
  runsTimer = setTimeout(() => {
    runsTimer = null
    runsDirtySince = 0
    if (runsDirty()) void saveRunsNow(useProject.getState().project.id)
  }, wait)
}

/** One-time move of v1 data (localStorage) into IndexedDB. */
async function migrateFromLocalStorage(): Promise<ProjectMeta[] | null> {
  const index = lsGet<ProjectMeta[]>(LS.v1Index)
  if (!index?.length) return null
  const migrated: ProjectMeta[] = []
  for (const meta of index) {
    const raw = lsGet<unknown>(LS.v1Project(meta.id))
    if (!raw) continue
    const p = migrateProject(raw)
    const runs = lsGet<RunsData>(LS.v1Runs(meta.id))
    const ok = (await idbSet(K.project(p.id), p)) && (!runs || (await idbSet(K.runs(p.id), runs)))
    if (!ok) return null // keep the v1 data; try again next time
    migrated.push(metaOf(p))
  }
  await writeIndex(migrated)
  for (const meta of index) {
    lsRemove(LS.v1Project(meta.id))
    lsRemove(LS.v1Runs(meta.id))
  }
  lsRemove(LS.v1Index)
  return migrated
}

function backupKeys(): string[] {
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key === LS.legacyBackup || key.startsWith(LS.backupPrefix))) out.push(key)
    }
  } catch {
    /* storage unavailable */
  }
  return out
}

/**
 * Put emergency backups that are newer than the stored copy back into IndexedDB (every project, not only the
 * active one). A backup is removed only once it is written, or when the stored copy is newer.
 */
async function restoreBackups() {
  for (const key of backupKeys()) {
    const b = lsGet<StoredBackup>(key)
    let p: Project | null = null
    try {
      p = b?.project ? migrateProject(b.project) : null
    } catch {
      p = null
    }
    if (!b || !p) {
      lsRemove(key)
      continue
    }
    const stamp = await readStamp(p.id)
    let wins: boolean
    if (key === LS.legacyBackup) {
      const stored = await readProject(p.id)
      wins = !stamp?.deleted && (!stored || p.updatedAt > stored.updatedAt)
    } else wins = backupWins(b, stamp)
    if (!wins) {
      lsRemove(key)
      continue
    }
    baseRevs.set(p.id, stamp?.rev ?? null)
    const res = await guardedWrite(p.id, [[K.project(p.id), p]], metaOf(p))
    if (res !== 'error') lsRemove(key)
    else if (key === LS.legacyBackup) lsSet(LS.backup(p.id), { ...b, baseRev: stamp?.rev ?? null }) // keep it, in its own slot
  }
  if (lsGet(LS.legacyBackup)) lsRemove(LS.legacyBackup)
}

/** Load the last project (or create the demo), then autosave on every change. Call once at startup. */
export async function bootstrap(): Promise<void> {
  if (started) return
  started = true
  void navigator.storage?.persist?.().catch(() => undefined)

  let index = (await idbGet<ProjectMeta[]>(K.index)) ?? []
  if (!index.length) index = (await migrateFromLocalStorage()) ?? []
  useSave.setState({ projects: sortByUpdated(index) })

  // Edits whose IndexedDB write did not finish (tab closed, storage full) come back first.
  await restoreBackups()
  index = useSave.getState().projects

  const activeId = lsGet<string>(LS.active) ?? localStorage.getItem(LS.active)
  let loaded = activeId ? await loadProjectData(activeId) : null
  for (const m of index) if (!loaded) loaded = await loadProjectData(m.id)
  if (!loaded) {
    const demo = await createDemoProject()
    const written = await writeNewProject(demo)
    loaded = { project: demo, runs: null, rev: baseRevs.get(demo.id) ?? null, unsaved: !written }
  }
  openProject(loaded)

  useProject.subscribe((s, prev) => {
    if (s.project === prev.project) return
    seqOf.set(s.project, ++editSeq)
    if (s.project.id !== prev.project.id) return // switching projects is saved explicitly
    if (s.project === savedProject) return
    scheduleProjectSave()
  })
  useRuns.subscribe((s, prev) => {
    if (s.takes === prev.takes && s.credits === prev.credits && s.spent === prev.spent) return
    if (!runsDirty()) return
    scheduleRunsSave()
  })
  const onLeave = () => void flush()
  window.addEventListener('pagehide', onLeave)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave()
    else void checkOpenProject()
  })
  window.addEventListener('focus', () => void checkOpenProject())
  if (channel) {
    channel.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data
      if (!m || m.tab === TAB_ID) return
      void refreshIndex()
      const open = useProject.getState().project.id
      if (m.projectId !== open) return
      if (m.type === 'deleted') markStale(open, 'deleted')
      else if (m.type === 'saved') void otherTabSaved(open)
    }
  }
  useSave.setState({ ready: true })
}

/** Became visible/focused: catch up with saves of other tabs (also covers browsers without BroadcastChannel). */
async function checkOpenProject() {
  void refreshIndex()
  const id = useProject.getState().project.id
  if (stale.has(id)) return
  const stamp = await readStamp(id)
  if (stamp?.deleted) markStale(id, 'deleted')
  else if (isForeignWrite(stamp, baseRevs.get(id) ?? null, TAB_ID)) await otherTabSaved(id)
}

/**
 * Another tab saved the open project. Without unsaved changes here, show its version (reloaded once this tab is in
 * front, so a background tab does no work); with unsaved changes, this tab's copy is stale.
 */
async function otherTabSaved(id: string) {
  if (useProject.getState().project.id !== id || stale.has(id)) return
  if (hasUnsaved()) {
    markStale(id)
    return
  }
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return // checkOpenProject runs on focus
  const loaded = await loadProjectData(id)
  if (useProject.getState().project.id !== id || stale.has(id)) return
  if (!loaded) {
    markStale(id, 'deleted')
    return
  }
  if (hasUnsaved()) {
    markStale(id)
    return
  }
  openProject(loaded)
  useUI.getState().toast('Đã tải bản mới nhất của dự án (vừa được sửa ở tab/cửa sổ khác).', { tone: 'info' })
}

/**
 * Save the unsaved changes of the current project and its runs right away. Resolves false when something could
 * not be written (storage error, or the project is stale because another tab saved a newer version).
 */
export async function flush(): Promise<boolean> {
  cancelPendingSaves()
  const p = useProject.getState().project
  if (stale.has(p.id)) return false
  const needProject = projectDirty()
  const needRuns = runsDirty()
  if (!needProject && !needRuns) {
    projectSaveOk = runsSaveOk = true
    reportSave()
    return true
  }
  // Synchronous copy first: the IndexedDB write may not finish when the page is closing.
  if (needProject) writeBackup(p)
  const [projectRes, runsRes] = await Promise.all([needProject ? saveProjectNow(p) : 'ok', needRuns ? saveRunsNow(p.id) : 'ok'])
  return projectRes === 'ok' && runsRes === 'ok'
}

/**
 * Save the open project before another one replaces it in memory. Throws (nothing changes) when that fails:
 * switching anyway would throw the unsaved edits away. A stale copy (another tab saved a newer one) may be left.
 */
async function leaveCurrentProject() {
  if (await flush()) return
  if (stale.has(useProject.getState().project.id)) return
  throw new Error(
    'Chưa lưu được dự án đang mở (bộ nhớ trình duyệt có thể đã đầy) nên chưa chuyển dự án, để không mất các thay đổi. Hãy xoá bớt dự án/video cũ hoặc xuất dự án ra file rồi thử lại.',
  )
}

export async function switchProject(id: string): Promise<void> {
  const current = useProject.getState().project
  if (id === current.id) return
  await leaveCurrentProject()
  const loaded = await loadProjectData(id)
  if (!loaded) {
    useUI.getState().toast('Không mở được dự án này.', { tone: 'error' })
    return
  }
  openProject(loaded)
}

/** Store a brand-new project (its own revision 1 and list entry). */
async function writeNewProject(p: Project): Promise<boolean> {
  return (await guardedWrite(p.id, [[K.project(p.id), p]], metaOf(p))) === 'ok'
}

async function openNewProject(p: Project) {
  if (!(await writeNewProject(p))) throw new Error('Không tạo được dự án: không ghi được vào bộ nhớ trình duyệt (bộ nhớ đầy?).')
  openProject({ project: p, runs: null, rev: baseRevs.get(p.id) ?? null, unsaved: false })
}

export async function createProject(name = 'Dự án mới'): Promise<void> {
  await leaveCurrentProject()
  await openNewProject(emptyProject(name))
}

export async function createDemo(): Promise<void> {
  await leaveCurrentProject()
  await openNewProject(await createDemoProject())
}

/** "video S03·T2" for every take id of a project (text that replaces @video tokens when the takes are gone). */
function videoLabels(p: Project, takes: Take[]): Record<string, string> {
  const order = new Map(p.scenes.map((s) => [s.id, s.order]))
  return Object.fromEntries(takes.map((t) => [t.id, 'video ' + takeCode(order.get(t.sceneId), t.number)]))
}

export async function duplicateProject(id: string): Promise<void> {
  const current = useProject.getState().project
  const isCurrent = id === current.id
  const src = isCurrent ? current : (await loadProjectData(id))?.project
  if (!src) throw new Error('Không đọc được dự án này.')
  // Takes (videos) are not copied, so the copy cannot keep video references: their @video tokens become text.
  const takes = isCurrent ? useRuns.getState().takes : ((await readRuns(id))?.takes ?? [])
  const labels = videoLabels(src, takes)
  const now = Date.now()
  const p: Project = { ...dropVideoRefs(src, (t) => labels[t] ?? 'video'), id: newId('prj'), name: src.name + ' (bản sao)', createdAt: now, updatedAt: now }
  if (!(await writeNewProject(p))) throw new Error('Không lưu được bản sao: bộ nhớ trình duyệt có thể đã đầy.')
}

export async function deleteProject(id: string): Promise<void> {
  const isCurrent = useProject.getState().project.id === id
  // From now on this tab never writes it again (a flush would bring it back).
  stale.add(id)
  if (isCurrent) cancelPendingSaves()
  lsRemove(LS.backup(id))
  // Its takes' posters and videos go too. Asset images stay: duplicated projects share them.
  const takes = [...((await readRuns(id))?.takes ?? []), ...(isCurrent ? useRuns.getState().takes : [])]
  try {
    await db('readwrite', (store) => {
      const req = store.get(K.rev(id))
      req.onsuccess = () => {
        // Tombstone: a tab that still has it open must not write it back.
        store.put({ ...nextStamp(req.result as RevStamp | undefined, TAB_ID), deleted: true } satisfies RevStamp, K.rev(id))
      }
      store.delete(K.project(id))
      store.delete(K.runs(id))
      const ireq = store.get(K.index)
      ireq.onsuccess = () => {
        const list = ((ireq.result as ProjectMeta[] | undefined) ?? useSave.getState().projects).filter((m) => m.id !== id)
        store.put(list, K.index)
      }
      return new Promise<void>((resolve, reject) => {
        store.transaction.oncomplete = () => resolve()
        store.transaction.onabort = store.transaction.onerror = () => reject(store.transaction.error)
      })
    })
  } catch {
    stale.delete(id)
    throw new Error('Không xoá được dự án (lỗi bộ nhớ trình duyệt).')
  }
  broadcast('deleted', id)
  await refreshIndex()
  const list = useSave.getState().projects.filter((m) => m.id !== id)
  useSave.setState({ projects: list })
  if (isCurrent) {
    let next: Loaded | null = null
    for (const m of list) if ((next = await loadProjectData(m.id))) break
    if (next) openProject(next)
    else await openNewProject(emptyProject()).catch(() => openProject({ project: emptyProject(), runs: null, rev: null, unsaved: true }))
  }
  // After the next project is shown, so no visible poster loses its picture first.
  const media = new Set(takes.flatMap((t) => [t.posterId, t.videoId]).filter((m): m is string => !!m))
  for (const m of media) void deleteMedia(m).catch(() => undefined)
}

// ---------------- export / import (portable .json with embedded images) ----------------
interface ExportFile {
  format: 'sanovids' | 'ban-dung-phim'
  version: 1 | 2
  project: unknown
  media: Record<string, string> // image id -> data URL
  /** take id -> "video S03·T2": takes are not exported, their @video tokens become this text on import. */
  videoLabels?: Record<string, string>
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export async function exportProjectFile(): Promise<void> {
  await flush()
  const project = useProject.getState().project
  const media: Record<string, string> = {}
  for (const a of project.assets) {
    for (const id of a.imageIds) {
      const blob = await getBlob(id)
      if (blob) media[id] = await blobToDataUrl(blob)
    }
  }
  const file: ExportFile = { format: 'sanovids', version: 2, project, media, videoLabels: videoLabels(project, useRuns.getState().takes) }
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.name.replace(/[<>:"/\\|?*]/g, '-')}.sanovids.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export async function importProjectFile(file: File): Promise<void> {
  const data = JSON.parse(await file.text()) as ExportFile
  if ((data?.format !== 'sanovids' && data?.format !== 'ban-dung-phim') || !data.project) throw new Error('File không đúng định dạng dự án SanoVids.')
  await leaveCurrentProject()
  const idMap = new Map<string, string>()
  for (const [oldId, dataUrl] of Object.entries(data.media ?? {})) {
    idMap.set(oldId, await putBlob(dataUrlToBlob(dataUrl), 'img'))
  }
  const imported = migrateProject(data.project)
  const labels = data.videoLabels ?? {}
  // Takes are not exported, so video references cannot survive the trip: their tokens become plain text.
  const withoutVideos = dropVideoRefs(imported, (t) => labels[t] ?? 'video')
  const p: Project = {
    ...withoutVideos,
    id: newId('prj'),
    updatedAt: Date.now(),
    assets: withoutVideos.assets.map((a) => ({ ...a, imageIds: a.imageIds.map((id) => idMap.get(id) ?? id) })),
  }
  await openNewProject(p)
}

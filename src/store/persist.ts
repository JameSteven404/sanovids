// Local persistence. Projects and runs live in IndexedDB (no ~5 MB localStorage limit); media blobs live in
// their own IndexedDB store (lib/imageStore). A small synchronous localStorage backup of the open project is
// written when the page is hidden/closed, because IndexedDB writes may not finish during unload.
// Also project management (list / create / switch / duplicate / delete / export / import).
import { createStore, del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import { newId } from '../core/ids'
import { migrateProject } from '../core/migrate'
import { createDemoProject } from '../core/seed'
import type { Project, Take } from '../core/types'
import { dataUrlToBlob, getBlob, putBlob } from '../lib/imageStore'
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
}

export const useSave = create<SaveState>()(() => ({ status: 'idle', savedAt: null, projects: [], ready: false }))

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
}
const LS = {
  active: 'bdp:active',
  backup: 'bdp:backup',
  // v1 (localStorage) keys, migrated once
  v1Index: 'bdp:projects',
  v1Project: (id: string) => `bdp:project:${id}`,
  v1Runs: (id: string) => `bdp:runs:${id}`,
}

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

async function readProject(id: string): Promise<Project | null> {
  const raw = await idbGet<unknown>(K.project(id))
  return raw ? migrateProject(raw) : null
}
async function readRuns(id: string): Promise<RunsData | null> {
  return idbGet<RunsData>(K.runs(id))
}

function metaOf(p: Project): ProjectMeta {
  return { id: p.id, name: p.name, updatedAt: p.updatedAt, scenes: p.scenes.length }
}

async function writeIndex(list: ProjectMeta[]) {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  useSave.setState({ projects: sorted })
  await idbSet(K.index, sorted)
}

async function upsertIndex(p: Project) {
  const list = useSave.getState().projects.filter((m) => m.id !== p.id)
  await writeIndex([...list, metaOf(p)])
}

// ---------------- save status ----------------
let projectSaveOk = true
let runsSaveOk = true
function reportSave() {
  const ok = projectSaveOk && runsSaveOk
  useSave.setState({ status: ok ? 'saved' : 'error', savedAt: ok ? Date.now() : useSave.getState().savedAt })
}

async function saveProjectNow(p: Project): Promise<boolean> {
  useSave.setState({ status: 'saving' })
  const ok = await idbSet(K.project(p.id), p)
  if (ok) await upsertIndex(p)
  const wasOk = projectSaveOk
  projectSaveOk = ok
  reportSave()
  if (!ok && wasOk) useUI.getState().toast('Không lưu được dự án vào bộ nhớ trình duyệt.', { tone: 'error' })
  return ok
}

async function saveRunsNow(projectId: string): Promise<boolean> {
  const { takes, credits, spent } = useRuns.getState()
  const ok = await idbSet(K.runs(projectId), { takes, credits, spent } satisfies RunsData)
  const wasOk = runsSaveOk
  runsSaveOk = ok
  if (!ok || !wasOk) reportSave()
  if (!ok && wasOk) useUI.getState().toast('Không lưu được các take và credit.', { tone: 'error' })
  return ok
}

/** Synchronous emergency copy of the open project (survives a tab close while an IndexedDB write is pending). */
function writeBackup() {
  const p = useProject.getState().project
  lsSet(LS.backup, { project: p, savedAt: Date.now() })
}

function openProject(p: Project, runs: RunsData | null) {
  useProject.getState().loadProject(p)
  clearHistory()
  useRuns.getState().loadRuns(runs)
  useUI.getState().clearSelection()
  lsSet(LS.active, p.id)
  void upsertIndex(p)
  projectSaveOk = runsSaveOk = true
  useSave.setState({ status: 'saved', savedAt: Date.now() })
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
    localStorage.removeItem(LS.v1Project(meta.id))
    localStorage.removeItem(LS.v1Runs(meta.id))
  }
  localStorage.removeItem(LS.v1Index)
  return migrated
}

/** Load the last project (or create the demo), then autosave on every change. Call once at startup. */
export async function bootstrap(): Promise<void> {
  if (started) return
  started = true
  void navigator.storage?.persist?.().catch(() => undefined)

  let index = (await idbGet<ProjectMeta[]>(K.index)) ?? []
  if (!index.length) index = (await migrateFromLocalStorage()) ?? []
  useSave.setState({ projects: index })

  const activeId = lsGet<string>(LS.active) ?? localStorage.getItem(LS.active)
  let project = (activeId && (await readProject(activeId))) || (index[0] && (await readProject(index[0].id))) || null

  // A newer emergency backup of the same project wins (the last IndexedDB write did not finish).
  const backup = lsGet<{ project: unknown }>(LS.backup)
  if (backup?.project) {
    const b = migrateProject(backup.project)
    if (!project || (b.id === project.id && b.updatedAt > project.updatedAt)) project = b
  }

  if (!project) project = await createDemoProject()
  await idbSet(K.project(project.id), project)
  localStorage.removeItem(LS.backup)
  openProject(project, await readRuns(project.id))

  useProject.subscribe((s, prev) => {
    if (s.project === prev.project) return
    if (s.project.id !== prev.project.id) return // switching projects is saved explicitly
    useSave.setState({ status: 'saving' })
    if (projectTimer) clearTimeout(projectTimer)
    projectTimer = setTimeout(() => {
      projectTimer = null
      void saveProjectNow(useProject.getState().project)
    }, PROJECT_DEBOUNCE_MS)
  })
  useRuns.subscribe((s, prev) => {
    if (s.takes === prev.takes && s.credits === prev.credits) return
    if (runsTimer) clearTimeout(runsTimer)
    const now = Date.now()
    if (!runsDirtySince) runsDirtySince = now
    const wait = Math.max(0, Math.min(RUNS_DEBOUNCE_MS, runsDirtySince + RUNS_MAX_WAIT_MS - now))
    runsTimer = setTimeout(() => {
      runsTimer = null
      runsDirtySince = 0
      void saveRunsNow(useProject.getState().project.id)
    }, wait)
  })
  const onLeave = () => {
    if (projectTimer) writeBackup()
    void flush()
  }
  window.addEventListener('pagehide', onLeave)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave()
  })
  useSave.setState({ ready: true })
}

/** Save the current project and its runs right away. Resolves false when a write failed. */
export async function flush(): Promise<boolean> {
  const hadPendingProject = !!projectTimer
  cancelPendingSaves()
  const p = useProject.getState().project
  if (hadPendingProject) writeBackup()
  const [projectOk, runsOk] = await Promise.all([saveProjectNow(p), saveRunsNow(p.id)])
  if (projectOk) localStorage.removeItem(LS.backup)
  return projectOk && runsOk
}

export async function switchProject(id: string): Promise<void> {
  const current = useProject.getState().project
  if (id === current.id) return
  await flush()
  const p = await readProject(id)
  if (!p) {
    useUI.getState().toast('Không mở được dự án này.', { tone: 'error' })
    return
  }
  openProject(p, await readRuns(id))
}

async function openNewProject(p: Project) {
  await idbSet(K.project(p.id), p)
  openProject(p, null)
}

export async function createProject(name = 'Dự án mới'): Promise<void> {
  await flush()
  await openNewProject(emptyProject(name))
}

export async function createDemo(): Promise<void> {
  await flush()
  await openNewProject(await createDemoProject())
}

export async function duplicateProject(id: string): Promise<void> {
  await flush()
  const src = await readProject(id)
  if (!src) return
  const p: Project = { ...src, id: newId('prj'), name: src.name + ' (bản sao)', createdAt: Date.now(), updatedAt: Date.now() }
  await idbSet(K.project(p.id), p)
  await upsertIndex(p)
}

export async function deleteProject(id: string): Promise<void> {
  const list = useSave.getState().projects.filter((m) => m.id !== id)
  const isCurrent = useProject.getState().project.id === id
  // Never flush the project being deleted: that would write it back.
  if (isCurrent) {
    cancelPendingSaves()
    localStorage.removeItem(LS.backup)
  }
  await del(K.project(id), db).catch(() => undefined)
  await del(K.runs(id), db).catch(() => undefined)
  await writeIndex(list)
  if (isCurrent) {
    const next = list[0] && (await readProject(list[0].id))
    if (next) openProject(next, await readRuns(next.id))
    else await openNewProject(emptyProject())
  }
}

// ---------------- export / import (portable .json with embedded images) ----------------
interface ExportFile {
  format: 'sanovids' | 'ban-dung-phim'
  version: 1 | 2
  project: unknown
  media: Record<string, string> // image id -> data URL
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
  const file: ExportFile = { format: 'sanovids', version: 2, project, media }
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
  const idMap = new Map<string, string>()
  for (const [oldId, dataUrl] of Object.entries(data.media ?? {})) {
    idMap.set(oldId, await putBlob(dataUrlToBlob(dataUrl), 'img'))
  }
  await flush()
  const imported = migrateProject(data.project)
  const p: Project = {
    ...imported,
    id: newId('prj'),
    updatedAt: Date.now(),
    assets: imported.assets.map((a) => ({ ...a, imageIds: a.imageIds.map((id) => idMap.get(id) ?? id) })),
    // Takes are not exported, so video references cannot survive the trip.
    scenes: imported.scenes.map((s) => ({ ...s, videoRefs: [] })),
  }
  await openNewProject(p)
}

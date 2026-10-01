// Local persistence: projects in localStorage (JSON), media in IndexedDB (see lib/imageStore).
// Also project management (list / create / switch / duplicate / delete / export / import).
import { create } from 'zustand'
import { createDemoProject } from '../core/seed'
import { newId } from '../core/ids'
import type { Project, Take } from '../core/types'
import { getBlob, putBlob, dataUrlToBlob } from '../lib/imageStore'
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

const K = {
  index: 'bdp:projects',
  active: 'bdp:active',
  project: (id: string) => `bdp:project:${id}`,
  runs: (id: string) => `bdp:runs:${id}`,
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function writeJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function metaOf(p: Project): ProjectMeta {
  return { id: p.id, name: p.name, updatedAt: p.updatedAt, scenes: p.scenes.length }
}

function writeIndex(list: ProjectMeta[]) {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  writeJSON(K.index, sorted)
  useSave.setState({ projects: sorted })
}

function upsertIndex(p: Project) {
  const list = (readJSON<ProjectMeta[]>(K.index) ?? []).filter((m) => m.id !== p.id)
  writeIndex([...list, metaOf(p)])
}

// Last write result of each part; the save status is 'error' while either one fails.
let projectSaveOk = true
let runsSaveOk = true

function reportSave() {
  const ok = projectSaveOk && runsSaveOk
  useSave.setState({ status: ok ? 'saved' : 'error', savedAt: ok ? Date.now() : useSave.getState().savedAt })
}

function saveProjectNow(p: Project): boolean {
  useSave.setState({ status: 'saving' })
  const ok = writeJSON(K.project(p.id), p)
  if (ok) upsertIndex(p)
  projectSaveOk = ok
  reportSave()
  if (!ok) useUI.getState().toast('Không lưu được dự án (bộ nhớ trình duyệt đầy?)', { tone: 'error' })
  return ok
}

function saveRunsNow(projectId: string): boolean {
  const { takes, credits, spent } = useRuns.getState()
  const ok = writeJSON(K.runs(projectId), { takes, credits, spent })
  const wasOk = runsSaveOk
  runsSaveOk = ok
  if (!ok || !wasOk) reportSave()
  // Toast once per failure streak (runs are saved every few seconds while jobs are running).
  if (!ok && wasOk) useUI.getState().toast('Không lưu được các take và credit (bộ nhớ trình duyệt đầy?)', { tone: 'error' })
  return ok
}

function openProject(p: Project) {
  useProject.getState().loadProject(p)
  clearHistory()
  useRuns.getState().loadRuns(readJSON<{ takes: Take[]; credits: number; spent: number }>(K.runs(p.id)))
  useUI.getState().clearSelection()
  localStorage.setItem(K.active, p.id)
  upsertIndex(p)
  projectSaveOk = runsSaveOk = true
  useSave.setState({ status: 'saved', savedAt: Date.now() })
}

let started = false
let projectTimer: ReturnType<typeof setTimeout> | null = null
let runsTimer: ReturnType<typeof setTimeout> | null = null
/** When the oldest unsaved runs change happened (0 = nothing pending). */
let runsDirtySince = 0
const RUNS_DEBOUNCE_MS = 800
/** Running jobs change progress every tick, so the debounce alone would never fire during a batch. */
const RUNS_MAX_WAIT_MS = 3000

function cancelPendingSaves() {
  if (projectTimer) clearTimeout(projectTimer)
  if (runsTimer) clearTimeout(runsTimer)
  projectTimer = runsTimer = null
  runsDirtySince = 0
}

/** Load the last project (or create the demo), then autosave on every change. Call once at startup. */
export async function bootstrap(): Promise<void> {
  if (started) return
  started = true
  const index = readJSON<ProjectMeta[]>(K.index) ?? []
  useSave.setState({ projects: index })
  const activeId = localStorage.getItem(K.active)
  let project = (activeId && readJSON<Project>(K.project(activeId))) || (index[0] && readJSON<Project>(K.project(index[0].id))) || null
  if (!project) {
    project = await createDemoProject()
    writeJSON(K.project(project.id), project)
  }
  openProject(project)

  useProject.subscribe((s, prev) => {
    if (s.project === prev.project) return
    if (s.project.id !== prev.project.id) return // switching projects is saved explicitly
    useSave.setState({ status: 'saving' })
    if (projectTimer) clearTimeout(projectTimer)
    projectTimer = setTimeout(() => saveProjectNow(useProject.getState().project), 400)
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
      saveRunsNow(useProject.getState().project.id)
    }, wait)
  })
  window.addEventListener('beforeunload', flush)
  // A hidden tab may be discarded or killed without beforeunload: save what we have.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  useSave.setState({ ready: true })
}

/** Save the current project and its runs right away. Returns false when a write failed. */
export function flush(): boolean {
  cancelPendingSaves()
  const p = useProject.getState().project
  const projectOk = saveProjectNow(p)
  const runsOk = saveRunsNow(p.id)
  return projectOk && runsOk
}

export function switchProject(id: string) {
  const current = useProject.getState().project
  if (id === current.id) return
  flush()
  const p = readJSON<Project>(K.project(id))
  if (!p) {
    useUI.getState().toast('Không mở được dự án này.', { tone: 'error' })
    return
  }
  openProject(p)
}

function openNewEmptyProject(name = 'Dự án mới') {
  const p = emptyProject(name)
  writeJSON(K.project(p.id), p)
  openProject(p)
}

export function createProject(name = 'Dự án mới') {
  flush()
  openNewEmptyProject(name)
}

export async function createDemo() {
  flush()
  const p = await createDemoProject()
  writeJSON(K.project(p.id), p)
  openProject(p)
}

export function duplicateProject(id: string) {
  flush()
  const src = readJSON<Project>(K.project(id))
  if (!src) return
  const p: Project = { ...src, id: newId('prj'), name: src.name + ' (bản sao)', createdAt: Date.now(), updatedAt: Date.now() }
  writeJSON(K.project(p.id), p)
  upsertIndex(p)
}

export function deleteProject(id: string) {
  const list = (readJSON<ProjectMeta[]>(K.index) ?? []).filter((m) => m.id !== id)
  localStorage.removeItem(K.project(id))
  localStorage.removeItem(K.runs(id))
  writeIndex(list)
  if (useProject.getState().project.id === id) {
    // Never flush here: that would write the deleted (still loaded) project back to storage.
    cancelPendingSaves()
    const next = list[0] && readJSON<Project>(K.project(list[0].id))
    if (next) openProject(next)
    else openNewEmptyProject()
  }
}

// ---------------- export / import (portable .json with embedded images) ----------------
interface ExportFile {
  format: 'ban-dung-phim'
  version: 1
  project: Project
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
  flush()
  const project = useProject.getState().project
  const media: Record<string, string> = {}
  for (const a of project.assets) {
    for (const id of a.imageIds) {
      const blob = await getBlob(id)
      if (blob) media[id] = await blobToDataUrl(blob)
    }
  }
  const file: ExportFile = { format: 'ban-dung-phim', version: 1, project, media }
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.name.replace(/[<>:"/\\|?*]/g, '-')}.bdp.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export async function importProjectFile(file: File): Promise<void> {
  const data = JSON.parse(await file.text()) as ExportFile
  if (data?.format !== 'ban-dung-phim' || !data.project) throw new Error('File không đúng định dạng Bàn Dựng Phim.')
  const idMap = new Map<string, string>()
  for (const [oldId, dataUrl] of Object.entries(data.media ?? {})) {
    idMap.set(oldId, await putBlob(dataUrlToBlob(dataUrl), 'img'))
  }
  flush()
  const p: Project = {
    ...data.project,
    id: newId('prj'),
    updatedAt: Date.now(),
    assets: data.project.assets.map((a) => ({ ...a, imageIds: a.imageIds.map((id) => idMap.get(id) ?? id) })),
  }
  writeJSON(K.project(p.id), p)
  openProject(p)
}

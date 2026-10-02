// "Thư mục" nodes (Project.folders): pure rules — data repair for saved / imported projects, which folders a
// finished take goes to, cached lookups. Unit-tested in ./__tests__/folders.test.ts.
import { newId } from './ids'
import type { SaveFolder, XY } from './types'

/** Default size of a folder node on the canvas (it has no resize handle). */
export const FOLDER_W = 248
export const FOLDER_H = 132
/** Wire kinds that end at a folder node. */
export type FolderLinkKind = 'save' | 'autosave'

const MAX_LINKS = 1000
const isXY = (v: unknown): v is XY => !!v && typeof v === 'object' && Number.isFinite((v as XY).x) && Number.isFinite((v as XY).y)
const uniqueStrings = (v: unknown, keep: (s: string) => boolean = () => true): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x && keep(x)))].slice(0, MAX_LINKS) : []

/** "C:\Users\me\Videos\Phim A" / "/home/me/Phim A/" → "Phim A" ('' when there is none). */
export function folderBaseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Folder nodes of a saved / imported project, repaired: unique ids that collide with no other node (`taken`: scene and
 * asset ids), a name, a path or null, a position, mode 'copy', link lists without duplicates. Scene links to scenes
 * that no longer exist are dropped (`sceneIds`); take links cannot be checked here (takes live elsewhere) and stay.
 */
export function normalizeFolders(raw: unknown, taken: ReadonlySet<string> = new Set(), sceneIds?: ReadonlySet<string>): SaveFolder[] {
  if (!Array.isArray(raw)) return []
  const ids = new Set<string>()
  const out: SaveFolder[] = []
  raw.forEach((r, i) => {
    if (!r || typeof r !== 'object') return
    const f = r as Partial<SaveFolder>
    let id = typeof f.id === 'string' && f.id ? f.id : newId('fld')
    while (ids.has(id) || taken.has(id)) id = newId('fld')
    ids.add(id)
    const path = typeof f.path === 'string' && f.path.trim() && f.path.length <= 1024 && !f.path.includes('\u0000') ? f.path : null
    const name = (typeof f.name === 'string' && f.name.trim() ? f.name.trim() : path ? folderBaseName(path) : '').slice(0, 120) || 'Thư mục'
    const folder: SaveFolder = {
      id,
      name,
      path,
      position: isXY(f.position) ? { x: f.position.x, y: f.position.y } : { x: 40, y: 60 + i * (FOLDER_H + 28) },
      mode: 'copy',
    }
    const w = (f.size as { w?: unknown } | null | undefined)?.w
    const h = (f.size as { h?: unknown } | null | undefined)?.h
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) folder.size = { w, h }
    const autoScenes = uniqueStrings(f.autoScenes, (s) => !sceneIds || sceneIds.has(s))
    if (autoScenes.length) folder.autoScenes = autoScenes
    const takes = uniqueStrings(f.takes)
    if (takes.length) folder.takes = takes
    out.push(folder)
  })
  return out
}

/** Is `fromId` wired into the folder as `kind`? */
export function isLinked(folder: SaveFolder, kind: FolderLinkKind, fromId: string): boolean {
  return (kind === 'save' ? folder.takes : folder.autoScenes)?.includes(fromId) ?? false
}

/** The folder with `fromId` added to (`on`) or removed from its `kind` list; the same object when nothing changes. */
export function withLink(folder: SaveFolder, kind: FolderLinkKind, fromId: string, on: boolean): SaveFolder {
  const key = kind === 'save' ? 'takes' : 'autoScenes'
  const list = folder[key] ?? []
  if (list.includes(fromId) === on) return folder
  const next = on ? [...list, fromId] : list.filter((x) => x !== fromId)
  const out: SaveFolder = { ...folder, [key]: next }
  if (!next.length) delete out[key]
  return out
}

/**
 * Folders a take that just finished is saved to: those its scene is wired into ('autosave') and those the take
 * itself is wired into ('save', wired while it was still running). Each folder once, in folder order.
 */
export function folderTargetsFor(folders: readonly SaveFolder[] | undefined, take: { id: string; sceneId: string }): SaveFolder[] {
  return (folders ?? []).filter((f) => f.autoScenes?.includes(take.sceneId) || f.takes?.includes(take.id))
}

const folderMaps = new WeakMap<readonly SaveFolder[], Map<string, SaveFolder>>()
const EMPTY_MAP = new Map<string, SaveFolder>()
/** folder id → folder, cached per array (safe in zustand selectors). */
export function folderMapOf(folders: readonly SaveFolder[] | undefined): Map<string, SaveFolder> {
  if (!folders) return EMPTY_MAP
  let m = folderMaps.get(folders)
  if (!m) {
    m = new Map(folders.map((f) => [f.id, f]))
    folderMaps.set(folders, m)
  }
  return m
}

/** "C:\Users\me\Videos\Phim A" → "…\Videos\Phim A" (last `keep` parts) for a narrow label; the full path goes in its title. */
export function shortPath(path: string, keep = 2): string {
  const sep = path.includes('\\') ? '\\' : '/'
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  if (parts.length <= keep + 1) return path
  return `…${sep}${parts.slice(-keep).join(sep)}`
}

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
/** Link list without duplicates; past MAX_LINKS the most recent links (the end of the list) are kept. */
const uniqueStrings = (v: unknown, keep: (s: string) => boolean = () => true): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x && keep(x)))].slice(-MAX_LINKS) : []

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

/**
 * Folder nodes without the links to takes / scenes that are gone (deleted videos, deleted scenes). The same array when
 * nothing changes; an emptied list loses its key (like withLink).
 */
export function dropFolderLinks(
  folders: readonly SaveFolder[] | undefined,
  dead: { takes?: ReadonlySet<string>; scenes?: ReadonlySet<string> },
): SaveFolder[] | undefined {
  if (!folders) return folders
  const takesGone = (f: SaveFolder) => !!dead.takes?.size && !!f.takes?.some((t) => dead.takes!.has(t))
  const scenesGone = (f: SaveFolder) => !!dead.scenes?.size && !!f.autoScenes?.some((s) => dead.scenes!.has(s))
  if (!folders.some((f) => takesGone(f) || scenesGone(f))) return folders as SaveFolder[]
  return folders.map((f) => {
    if (!takesGone(f) && !scenesGone(f)) return f
    const out: SaveFolder = { ...f }
    const takes = takesGone(f) ? f.takes!.filter((t) => !dead.takes!.has(t)) : f.takes
    const autoScenes = scenesGone(f) ? f.autoScenes!.filter((s) => !dead.scenes!.has(s)) : f.autoScenes
    if (takes?.length) out.takes = takes
    else delete out.takes
    if (autoScenes?.length) out.autoScenes = autoScenes
    else delete out.autoScenes
    return out
  })
}

/**
 * Folder nodes for a copy of the project (Duplicate, import of a .sanovids.json): every node gets a new id, so the copy
 * never shares the original's folder access, waiting saves or counters (all kept per folder id); links to takes go
 * (takes are not copied); `keepPath: false` also forgets where the folder was on the computer (a file from elsewhere
 * must never choose where this computer writes: the node asks "Chọn lại thư mục"). `ids`: old id → new id.
 */
export function foldersForCopy(
  folders: readonly SaveFolder[] | undefined,
  opts: { keepPath: boolean; taken?: ReadonlySet<string> },
): { folders: SaveFolder[] | undefined; ids: Map<string, string> } {
  const ids = new Map<string, string>()
  if (!folders?.length) return { folders: folders as SaveFolder[] | undefined, ids }
  const used = new Set(opts.taken ?? [])
  const out = folders.map((f) => {
    let id = newId('fld')
    while (used.has(id)) id = newId('fld')
    used.add(id)
    ids.set(f.id, id)
    const { takes: _takes, ...rest } = f
    return { ...rest, id, path: opts.keepPath ? f.path : null }
  })
  return { folders: out, ids }
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
  return (folders ?? []).filter((f) => isTargeted(f, take))
}

/**
 * Is a wire still pointing this take at this folder: its own 'save' wire, or its scene's 'autosave' wire (the same test
 * as folderTargetsFor)? A save is only written while it is (a waiting save of a cut wire is dropped), and a cut wire
 * only takes its files along when nothing targets the folder for this take any more (core/folderTrash).
 */
export function isTargeted(folder: SaveFolder, take: { id: string; sceneId: string }): boolean {
  return !!(folder.takes?.includes(take.id) || folder.autoScenes?.includes(take.sceneId))
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

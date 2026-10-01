// Helpers shared by the sidebar panels and dialogs (area B). Pure functions + small hooks.
import { Mountain, Package, Palette, UserRound, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { imageSlotsFor, MENTION_RE, sceneCode, slugTag, takeCode, uniqueTag } from '../../core/compile'
import type { Asset, AssetKind, Project, Scene, Take, XY } from '../../core/types'
import { LAYOUT, redo, undo, useProject } from '../../store/project'
import { useUI } from '../../store/ui'

/** HTML5 drag payload contract shared with the canvas / scene table: JSON array of asset ids. */
export const ASSET_MIME = 'application/x-bdp-assets'
/**
 * HTML5 drag payload for finished videos (takes) dragged from the "Video đã tạo" list: JSON array of take ids.
 * Drop targets (canvas scene cards, scene table rows) link them as reference videos with `actions.linkTakes`.
 */
export const TAKE_MIME = 'application/x-bdp-takes'

export const EMPTY_IDS: string[] = []

export const KIND_ORDER: AssetKind[] = ['character', 'location', 'prop', 'style']

export const KIND_META: Record<AssetKind, { label: string; newName: string; Icon: LucideIcon }> = {
  character: { label: 'Nhân vật', newName: 'Nhân vật mới', Icon: UserRound },
  location: { label: 'Bối cảnh', newName: 'Bối cảnh mới', Icon: Mountain },
  prop: { label: 'Đạo cụ', newName: 'Đạo cụ mới', Icon: Package },
  style: { label: 'Phong cách', newName: 'Phong cách mới', Icon: Palette },
}

// ---------------- search ----------------
/** Lowercase + strip Vietnamese diacritics so "lang nui" finds "Làng núi". */
export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
}

/** Every whitespace-separated term of the query must appear in one of the fields. */
export function matchesQuery(query: string, ...fields: string[]): boolean {
  const q = norm(query.trim())
  if (!q) return true
  const hay = norm(fields.join(' \u0001 '))
  return q.split(/\s+/).every((term) => hay.includes(term.replace(/^@/, '')))
}

// ---------------- @image numbers ----------------
/**
 * "@image_N" label of every asset referenced by `refs` (scene.refs order, one number per image).
 * An asset with several images gets a range ("@image_2–4"); a linked asset without image gets "" (linked, no number).
 * Values are strings so a zustand selector returning this map stays shallow-comparable.
 */
export function imageTokenLabels(assets: Asset[], refs: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of refs) out[id] = ''
  const range = new Map<string, [number, number]>()
  for (const s of imageSlotsFor(assets, refs)) {
    const r = range.get(s.assetId)
    if (r) r[1] = s.n
    else range.set(s.assetId, [s.n, s.n])
  }
  for (const [id, [first, last]] of range) out[id] = first === last ? `@image_${first}` : `@image_${first}–${last}`
  return out
}

// ---------------- finished videos (takes) ----------------
/** Completed takes whose scene still exists, newest first. */
export function finishedTakes(takes: Take[], sceneIds: ReadonlySet<string>): Take[] {
  return takes
    .filter((t) => t.status === 'completed' && sceneIds.has(t.sceneId))
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.number - a.number)
}

/** Search fields for a take: "S03·T2" plus the spellings people type ("S03-T2", "S03T2", "s3 t2"), scene title. */
export function takeSearchFields(sceneOrder: number | undefined, takeNumber: number, sceneTitle = ''): string[] {
  const code = takeCode(sceneOrder, takeNumber)
  const [s, t] = code.split('·')
  return [code, `${s}-${t}`, `${s}${t}`, `${s} ${t}`, sceneOrder ? `S${sceneOrder} T${takeNumber}` : '', sceneTitle]
}

// ---------------- persistence of small UI prefs ----------------
export function readPrefValue<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem('bdp:pref:' + key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem('bdp:pref:' + key, JSON.stringify(value))
  } catch {
    /* storage may be unavailable */
  }
}

/** useState that remembers its value in localStorage (per browser). */
export function usePrefState<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => readPrefValue(key, fallback))
  useEffect(() => writePref(key, value), [key, value])
  return [value, setValue]
}

// ---------------- selection-derived hooks ----------------
/** Ids of the scenes currently selected (canvas / table), in selection order. Stable between renders. */
export function useSelectedSceneIds(): string[] {
  const selectedIds = useUI((s) => s.selectedIds)
  return useProject(
    useShallow((s) => {
      if (!selectedIds.length) return EMPTY_IDS
      const ids = new Set<string>()
      for (const sc of s.project.scenes) ids.add(sc.id)
      const out = selectedIds.filter((id) => ids.has(id))
      return out.length ? out : EMPTY_IDS
    }),
  )
}

/** Id of the scene when exactly one scene is selected, else null. */
export function useSingleSceneId(): string | null {
  const selected = useSelectedSceneIds()
  return selected.length === 1 ? selected[0] : null
}

/** "S03" of a scene (primitive selection: no re-render while its prompt is being typed). */
export function useSceneCode(sceneId: string | null): string {
  const order = useProject((s) => (sceneId ? s.project.scenes.find((sc) => sc.id === sceneId)?.order ?? 0 : 0))
  return order ? sceneCode(order) : ''
}

// ---------------- canvas placement ----------------
/** Next free slot in the asset column on the left of the canvas. */
export function nextAssetPosition(project: Project): XY {
  const placed = project.assets.filter((a) => a.position)
  if (!placed.length) return { x: LAYOUT.assetX, y: LAYOUT.scenesY }
  const x = Math.min(...placed.map((a) => a.position!.x))
  const y = Math.max(...placed.map((a) => a.position!.y)) + LAYOUT.assetH + LAYOUT.assetGapY
  return { x, y }
}

// ---------------- tag rename ----------------
// The tag is a short handle used to find an asset (library search, the "@" popup of the prompt editor) and by
// legacy "@Tag" mentions in old prompts, which are still converted to @image_N when sending.
export interface TagCheck {
  /** Normalized tag that would be stored. */
  tag: string
  error: string | null
  changed: boolean
}

/** Validate a tag typed by the user against the other assets of the project. */
export function checkTag(project: Project, assetId: string, raw: string): TagCheck {
  const asset = project.assets.find((a) => a.id === assetId)
  const cleaned = raw.trim().replace(/^@+/, '')
  if (!cleaned) return { tag: asset?.tag ?? '', error: 'Tag không được để trống.', changed: false }
  const tag = slugTag(cleaned)
  const owner = project.assets.find((a) => a.id !== assetId && a.tag.toLowerCase() === tag.toLowerCase())
  if (owner) return { tag, error: `@${tag} đã được dùng cho “${owner.name}”.`, changed: false }
  if (/^(image|video)_\d+$/i.test(tag)) return { tag, error: 'Tag không được trùng dạng @image_N / @video_N.', changed: false }
  return { tag, error: null, changed: tag !== asset?.tag }
}

/** Replace @old (case-insensitive) mentions with @next. */
function renameMentions(text: string, oldTag: string, nextTag: string): string {
  const key = oldTag.toLowerCase()
  return text.replace(MENTION_RE, (whole, tag: string) => (tag.toLowerCase() === key ? '@' + nextTag : whole))
}

/** How many scene prompts still mention the legacy @tag. */
export function countMentions(project: Project, tag: string): number {
  const key = tag.toLowerCase()
  const has = (text: string) => {
    for (const m of text.matchAll(MENTION_RE)) if (m[1].toLowerCase() === key) return true
    return false
  }
  return project.scenes.filter((s) => has(s.prompt)).length
}

/**
 * Rename an asset's tag and rewrite its legacy @mentions in every scene prompt, as ONE undo step.
 * (Workaround until the project store has a `renameTag` action: zundo tracks `useProject.setState` too.)
 */
export function renameAssetTag(assetId: string, raw: string): { ok: boolean; tag: string; rewritten: number; error?: string } {
  const project = useProject.getState().project
  const asset = project.assets.find((a) => a.id === assetId)
  if (!asset) return { ok: false, tag: '', rewritten: 0, error: 'Không tìm thấy mục.' }
  const check = checkTag(project, assetId, raw)
  if (check.error) return { ok: false, tag: asset.tag, rewritten: 0, error: check.error }
  if (!check.changed) return { ok: true, tag: asset.tag, rewritten: 0 }
  const others = project.assets.filter((a) => a.id !== assetId).map((a) => a.tag)
  const next = uniqueTag(check.tag, others)
  const oldTag = asset.tag
  let rewritten = 0
  useProject.setState((s) => {
    const p = s.project
    const scenes = p.scenes.map((sc) => {
      const prompt = renameMentions(sc.prompt, oldTag, next)
      if (prompt === sc.prompt) return sc
      rewritten++
      return { ...sc, prompt }
    })
    return {
      project: {
        ...p,
        updatedAt: Date.now(),
        assets: p.assets.map((a) => (a.id === assetId ? { ...a, tag: next } : a)),
        scenes,
      },
    }
  })
  return { ok: true, tag: next, rewritten }
}

/** Ids of scenes whose prompt differs between two versions of the scene list (e.g. after an automatic renumbering). */
export function changedPrompts(before: Scene[], after: Scene[]): string[] {
  const old = new Map(before.map((s) => [s.id, s.prompt]))
  return after.filter((s) => old.has(s.id) && old.get(s.id) !== s.prompt).map((s) => s.id)
}

// ---------------- undo from a toast ----------------
/**
 * "Hoàn tác" toast action for the edit that was JUST made (call it right after the store mutation).
 * It only undoes while that edit is still the latest change to the project: the global undo() pops the newest
 * history step, so after any later edit (typing, another unlink…) it would revert that one instead.
 */
export { undoToastAction } from '../../store/project'

// ---------------- keyboard undo inside live-edit dialogs ----------------
function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true
  if (el.tagName !== 'INPUT') return false
  return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes((el as HTMLInputElement).type)
}

/**
 * Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y while the asset dialog is open (the global shortcuts are off while a dialog is
 * open). Text fields keep their native text undo.
 */
export function useDialogUndoKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey || isTextField(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

// ---------------- file drops nobody handles ----------------
export const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')

let dropGuard = false
/**
 * Without this, an image file dropped where nothing accepts it (inspector, sidebar, dialog margins…) makes the
 * browser open the file in the tab, leaving the app (undo history, selection, running mock jobs are lost).
 * Installed once for the page; a drop zone that handles files calls preventDefault itself and is left alone.
 */
export function useFileDropGuard() {
  useEffect(() => {
    if (dropGuard) return
    dropGuard = true
    window.addEventListener('dragover', (e) => {
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'none'
    })
    window.addEventListener('drop', (e) => {
      if (hasFiles(e.dataTransfer)) e.preventDefault()
    })
  }, [])
}

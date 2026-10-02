// Helpers shared by the sidebar panels and dialogs (area B). Pure functions + small hooks.
import { Mountain, Package, Palette, UserRound, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { imageSlotsFor, MENTION_RE, parseTokens, sceneCode, slugTag, takeCode, uniqueTag } from '../../core/compile'
import { costOf, MODELS, normalizeSettings, usesRefs, usesVideoRefs, type ModelSpec } from '../../core/models'
import { CREDIT_SOURCE_LABEL, DEMO_CREDIT_HINT, formatCreditNumber, formatCredits, formatVnd, type CreditKind } from '../../lib/credits'
import type { Asset, AssetKind, ModelId, Preset, Project, Scene, Take, VideoSettings, XY } from '../../core/types'
import { LAYOUT, redo, undo, useProject } from '../../store/project'
import { ASSET_DEFAULT_W, assetNodeHeight, layoutTakes } from '../canvas/canvasModel'
import { useUI, type TakeDisplay } from '../../store/ui'

/**
 * HTML5 drag payload types now live in `src/lib/dnd.ts` (ASSETS_MIME, TAKES_MIME, readIds); import them from there.
 * @deprecated aliases kept so older imports from this module keep compiling.
 */
export { ASSETS_MIME as ASSET_MIME, TAKES_MIME as TAKE_MIME } from '../../lib/dnd'

export const EMPTY_IDS: string[] = []

export const KIND_ORDER: AssetKind[] = ['character', 'location', 'prop', 'style']

export const KIND_META: Record<AssetKind, { label: string; newName: string; Icon: LucideIcon }> = {
  character: { label: 'Nhân vật', newName: 'Nhân vật mới', Icon: UserRound },
  location: { label: 'Bối cảnh', newName: 'Bối cảnh mới', Icon: Mountain },
  prop: { label: 'Đạo cụ', newName: 'Đạo cụ mới', Icon: Package },
  style: { label: 'Phong cách', newName: 'Phong cách mới', Icon: Palette },
}

/** KIND_META of an asset; an unknown kind (file from a newer build, hand-edited import) shows as a character. */
export function kindMeta(kind: string): (typeof KIND_META)[AssetKind] {
  return KIND_META[kind as AssetKind] ?? KIND_META.character
}

// ---------------- models / presets ----------------
/** Spec of a model; an unknown model id (imported preset from a newer build…) falls back to Seedance 2.5. */
export function modelSpec(model: string): ModelSpec {
  return MODELS[model as ModelId] ?? MODELS.seedance_2_5
}

/**
 * Mode label for one model: "(+ảnh)" only where that model + mode really sends reference images
 * (MiniMax-H3's Text → Video sends none). With several models (`model` omitted) the plain name.
 * Lives in core/models now; re-exported so the panels' existing imports keep working.
 */
export { modeLabel } from '../../core/models'

/** Do a scene's settings still equal the preset's (a preset edited after it was applied no longer matches)? */
export function presetMatches(preset: Preset, settings: VideoSettings): boolean {
  const p = normalizeSettings(preset)
  return p.model === settings.model && p.mode === settings.mode && p.duration === settings.duration && p.resolution === settings.resolution && p.ratio === settings.ratio
}

/**
 * The preset a scene really runs with: its `presetId` only while the scene's settings still equal that preset's.
 * After the preset was edited the scene is "Tuỳ chỉnh" (null), so picking the preset again applies the new values.
 */
export function appliedPresetId(presetId: string | null, settings: VideoSettings, presets: Preset[]): string | null {
  if (!presetId) return null
  const preset = presets.find((p) => p.id === presetId)
  return preset && presetMatches(preset, settings) ? presetId : null
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

/**
 * Scenes using `assetId` whose prompt has an @image_N token pointing at the asset's images `fromImage..toImage`
 * (indexes inside the asset; `toImage` defaults to "and every number after it"). These are the tokens that
 * point at another photo after removing / reordering / adding images of the asset when automatic renumbering
 * is off. `assets` / `scenes` must be the state BEFORE the change.
 */
export function scenesWithShiftedImageTokens(assets: Asset[], scenes: Scene[], assetId: string, fromImage: number, toImage = Infinity): string[] {
  const out: string[] = []
  for (const sc of scenes) {
    const at = sc.refs.indexOf(assetId)
    if (at < 0) continue
    const base = imageSlotsFor(assets, sc.refs.slice(0, at)).length + 1
    const lo = base + fromImage
    const hi = base + toImage
    if (parseTokens(sc.prompt).some((t) => t.kind === 'image' && t.n >= lo && t.n <= hi)) out.push(sc.id)
  }
  return out
}

// Moved to core/staleTokens (pure, shared with canvas edits and actions); re-exported for existing imports.
export { scenesWithStaleTokens, staleTokenNote, tokensShifted } from '../../core/staleTokens'

/** Hint under an asset's images: what changing them does to the @image numbers of the scenes using it. */
export function imageRenumberNote(autoRenumber: boolean, used: number): { text: string; warn: boolean } {
  if (autoRenumber) return { text: `Đổi ảnh sẽ tự đánh lại số @image trong các cảnh đang dùng${used ? ` (${used} cảnh)` : ''}.`, warn: false }
  return {
    text: used
      ? `Tự đánh lại số @image đang tắt (Cài đặt) — đổi / bỏ / thêm ảnh sẽ làm số @image trong ${used} cảnh đang dùng trỏ sang ảnh khác; hãy tự sửa prompt.`
      : 'Tự đánh lại số @image đang tắt (Cài đặt) — đổi ảnh sẽ không sửa prompt của các cảnh.',
    warn: true,
  }
}

// ---------------- library cards ----------------
/**
 * What a key pressed on a focused library card does. Delete / Backspace are swallowed ('block'): the global
 * shortcut would delete the canvas selection (scenes, generated videos), a different selection than the
 * library's — a library item is deleted from its dialog.
 */
export function libraryCardKey(key: string): 'open' | 'toggle' | 'block' | null {
  if (key === 'Enter') return 'open'
  if (key === ' ') return 'toggle'
  if (key === 'Delete' || key === 'Backspace') return 'block'
  return null
}

/**
 * Kind given to new library items: the active kind tab, or "character" when the filter is "all" or the library is
 * empty (the remembered tab is per browser and its tabs are hidden while the library is empty).
 */
export function newAssetKind(filter: 'all' | AssetKind, assetCount: number): AssetKind {
  return filter === 'all' || assetCount === 0 ? 'character' : filter
}

// ---------------- what the selected scene's model / mode sends ----------------
export interface SceneMediaFlags {
  /** Reference images (@image_N) are sent. */
  images: boolean
  /** Reference videos (@video_N) are accepted. */
  videos: boolean
  /** Model name, e.g. "MiniMax-H3" ('' when no scene). */
  model: string
}

const ALL_MEDIA: SceneMediaFlags = { images: true, videos: true, model: '' }

export function sceneMediaFlags(settings: VideoSettings | undefined): SceneMediaFlags {
  if (!settings) return ALL_MEDIA
  return { images: usesRefs(settings), videos: usesVideoRefs(settings), model: MODELS[settings.model]?.name ?? settings.model }
}

/** sceneMediaFlags of one scene (primitive fields: no re-render while its prompt is typed). */
export function useSceneMediaFlags(sceneId: string | null): SceneMediaFlags {
  return useProject(useShallow((s) => sceneMediaFlags(sceneId ? s.project.scenes.find((sc) => sc.id === sceneId)?.settings : undefined)))
}

// ---------------- finished videos (takes) ----------------
/** Completed takes whose scene still exists, newest first. */
export function finishedTakes(takes: Take[], sceneIds: ReadonlySet<string>): Take[] {
  return takes
    .filter((t) => t.status === 'completed' && sceneIds.has(t.sceneId))
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.number - a.number)
}

/**
 * Is this take's video node hidden on the canvas? Only in the "Chỉ take chọn" display, which shows the chosen take of
 * each scene plus takes used as @video (same rule as the canvas layout). Selecting a hidden take would select
 * something invisible, so the takes list selects its scene instead (like the queue's "Đi tới").
 */
export function takeHiddenOnCanvas(takeId: string, takes: Take[], scenes: Scene[], display: TakeDisplay): boolean {
  if (display !== 'chosen') return false
  return !layoutTakes(takes, scenes, 'chosen').byId.has(takeId)
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
/**
 * Next free slot in the asset column of the canvas: below the lowest bottom edge of the cards IN that column, so an
 * asset node the user made taller (resize handle, `asset.size`) is not overlapped. The column is where most cards are
 * (ties: nearest the default column on the left): a card dragged next to a scene far below, or far to the left, no
 * longer sends every new card there. A card a little to the side of the column (not counted in it) that the new card
 * `card` (the asset being placed: its size; default card otherwise) would still overlap is stepped over too, as is
 * any card the new one would then hit — the new card never covers another one.
 */
export function nextAssetPosition(project: Project, card?: Pick<Asset, 'size' | 'imageIds'>): XY {
  const placed = project.assets.filter((a) => a.position)
  if (!placed.length) return { x: LAYOUT.assetX, y: LAYOUT.scenesY }
  const near = (a: Asset, b: Asset) => Math.abs(a.position!.x - b.position!.x) < LAYOUT.assetW / 2
  let column: Asset[] = []
  let key = Infinity
  for (const a of placed) {
    const members = placed.filter((b) => near(a, b))
    const dist = Math.abs(a.position!.x - LAYOUT.assetX)
    if (members.length > column.length || (members.length === column.length && dist < key)) {
      column = members
      key = dist
    }
  }
  const measured = useUI.getState().measured
  const heightOf = (a: Asset) => assetNodeHeight(a, measured[a.id]?.height)
  const x = Math.min(...column.map((a) => a.position!.x))
  let y = Math.max(...column.map((a) => a.position!.y + heightOf(a))) + LAYOUT.assetGapY
  const w = card?.size?.w ?? ASSET_DEFAULT_W
  const h = assetNodeHeight(card ?? { imageIds: [] })
  const gap = LAYOUT.assetGapY
  const boxes = placed.map((a) => ({ x: a.position!.x, y: a.position!.y, w: a.size?.w ?? ASSET_DEFAULT_W, h: heightOf(a) }))
  for (let i = 0; i < boxes.length + 1; i++) {
    // overlapping horizontally and closer than one gap vertically: go one gap below it
    const hits = boxes.filter((b) => b.x < x + w && x < b.x + b.w && b.y < y + h + gap && y < b.y + b.h + gap)
    if (!hits.length) break
    y = Math.max(...hits.map((b) => b.y + b.h)) + gap
  }
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

// ---------------- costs: demo vs real credits (docs/SPEC-v2.md §9) ----------------
// Every cost label of the workspace (scene card, inspector, presets, scene table) shows the wallet the NEXT run pays
// with: `useCreditKind()` from store/credits (same value as useCreditInfo().kind, without subscribing to balances).
// Amounts go through lib/credits formatCredits(n, kind, { short }). Look (each area's CSS, tokens only):
//   is-demo  play money — neutral text, dashed outline / dashed underline, a small "demo" mark next to short amounts;
//   is-real  real canvasapp credits — solid --info tint (fill or text), the color of the top bar credit pill; the
//            accent stays for Run. Inside a filled Run button both kinds are drawn in the button's text color.

/** Modifier class of a cost label. */
export function creditTone(kind: CreditKind): 'is-demo' | 'is-real' {
  return kind === 'demo' ? 'is-demo' : 'is-real'
}

/** Per-run cost of several scenes added up (what "Chạy tất cả" / a batch run costs). */
export function totalCost(scenes: readonly { settings: VideoSettings }[]): number {
  return scenes.reduce((t, s) => t + costOf(s.settings), 0)
}

/** Second tooltip line of a canvasapp cost: the table is an estimate, the real account is billed by canvasapp. */
export const REAL_COST_HINT = 'Ước tính — trừ trên tài khoản canvasapp khi job được nhận'

/**
 * Tooltip of a cost, two lines: the amount with its wallet, then what that wallet means. `lead` goes first
 * ("Chạy S01 · ").
 *   demo       "Chạy S01 · 20 credit demo\nCredit giả lập — không phải tiền thật"
 *   canvasapp  "Chạy S01 · ≈ 20 credit canvasapp (≈ 20.000đ)\nƯớc tính — trừ trên tài khoản canvasapp khi job được nhận"
 * An unknown amount shows "—" (never a made-up number).
 */
export function costTitle(n: number | null | undefined, kind: CreditKind, lead = ''): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return `${lead}${formatCredits(n, kind)}`
  if (kind === 'demo') return `${lead}${formatCredits(n, 'demo')}\n${DEMO_CREDIT_HINT}`
  return `${lead}≈ ${formatCreditNumber(n)} ${CREDIT_SOURCE_LABEL.canvasapp} (≈ ${formatVnd(n)})\n${REAL_COST_HINT}`
}

// ---------------- library masonry ----------------
/**
 * Greedy masonry: each item (height in column widths) goes to the currently shortest column (the left one on a tie),
 * so tall and wide pictures both pack well. Returns item indexes per column, in list order within a column.
 */
export function packColumns(heights: number[], cols: number): number[][] {
  const n = Math.max(1, Math.floor(cols))
  const out: number[][] = Array.from({ length: n }, () => [])
  const h = new Array<number>(n).fill(0)
  heights.forEach((height, i) => {
    let c = 0
    for (let k = 1; k < n; k++) if (h[k] < h[c] - 1e-9) c = k
    out[c].push(i)
    h[c] += Number.isFinite(height) && height > 0 ? height : 1
  })
  return out
}

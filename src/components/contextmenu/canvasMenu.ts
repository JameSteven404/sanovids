// Right-click menus of the canvas: one builder per target (scene, video, image card, thumbnail on a scene card,
// folder, wire(s), empty canvas, several cards). Each builder reads the stores ONCE (getState, when the menu opens —
// no subscription, nothing compiled) and returns a MenuSpec whose items carry their command. Commands are the existing
// ones (actions / folderActions / menuActions / edges.cutEdge); the questions the keyboard asks are asked here too,
// before the command (deleting a video always asks — it cannot be undone).
import {
  cancelFactsOf,
  cancelTake,
  checkTakeDelete,
  connectSelection,
  pickImagesAt,
  createSceneFromVideo,
  deleteFacts,
  deleteSelection,
  deleteTakes,
  downloadTakeOnce,
  duplicateSelection,
  edgeId,
  fitNodes,
  focusNodes,
  isFolderEdge,
  keyboardDeletePlan,
  linkAssets,
  newScene,
  nextScene,
  parseEdgeId,
  requestRun,
  rerunTake,
  selectedAssetIds,
  takeLabel,
  type EdgeKind,
} from '../../actions'
import { sceneCode, tokenForAsset } from '../../core/compile'
import { MODELS } from '../../core/models'
import { sceneRunBlockReason } from '../../core/runRules'
import type { Asset, Project, Scene, Take, VideoSettings, XY } from '../../core/types'
import { openFilmPlayer } from '../../filmActions'
import { chooseFolderPlace, createFolderNode, grantFolderAccess, linkScenesToFolder, linkTakesToFolder, openFolderNode, removeFolderNode } from '../../folderActions'
import { useCanvasPrefs } from '../../lib/canvasPrefs'
import { creditKindOf, formatCredits } from '../../lib/credits'
import { desktopFiles } from '../../lib/desktopFiles'
import { useDownloadPrefs } from '../../lib/downloads'
import { canTrashSaved, folderRuntime } from '../../lib/saveFolders'
import { hideAssets, linkedPairs, scenesUsingAsset, unlinkAllFromScene, unlinkAssetsFromScenes, unlinkSelection } from '../../menuActions'
import { activeProviderId, PROVIDER_LABEL, providerBlockedReason, providerLimits } from '../../providers'
import { settingsRunBlock, takeCost } from '../../providers/limits'
import { freeSpotFrom, LAYOUT, refImageCount, undoToastAction, useProject } from '../../store/project'
import { isParkedTake, isUncertainSubmit, useRuns } from '../../store/runs'
import { useSceneEditor } from '../../store/sceneEditor'
import { toast, useUI } from '../../store/ui'
import { snap } from '../canvas/canvasModel'
import { cutEdge } from '../canvas/edges'
import { cancelQuestion } from '../runs/creditText'
import { typeOnNode } from '../canvas/SceneNodeEditor'
import { capRows, countsText, SEP, tidyEntries, type MenuEntry, type MenuItem, type MenuSpec } from './menuModel'

/** What was right-clicked (resolved from the DOM by canvasContextMenu). `flow` = the pointer in canvas coordinates. */
export type CanvasTarget =
  | { kind: 'scene'; id: string }
  | { kind: 'take'; id: string }
  | { kind: 'asset'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'ref'; assetId: string; sceneId: string }
  | { kind: 'edges'; ids: string[] }
  | { kind: 'multi' }
  | { kind: 'pane' }

export interface CanvasMenuContext {
  /** Pointer in canvas (flow) coordinates: where new nodes go. */
  flow: XY
  /** Pointer on screen: where a cut wire splits. */
  at?: { x: number; y: number }
}

/** Existing folder nodes offered in "Lưu vào thư mục ▸" (the most recent ones, like ConnectMenu). */
export const MAX_FOLDER_ITEMS = 3
/** "Chạy N cảnh": priced only up to this many scenes (the cost dialog prices more). */
export const MAX_PRICED_SCENES = 50

const DELETE_TAKE_ALWAYS = (what: string) => `Xoá vĩnh viễn ${what}? Video đã xoá không hoàn tác được.`
const RUNNING_DELETE_REASON = 'Có video đang chờ / đang tạo — huỷ chúng trước'

// ---------------- snapshot helpers ----------------
interface Snap {
  project: Project
  takes: Take[]
  selectedIds: string[]
  selectedEdgeIds: string[]
  scenes: Map<string, Scene>
  assets: Map<string, Asset>
  takesById: Map<string, Take>
}
function snapshot(): Snap {
  const project = useProject.getState().project
  const takes = useRuns.getState().takes
  const ui = useUI.getState()
  return {
    project,
    takes,
    selectedIds: ui.selectedIds,
    selectedEdgeIds: ui.selectedEdgeIds,
    scenes: new Map(project.scenes.map((s) => [s.id, s])),
    assets: new Map(project.assets.map((a) => [a.id, a])),
    takesById: new Map(takes.map((t) => [t.id, t])),
  }
}
const codeOf = (s: Snap, sceneId: string) => {
  const sc = s.scenes.get(sceneId)
  return sc ? sceneCode(sc.order) : 'cảnh'
}
const selScenes = (s: Snap) => s.selectedIds.filter((id) => s.scenes.has(id))
const priceOf = (cost: number) => formatCredits(cost, creditKindOf(activeProviderId()))
/** What a new take of these settings costs now (canvasapp's own price once read). */
const costFor = (settings: VideoSettings) => takeCost(providerLimits(activeProviderId()), settings)

/** "@image_4" / "@image_4…6" this image would get in `scene` once linked; '' = no picture yet (no number). */
export function linkPreviewToken(project: Project, scene: Scene, asset: Asset): string {
  const tok = tokenForAsset(project, { ...scene, refs: [...scene.refs, asset.id] }, asset.id)
  if (!tok) return ''
  const n = Number(tok.slice('@image_'.length))
  return asset.imageIds.length > 1 && Number.isFinite(n) ? `${tok}…${n + asset.imageIds.length - 1}` : tok
}
/** The image fits in the scene's model limit (same rule as store addRefs). */
const fits = (project: Project, scene: Scene, assetId: string) => refImageCount(project, [...scene.refs, assetId]) <= MODELS[scene.settings.model].maxRefImages
/** Why the scene cannot run: the one rule list of every one-scene Run button, with the gateway's sure refusal of its settings. */
const runBlockOf = (s: Snap, scene: Scene) => sceneRunBlockReason(s.project.assets, scene, settingsRunBlock(providerLimits(activeProviderId()), scene.settings))

/** Node editor off (Settings): the prompt is typed in the right panel — opened, its prompt field focused. */
function editInPanel(sceneId: string) {
  const ui = useUI.getState()
  ui.select([sceneId])
  ui.setRightOpen(true)
  // The inspector draws the scene on the next render.
  setTimeout(() => (typeof document !== 'undefined' ? document.querySelector<HTMLTextAreaElement>('.in-pe-ta')?.focus() : undefined), 0)
}

// ---------------- entry ----------------
export function canvasMenu(target: CanvasTarget, ctx: CanvasMenuContext): MenuSpec | null {
  const s = snapshot()
  let spec: MenuSpec | null = null
  switch (target.kind) {
    case 'scene':
      spec = sceneMenu(s, target.id)
      break
    case 'take':
      spec = takeMenu(s, target.id, ctx)
      break
    case 'asset':
      spec = assetMenu(s, target.id, ctx)
      break
    case 'folder':
      spec = folderMenu(s, target.id)
      break
    case 'ref':
      spec = refMenu(s, target.assetId, target.sceneId, ctx)
      break
    case 'edges':
      spec = edgesMenu(s, target.ids, ctx)
      break
    case 'multi':
      spec = multiMenu(s, ctx)
      break
    case 'pane':
      spec = paneMenu(s, ctx)
      break
  }
  return spec && { ...spec, entries: tidyEntries(spec.entries) }
}

// ---------------- scene (3.6.1) ----------------
function sceneMenu(s: Snap, id: string): MenuSpec | null {
  const scene = s.scenes.get(id)
  if (!scene) return null
  const code = sceneCode(scene.order)
  const blocked = providerBlockedReason(activeProviderId())
  const runBlock = runBlockOf(s, scene)
  // Gateway blocked (login, top-up…): still clickable for that — requestRun says what to do — unless the scene itself cannot run.
  const run: MenuItem = blocked
    ? { type: 'item', id: 'scene.run', label: `Chạy ${code}`, icon: 'play', hint: blocked, action: 'scene.run', disabled: runBlock ?? undefined, run: () => requestRun([id]) }
    : {
        type: 'item',
        id: 'scene.run',
        label: `Chạy ${code} · ${priceOf(costFor(scene.settings))}`,
        icon: 'play',
        action: 'scene.run',
        disabled: runBlock ?? undefined,
        run: () => requestRun([id]),
      }
  const hasDone = s.takes.some((t) => t.status === 'completed')
  // What Enter does on the selected card (SceneNode): type in its prompt, caret at the end. Node editor off: Enter does
  // nothing there, so no key is shown and the prompt opens in the right panel.
  const editorOff = useCanvasPrefs.getState().nodeEditor === 'off'
  const promptEnd = () => useProject.getState().project.scenes.find((x) => x.id === id)?.prompt.length ?? null
  const entries: MenuEntry[] = [
    run,
    {
      type: 'item',
      id: 'scene.edit',
      label: 'Sửa prompt và cấu hình',
      icon: 'edit',
      fixedKey: editorOff ? undefined : 'Enter',
      run: () => (editorOff ? editInPanel(id) : typeOnNode(id, promptEnd())),
    },
    { type: 'item', id: 'scene.next', label: 'Thêm cảnh tiếp theo', icon: 'plus', action: 'scene.next', run: () => void nextScene() },
    { type: 'item', id: 'scene.duplicate', label: 'Nhân bản', icon: 'copy', action: 'selection.duplicate', run: () => duplicateSelection() },
    {
      type: 'item',
      id: 'scene.playFrom',
      label: 'Phát liền từ cảnh này',
      icon: 'film',
      disabled: hasDone ? undefined : 'Chưa có cảnh nào có video xong để phát liền',
      run: () => void openFilmPlayer(Math.max(0, scene.order - 1)),
    },
  ]
  const unlink = sceneUnlinkRows(s, scene)
  if (unlink.length) entries.push({ type: 'item', id: 'scene.unlink', label: 'Bỏ nối ảnh', icon: 'unlink', submenu: unlink })
  entries.push(SEP, { type: 'item', id: 'scene.delete', label: 'Xoá cảnh', danger: true, action: 'selection.delete', run: () => deleteSelection() })
  return { label: `Menu cảnh ${code}`, entries }
}

/** "Bỏ nối ảnh ▸": one row per image (in @image order) and frame, then "Bỏ nối tất cả (n)". */
function sceneUnlinkRows(s: Snap, scene: Scene): MenuEntry[] {
  const rows: MenuEntry[] = []
  for (const assetId of scene.refs) {
    const asset = s.assets.get(assetId)
    if (!asset) continue
    const tok = tokenForAsset(s.project, scene, assetId)
    const range = tok && asset.imageIds.length > 1 ? `${tok}…${Number(tok.slice(7)) + asset.imageIds.length - 1}` : tok
    const id = edgeId('ref', assetId, scene.id)
    rows.push({ type: 'item', id: `unlink:${id}`, label: `${asset.name || 'Ảnh'} · ${range || 'chưa có ảnh'}`, icon: 'unlink', edgeId: id, run: () => cutEdge(id) })
  }
  for (const which of ['first', 'last'] as const) {
    const assetId = which === 'first' ? scene.firstFrame : scene.lastFrame
    const asset = assetId ? s.assets.get(assetId) : undefined
    if (!assetId || !asset) continue
    const id = edgeId(which, assetId, scene.id)
    rows.push({ type: 'item', id: `unlink:${id}`, label: `${which === 'first' ? 'Khung đầu' : 'Khung cuối'} · ${asset.name || 'ảnh'}`, icon: 'unlink', edgeId: id, run: () => cutEdge(id) })
  }
  const n = rows.length
  const out = capRows(rows, 'ảnh')
  if (n >= 2) out.push(SEP, { type: 'item', id: 'scene.unlinkAll', label: `Bỏ nối tất cả (${n})`, icon: 'unlink', run: () => void unlinkAllFromScene(scene.id) })
  return out
}

// ---------------- several cards (3.6.2) ----------------
function multiMenu(s: Snap, ctx: CanvasMenuContext): MenuSpec {
  const S = selScenes(s)
  const A = selectedAssetIds()
  const folderIds = new Set((s.project.folders ?? []).map((f) => f.id))
  const T = s.selectedIds.filter((id) => s.takesById.get(id)?.status === 'completed')
  const takesSel = s.selectedIds.filter((id) => s.takesById.has(id))
  const assetsOnCanvas = s.selectedIds.filter((id) => s.assets.has(id))
  const folders = s.selectedIds.filter((id) => folderIds.has(id))
  const n = s.selectedIds.filter((id) => s.scenes.has(id) || s.assets.has(id) || s.takesById.has(id) || folderIds.has(id)).length
  const parts = countsText([
    [S.length, 'cảnh'],
    [assetsOnCanvas.length, 'ảnh'],
    [takesSel.length, 'video'],
    [folders.length, 'thư mục'],
  ])
  const entries: MenuEntry[] = []
  if (S.length) {
    const blocked = providerBlockedReason(activeProviderId())
    const priced = !blocked && S.length <= MAX_PRICED_SCENES
    const total = priced ? S.reduce((sum, id) => sum + costFor(s.scenes.get(id)!.settings), 0) : 0
    entries.push({
      type: 'item',
      id: 'multi.run',
      label: priced ? `Chạy ${S.length} cảnh · ≈${priceOf(total)}` : `Chạy ${S.length} cảnh…`,
      icon: 'play',
      hint: blocked ?? undefined,
      action: 'scene.run',
      run: () => requestRun(S),
    })
  }
  if (S.length && A.length) {
    const open = S.flatMap((sid) => A.filter((aid) => !s.scenes.get(sid)!.refs.includes(aid)).map((aid) => [sid, aid] as const))
    if (open.length) {
      const room = open.some(([sid, aid]) => fits(s.project, s.scenes.get(sid)!, aid))
      entries.push({
        type: 'item',
        id: 'multi.connect',
        label: `Nối ${A.length} ảnh vào ${S.length} cảnh`,
        icon: 'link',
        action: 'selection.connect',
        disabled: room ? undefined : 'Các cảnh còn lại đã đủ ảnh theo giới hạn của model',
        run: () => connectSelection(),
      })
    }
    const pairs = linkedPairs(A, S, s.project)
    if (pairs.refs.length + pairs.frames.length) {
      entries.push({ type: 'item', id: 'multi.unlink', label: `Bỏ nối ${A.length} ảnh khỏi ${pairs.sceneIds.length} cảnh`, icon: 'unlink', run: () => void unlinkSelection() })
    }
  }
  if (S.length) entries.push({ type: 'item', id: 'multi.duplicate', label: `Nhân bản ${S.length} cảnh`, icon: 'copy', action: 'selection.duplicate', run: () => duplicateSelection() })
  if (T.length) entries.push({ type: 'item', id: 'multi.save', label: `Lưu ${T.length} video vào thư mục`, icon: 'folder', submenu: saveRows(s, T, ctx) })
  // Delete: the same rule as the Delete key (videos selected with their own scene are spared).
  const plan = keyboardDeletePlan(s.selectedIds, new Set(s.scenes.keys()), new Map(s.takes.map((t) => [t.id, t.sceneId])))
  const delTakes = plan.takes
  const running = delTakes.filter((id) => {
    const st = s.takesById.get(id)?.status
    return st === 'queued' || st === 'processing'
  })
  const deleted = countsText([
    [S.length, 'cảnh'],
    [delTakes.length, 'video'],
    [folders.length, 'thư mục khỏi canvas'],
  ])
  const hide = assetsOnCanvas.length ? `${deleted ? 'ẩn' : 'Ẩn'} ${assetsOnCanvas.length} thẻ ảnh` : ''
  const label = [deleted && `Xoá ${deleted}`, hide].filter(Boolean).join(', ') + (delTakes.length ? '…' : '')
  if (deleted || hide) {
    entries.push(SEP, {
      type: 'item',
      id: 'multi.delete',
      label,
      danger: S.length > 0 || delTakes.length > 0,
      icon: 'trash',
      action: 'selection.delete',
      disabled: running.length ? RUNNING_DELETE_REASON : undefined,
      run: () => {
        // Deleting videos always asks (they cannot be undone): when deleteSelection would not ask (no finished
        // video among them), ask here first; then it deletes without asking again about them.
        if (delTakes.length) {
          const check = checkTakeDelete(delTakes, deleteFacts(useRuns.getState().takes), { confirm: true })
          if (!check.question && !window.confirm(DELETE_TAKE_ALWAYS(delTakes.length === 1 ? takeLabel(delTakes[0]) : `${delTakes.length} video`))) return
        }
        deleteSelection()
      },
    })
  }
  return { label: `Menu ${n} mục đang chọn`, title: `${n} mục đang chọn${parts ? ` · ${parts}` : ''}`, entries }
}

// ---------------- image card on the canvas (3.6.3) ----------------
/**
 * Quick unlink rows for an image against the selected scenes: "Bỏ nối {tên} khỏi {S}" / "… khỏi N cảnh đang chọn"
 * (first item: focused when the menu opens) and "Nối {tên} vào …" for the selected scenes not using it yet.
 * Shared by the canvas card and the library card (`prefix` = 'asset' | 'lib').
 */
export function selectionLinkRows(s: { project: Project; selected: string[] }, asset: Asset, prefix: string, at?: { x: number; y: number }): MenuItem[] {
  const scenes = new Map(s.project.scenes.map((sc) => [sc.id, sc]))
  const S = s.selected.filter((id) => scenes.has(id))
  const uses = (sc: Scene) => sc.refs.includes(asset.id) || sc.firstFrame === asset.id || sc.lastFrame === asset.id
  const L = S.filter((id) => uses(scenes.get(id)!))
  const R = S.filter((id) => !L.includes(id))
  const name = asset.name || 'ảnh'
  const rows: MenuItem[] = []
  if (L.length) {
    rows.push({
      type: 'item',
      id: `${prefix}.unlinkSelected`,
      label: L.length === 1 ? `Bỏ nối ${name} khỏi ${sceneCode(scenes.get(L[0])!.order)}` : `Bỏ nối ${name} khỏi ${L.length} cảnh đang chọn`,
      icon: 'unlink',
      edgeId: L.length === 1 ? linkedPairs([asset.id], L, s.project).edgeIds[0] : undefined,
      run: () => void unlinkAssetsFromScenes([asset.id], L, { at }),
    })
  }
  if (R.length) {
    const room = R.filter((id) => fits(s.project, scenes.get(id)!, asset.id))
    const first = scenes.get(R[0])!
    let label: string
    if (R.length === 1) {
      const tok = linkPreviewToken(s.project, first, asset)
      label = tok ? `Nối ${name} vào ${sceneCode(first.order)} → ${tok}` : `Nối ${name} vào ${sceneCode(first.order)} (chưa có ảnh nên chưa có số)`
    } else if (room.length && room.length < R.length) {
      label = `Nối ${name} vào ${room.length}/${R.length} cảnh (còn lại đã đủ ảnh)`
    } else {
      label = `Nối ${name} vào ${R.length} cảnh ${L.length ? 'còn lại' : 'đang chọn'}`
    }
    const spec = MODELS[first.settings.model]
    rows.push({
      type: 'item',
      id: `${prefix}.linkSelected`,
      label,
      icon: 'link',
      disabled: room.length ? undefined : `Vượt giới hạn ảnh của ${spec.name} (${refImageCount(s.project, first.refs)}/${spec.maxRefImages})`,
      run: () => linkAssets(room, [asset.id]),
    })
  }
  return rows
}

/** "Bỏ nối khỏi cảnh khác ▸": up to 10 scenes using the image (nearest to `near` first, listed by code) + "mọi cảnh". */
function otherScenesRows(s: Snap, asset: Asset, others: string[], all: string[], near: XY | null, at?: { x: number; y: number }): MenuEntry[] {
  const dist = (id: string) => {
    const p = s.scenes.get(id)!.position
    return near ? Math.hypot(p.x - near.x, p.y - near.y) : 0
  }
  const picked = [...others].sort((a, b) => dist(a) - dist(b)).slice(0, 10)
  picked.sort((a, b) => s.scenes.get(a)!.order - s.scenes.get(b)!.order)
  const rows: MenuEntry[] = picked.map((id) => {
    const sc = s.scenes.get(id)!
    const frame = sc.firstFrame === asset.id ? ' (khung đầu)' : sc.lastFrame === asset.id ? ' (khung cuối)' : ''
    const kind: EdgeKind = sc.refs.includes(asset.id) ? 'ref' : sc.firstFrame === asset.id ? 'first' : 'last'
    return {
      type: 'item',
      id: `unlinkFrom:${id}`,
      label: `${sceneCode(sc.order)}${sc.title ? ` · ${sc.title}` : ''}${frame}`,
      icon: 'scene',
      edgeId: edgeId(kind, asset.id, id),
      run: () => void unlinkAssetsFromScenes([asset.id], [id], { at }),
    }
  })
  if (others.length > picked.length) rows.push({ type: 'label', text: `+${others.length - picked.length} cảnh khác` })
  if (all.length >= 2) rows.push(SEP, { type: 'item', id: 'asset.unlinkAll', label: `Bỏ nối khỏi mọi cảnh (${all.length})`, icon: 'unlink', run: () => void unlinkAssetsFromScenes([asset.id], all, { at }) })
  return rows
}

function assetMenu(s: Snap, id: string, ctx: CanvasMenuContext): MenuSpec | null {
  const asset = s.assets.get(id)
  if (!asset) return null
  const name = asset.name || 'ảnh'
  const S = selScenes(s)
  const users = scenesUsingAsset(id, s.project)
  const others = users.filter((u) => !S.includes(u))
  const entries: MenuEntry[] = [...selectionLinkRows({ project: s.project, selected: s.selectedIds }, asset, 'asset', ctx.at)]
  if (others.length) {
    entries.push({
      type: 'item',
      id: 'asset.unlinkFrom',
      label: S.length ? 'Bỏ nối khỏi cảnh khác' : 'Bỏ nối khỏi cảnh',
      icon: 'unlink',
      submenu: otherScenesRows(s, asset, others, users, asset.position, ctx.at),
    })
  }
  entries.push(
    {
      type: 'item',
      id: 'asset.newScene',
      label: `Tạo cảnh mới có @${asset.tag}`,
      icon: 'scene',
      run: () => {
        const p = useProject.getState().project
        const near = asset.position ? { x: asset.position.x + (asset.size?.w ?? LAYOUT.assetW) + 80, y: asset.position.y } : ctx.flow
        const sceneId = useProject.getState().addScene({ refs: [id] }, { position: freeSpotFrom(p, { x: snap(near.x), y: snap(near.y) }) })
        useUI.getState().select([sceneId])
        const made = useProject.getState().project.scenes.find((sc) => sc.id === sceneId)
        toast(`Đã tạo ${made ? sceneCode(made.order) : 'cảnh mới'} với @${asset.tag}.`, { tone: 'success', action: undoToastAction() })
      },
    },
    { type: 'item', id: 'asset.edit', label: `Sửa ${name}…`, icon: 'edit', run: () => useUI.getState().openDialog({ kind: 'asset', assetId: id }) },
    SEP,
    {
      type: 'item',
      id: 'asset.hide',
      label: 'Ẩn khỏi canvas',
      icon: 'eyeOff',
      action: s.selectedIds.length === 1 && s.selectedIds[0] === id ? 'selection.delete' : undefined,
      run: () => void hideAssets([id]),
    },
  )
  const kind = { character: 'nhân vật', location: 'bối cảnh', prop: 'đạo cụ', style: 'phong cách' }[asset.kind] ?? 'ảnh'
  return {
    label: `Menu thẻ ảnh ${name}`,
    // With scenes selected the first item names the image already ("Bỏ nối Elara khỏi S03").
    title: S.length ? undefined : `${name} · ${kind} · dùng ở ${users.length} cảnh`,
    entries,
  }
}

// ---------------- thumbnail on a scene card (3.6.4) ----------------
function refMenu(s: Snap, assetId: string, sceneId: string, ctx: CanvasMenuContext): MenuSpec | null {
  const asset = s.assets.get(assetId)
  const scene = s.scenes.get(sceneId)
  if (!asset || !scene) return null
  const name = asset.name || 'ảnh'
  const code = sceneCode(scene.order)
  const id = edgeId('ref', assetId, sceneId)
  const entries: MenuEntry[] = [{ type: 'item', id: 'ref.unlink', label: `Bỏ nối ${name} khỏi ${code}`, icon: 'unlink', edgeId: id, run: () => cutEdge(id, false, ctx.at) }]
  // Quick unlink: the selected scenes (with this one) that use the image, then every scene using it.
  const users = scenesUsingAsset(assetId, s.project)
  const L = selScenes(s).filter((x) => users.includes(x))
  if (L.length >= 2) entries.push({ type: 'item', id: 'ref.unlinkSelected', label: `Bỏ nối ${name} khỏi ${L.length} cảnh đang chọn`, icon: 'unlink', run: () => void unlinkAssetsFromScenes([assetId], L, { at: ctx.at }) })
  if (users.length >= 2 && users.length !== L.length) {
    entries.push({ type: 'item', id: 'ref.unlinkAll', label: `Bỏ nối ${name} khỏi mọi cảnh (${users.length})`, icon: 'unlink', run: () => void unlinkAssetsFromScenes([assetId], users, { at: ctx.at }) })
  }
  entries.push({ type: 'item', id: 'ref.edit', label: `Sửa ${name}…`, icon: 'edit', run: () => useUI.getState().openDialog({ kind: 'asset', assetId }) })
  return { label: `Menu ảnh ${name} trên ${code}`, entries }
}

// ---------------- video (3.6.5) ----------------
/** "Lưu vào thư mục ▸": the 3 most recent folders (disabled where every video is saved already), then "Thư mục mới…". */
function saveRows(s: Snap, takeIds: string[], ctx: CanvasMenuContext): MenuEntry[] {
  const folders = (s.project.folders ?? []).slice(-MAX_FOLDER_ITEMS).reverse()
  const rows: MenuEntry[] = folders.map((f) => {
    const all = takeIds.every((t) => f.takes?.includes(t))
    return {
      type: 'item',
      id: `save:${f.id}`,
      label: `“${f.name}”`,
      icon: 'folder',
      disabled: all ? 'Đã lưu vào đây' : undefined,
      run: () => linkTakesToFolder(takeIds, f.id),
    }
  })
  rows.push(SEP, {
    type: 'item',
    id: 'save:new',
    label: 'Thư mục mới…',
    icon: 'folderPlus',
    // Picker needs the click's user gesture: started synchronously.
    run: () => void createFolderNode({ position: { x: snap(ctx.flow.x + 8), y: snap(ctx.flow.y - 24) }, takeIds }),
  })
  return rows
}

/** Ask, then delete one video for good (always asks: it cannot be undone). Returns whether it was deleted. */
export function deleteTakeAsking(takeId: string): boolean {
  const take = useRuns.getState().takes.find((t) => t.id === takeId)
  if (!take) return false
  const label = takeLabel(takeId)
  const question = checkTakeDelete([takeId], deleteFacts(useRuns.getState().takes), { confirm: true, label }).question ?? DELETE_TAKE_ALWAYS(label)
  if (!window.confirm(question)) return false
  return (deleteTakes([takeId], { confirm: false }) ?? 0) > 0
}

/**
 * "Huỷ" of a queued / running video: the label and hint only — the click runs actions.cancelTake, which asks exactly
 * what the queue row / TakeViewer "Huỷ" asks (creditText.cancelQuestion: a paid video still downloading), never more.
 * "Huỷ…" when that question will come; the hint says what cancelling means for the job (its toast says it again).
 */
export function cancelPlan(take: Take & { status: 'queued' | 'processing' }): { label: string; hint?: string } {
  const facts = cancelFactsOf(take, take.status)
  if (facts.demoPaid) return { label: `Huỷ · hoàn ${formatCredits(take.cost, 'demo')}` }
  const dev = facts.provider === 'dev'
  const site = dev ? 'canvasapp giả lập' : PROVIDER_LABEL[facts.provider]
  const credit = dev ? 'credit dev' : 'credit'
  if (cancelQuestion(facts)) return { label: 'Huỷ…', hint: `Video đã tạo xong (đã trừ ${credit}), đang tải về` }
  if (facts.provider === 'mock' || (take.status === 'queued' && !take.remoteId && !take.submitUnknown)) return { label: 'Huỷ', hint: 'Chưa gửi đi, không trừ credit' }
  if (take.remoteId && take.imported) return { label: 'Huỷ', hint: `Job tạo trên ${site} vẫn chạy ở đó` }
  if (take.remoteId) return { label: 'Huỷ', hint: `Job đã gửi sang ${site} vẫn chạy ở đó` }
  if (take.submitUnknown) return { label: 'Huỷ', hint: `Không rõ lần gửi trước đã trừ ${credit} chưa` }
  return { label: 'Huỷ', hint: `Đang gửi sang ${site}` }
}

function takeMenu(s: Snap, id: string, ctx: CanvasMenuContext): MenuSpec | null {
  const take = s.takesById.get(id)
  if (!take) return null
  const scene = s.scenes.get(take.sceneId)
  const label = takeLabel(id)
  const code = codeOf(s, take.sceneId)
  const view: MenuItem = {
    type: 'item',
    id: 'take.view',
    label: take.status === 'failed' ? 'Xem lỗi' : 'Xem',
    icon: 'eye',
    run: () => useUI.getState().openDialog({ kind: 'take', takeId: id }),
  }
  const del: MenuItem = { type: 'item', id: 'take.delete', label: 'Xoá video…', hint: 'Không hoàn tác được', danger: true, action: 'selection.delete', run: () => void deleteTakeAsking(id) }
  const meta = [label, take.settings?.duration ? `${take.settings.duration}s` : '', take.settings?.resolution ?? ''].filter(Boolean).join(' · ')
  if (isParkedTake(take)) {
    return { label: `Menu video ${label}`, title: `${label} · đang chạy ở bản SanoVids mới hơn`, entries: [view, SEP, del] }
  }
  if (take.status === 'queued' || take.status === 'processing') {
    const plan = cancelPlan({ ...take, status: take.status })
    const cancel: MenuItem = { type: 'item', id: 'take.cancel', label: plan.label, icon: 'x', hint: plan.hint, run: () => void cancelTake(id) }
    return { label: `Menu video ${label}`, title: meta, entries: [view, cancel] }
  }
  const blocked = providerBlockedReason(activeProviderId())
  const uncertain = isUncertainSubmit(take)
  const runBlock = scene ? runBlockOf(s, scene) : 'Cảnh gốc đã bị xoá'
  const rerun: MenuItem = uncertain
    ? { type: 'item', id: 'take.rerun', label: `Gửi lại ${label}…`, icon: 'rerun', run: () => rerunTake(id) }
    : {
        type: 'item',
        id: 'take.rerun',
        label: blocked || !scene ? `Chạy lại ${code}` : `Chạy lại ${code} · ${priceOf(costFor(scene.settings))}`,
        icon: 'rerun',
        hint: blocked ?? undefined,
        disabled: runBlock ?? undefined,
        run: () => rerunTake(id),
      }
  if (take.status !== 'completed') {
    return { label: `Menu video ${label}`, title: meta, entries: [view, rerun, SEP, del] }
  }
  const folders = s.project.folders ?? []
  const save: MenuItem = folders.length
    ? { type: 'item', id: 'take.save', label: 'Lưu vào thư mục', icon: 'folder', submenu: saveRows(s, [id], ctx) }
    : {
        type: 'item',
        id: 'take.save',
        label: 'Lưu vào thư mục mới…',
        icon: 'folderPlus',
        run: () => void createFolderNode({ position: { x: snap(ctx.flow.x + 8), y: snap(ctx.flow.y - 24) }, takeIds: [id] }),
      }
  const askWhere = useDownloadPrefs.getState().askWhere
  return {
    label: `Menu video ${label}`,
    title: meta,
    entries: [
      view,
      { type: 'item', id: 'take.star', label: `Chọn take này cho ${code}`, icon: 'star', checked: !!take.starred, run: () => useRuns.getState().toggleStar(id) },
      { type: 'item', id: 'take.nextScene', label: 'Tạo cảnh tiếp theo từ video này', icon: 'scene', run: () => void createSceneFromVideo(id) },
      { type: 'item', id: 'take.download', label: askWhere ? 'Tải video…' : 'Tải video', icon: 'download', run: () => void downloadTakeOnce(id) },
      save,
      rerun,
      SEP,
      del,
    ],
  }
}

// ---------------- folder (3.6.6) ----------------
function folderMenu(s: Snap, id: string): MenuSpec | null {
  const folder = (s.project.folders ?? []).find((f) => f.id === id)
  if (!folder) return null
  const rt = folderRuntime(id)
  const desktop = !!desktopFiles()
  const needsPick = rt.access === 'pick' || rt.access === 'missing'
  const needsGrant = rt.access === 'ask'
  const entries: MenuEntry[] = []
  if (needsGrant) entries.push({ type: 'item', id: 'folder.primary', label: 'Cấp lại quyền', icon: 'key', run: () => void grantFolderAccess(id) })
  else if (needsPick) entries.push({ type: 'item', id: 'folder.primary', label: 'Chọn lại thư mục…', icon: 'folderSearch', run: () => void chooseFolderPlace(id) })
  else if (desktop) {
    entries.push({
      type: 'item',
      id: 'folder.primary',
      label: 'Mở thư mục',
      icon: 'folderOpen',
      disabled: rt.access === 'ok' ? undefined : rt.access === 'checking' ? 'Đang kiểm tra thư mục…' : 'Chưa ghi được vào thư mục này',
      run: () => void openFolderNode(id),
    })
  }
  if (!needsPick && rt.access !== 'unsupported') entries.push({ type: 'item', id: 'folder.change', label: 'Đổi thư mục…', icon: 'folderSearch', run: () => void chooseFolderPlace(id) })
  const T = s.selectedIds.filter((x) => s.takesById.get(x)?.status === 'completed' && !folder.takes?.includes(x))
  if (T.length) entries.push({ type: 'item', id: 'folder.saveSelected', label: `Lưu ${T.length} video đang chọn vào đây`, icon: 'download', run: () => linkTakesToFolder(T, id) })
  const S = selScenes(s).filter((x) => !folder.autoScenes?.includes(x))
  if (S.length) entries.push({ type: 'item', id: 'folder.autosaveSelected', label: `Tự lưu ${S.length} cảnh đang chọn vào đây`, icon: 'folder', run: () => linkScenesToFolder(S, id) })
  entries.push(SEP, { type: 'item', id: 'folder.remove', label: 'Xoá thư mục khỏi canvas (file vẫn còn)', icon: 'eyeOff', run: () => removeFolderNode(id) })
  return { label: `Menu thư mục ${folder.name}`, title: `Thư mục “${folder.name}”`, entries }
}

// ---------------- wires (3.6.7) ----------------
/** Cuttable wires under the pointer, top → bottom: no 'out' wires, no duplicates, unknown ids dropped. */
export function wireStack(ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const e = parseEdgeId(id)
    if (!e || e.kind === 'out' || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** "Elara → S03", "khung đầu Elara → S03", "S03·T2 → “Phim”", "S03 → “Phim”". */
export function wireLabel(id: string, project: Project = useProject.getState().project): string {
  const e = parseEdgeId(id)
  if (!e) return 'dây'
  const scene = (sid: string) => {
    const sc = project.scenes.find((x) => x.id === sid)
    return sc ? sceneCode(sc.order) : 'cảnh'
  }
  const asset = (aid: string) => project.assets.find((a) => a.id === aid)?.name || 'ảnh'
  const folder = (fid: string) => `“${(project.folders ?? []).find((f) => f.id === fid)?.name ?? 'Thư mục'}”`
  switch (e.kind) {
    case 'ref':
      return `${asset(e.from)} → ${scene(e.to)}`
    case 'first':
      return `khung đầu ${asset(e.from)} → ${scene(e.to)}`
    case 'last':
      return `khung cuối ${asset(e.from)} → ${scene(e.to)}`
    case 'save':
      return `${takeLabel(e.from)} → ${folder(e.to)}`
    case 'autosave':
      return `${scene(e.from)} → ${folder(e.to)}`
    default:
      return 'dây'
  }
}

/** One wire's cut row: wording and danger follow the folder trash rule of cutEdge (files to the Recycle Bin). */
function cutRow(id: string, project: Project, at?: { x: number; y: number }): MenuItem {
  const e = parseEdgeId(id)!
  const text = wireLabel(id, project)
  const run = () => cutEdge(id, false, at)
  if (e.kind === 'save') {
    const trash = useDownloadPrefs.getState().folderUnlinkTrash && canTrashSaved()
    return { type: 'item', id: `cut:${id}`, label: `Bỏ lưu ${text}`, hint: trash ? 'Chuyển file đã lưu vào Thùng rác' : 'File đã lưu vẫn còn', danger: trash, icon: 'unlink', edgeId: id, run }
  }
  if (e.kind === 'autosave') return { type: 'item', id: `cut:${id}`, label: `Bỏ tự lưu ${text}`, hint: 'Video đã lưu vẫn còn', icon: 'unlink', edgeId: id, run }
  return { type: 'item', id: `cut:${id}`, label: `Bỏ nối ${text}`, icon: 'unlink', edgeId: id, run }
}

function edgesMenu(s: Snap, rawIds: string[], ctx: CanvasMenuContext): MenuSpec | null {
  const ids = wireStack(rawIds)
  if (!ids.length) return paneMenu(s, ctx)
  if (ids.length === 1) {
    const id = ids[0]
    const e = parseEdgeId(id)!
    const entries: MenuEntry[] = []
    const selectedWires = s.selectedEdgeIds
    if (selectedWires.length >= 2 && selectedWires.includes(id) && !s.selectedIds.length) {
      entries.push({ type: 'item', id: 'edge.cutSelected', label: `Bỏ nối ${selectedWires.length} dây đang chọn`, icon: 'unlink', action: 'selection.delete', run: () => deleteSelection() })
    }
    const cut = cutRow(id, s.project, ctx.at)
    cut.id = 'edge.cut'
    const go = (nodeId: string) => () => {
      useUI.getState().select([nodeId])
      focusNodes([nodeId])
    }
    const folderName = (fid: string) => (s.project.folders ?? []).find((f) => f.id === fid)?.name ?? 'Thư mục'
    const toLabel = isFolderEdge(e.kind) ? `Đi tới thư mục “${folderName(e.to)}”` : `Đi tới ${codeOf(s, e.to)}`
    const fromLabel =
      e.kind === 'save' ? `Đi tới ${takeLabel(e.from)}` : e.kind === 'autosave' ? `Đi tới ${codeOf(s, e.from)}` : `Đi tới ${s.assets.get(e.from)?.name || 'ảnh'}`
    const goRows: MenuEntry[] = [
      { type: 'item', id: 'edge.goScene', label: toLabel, icon: 'goto', edgeId: id, run: go(e.to) },
      { type: 'item', id: 'edge.goSource', label: fromLabel, icon: 'goto', edgeId: id, run: go(e.from) },
    ]
    // A cut that moves files to the Recycle Bin is a danger item: last, after a separator.
    if (cut.danger) entries.push(...goRows, SEP, cut)
    else entries.push(cut, ...goRows)
    return { label: `Menu dây ${wireLabel(id, s.project)}`, entries }
  }
  const links = ids.filter((id) => !isFolderEdge(parseEdgeId(id)!.kind)).map((id) => cutRow(id, s.project, ctx.at))
  const saves = ids
    .filter((id) => isFolderEdge(parseEdgeId(id)!.kind))
    .map((id) => cutRow(id, s.project, ctx.at))
    .sort((a, b) => Number(!!a.danger) - Number(!!b.danger))
  const entries: MenuEntry[] = [...links]
  if (saves.length) entries.push(SEP, ...saves)
  // Every wire is listed (a long list scrolls: .cm-menu overflow + placeMenu maxHeight) — none silently out of reach.
  return { label: `Menu ${ids.length} dây ở chỗ này`, title: `${ids.length} dây ở chỗ này`, entries }
}

// ---------------- empty canvas (3.6.8) ----------------
function paneMenu(s: Snap, ctx: CanvasMenuContext): MenuSpec {
  const p = ctx.flow
  const n = s.selectedIds.length
  return {
    label: 'Menu nền canvas',
    entries: [
      {
        type: 'item',
        id: 'pane.newScene',
        label: 'Cảnh mới tại đây',
        icon: 'plus',
        // Same as a double-click on the canvas (CanvasView.onDoubleClick): the scene is ready to type in.
        run: () => useSceneEditor.getState().open(newScene({ x: snap(p.x - LAYOUT.sceneW / 2), y: snap(p.y - 40) }), 'prompt', 0),
      },
      {
        type: 'item',
        id: 'pane.newFolder',
        label: 'Thư mục mới tại đây…',
        icon: 'folderPlus',
        run: () => void createFolderNode({ position: { x: snap(p.x + 8), y: snap(p.y - 24) } }),
      },
      { type: 'item', id: 'pane.addImages', label: 'Thêm ảnh tại đây…', icon: 'image', run: () => pickImagesAt({ x: snap(p.x - LAYOUT.assetW / 2), y: snap(p.y - 100) }) },
      SEP,
      n
        ? { type: 'item', id: 'pane.fit', label: `Phóng tới ${n} mục đang chọn`, icon: 'fit', action: 'canvas.fit', run: () => fitNodes([...s.selectedIds]) }
        : { type: 'item', id: 'pane.fit', label: 'Vừa màn hình', icon: 'fit', action: 'canvas.fit', run: () => fitNodes([]) },
    ],
  }
}


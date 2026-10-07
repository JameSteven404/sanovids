// Floating toolbar (bottom-center of the canvas) + selection hint (top-left).
import { useReactFlow, useStore } from '@xyflow/react'
import { Film, FolderPlus, Hand, Link2, Map as MapIcon, Maximize, Minus, MousePointer2, Play, Plus, Spline } from 'lucide-react'
import { useMemo, type WheelEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { canvasEvents, connectSelection, nextScene, requestRun, selectedSceneIds, pickAssetSelection } from '../../actions'
import type { EdgeMode } from '../../core/types'
import { createFolderNode } from '../../folderActions'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI, type TakeDisplay } from '../../store/ui'
import {
  assetMapOf,
  assetGraphOf,
  sceneGraphOf,
  countScenes,
  FIT_EVENT,
  KIND_LABEL,
  sceneMapOf,
  takeIndexOf,
  type ToolbarDensity,
} from './canvasModel'
import './canvas.css'
import { ArrangeButton } from './ArrangePopover'

const EDGE_MODES: { id: EdgeMode; label: string; title: string }[] = [
  { id: 'hidden', label: 'Ẩn', title: 'Chỉ hiện dây của thẻ đang trỏ chuột' },
  { id: 'selected', label: 'Đang chọn', title: 'Hiện dây của thẻ đang chọn / đang trỏ' },
  { id: 'all', label: 'Tất cả', title: 'Hiện mọi dây nối' },
]

const TAKE_DISPLAYS: { id: TakeDisplay; label: string; short: string; title: string }[] = [
  { id: 'all', label: 'Tất cả', short: 'Tất cả', title: 'Hiện mọi take (video) của mỗi cảnh' },
  {
    id: 'chosen',
    label: 'Chỉ take chọn',
    short: 'Take chọn',
    title: 'Mỗi cảnh chỉ hiện take được chọn (★, nếu không thì take xong mới nhất)',
  },
]

export { autoLayoutCanvas } from '../../arrangeActions'

/** Ask the canvas to fit these nodes (all when empty), regardless of whether they are already visible. */
export function fitCanvas(ids: string[] = []) {
  canvasEvents.dispatchEvent(new CustomEvent(FIT_EVENT, { detail: ids }))
}

/** Toolbar glyphs (DESIGN.md: lucide 16px, stroke 1.75). */
const ICON = { size: 16, strokeWidth: 1.75 } as const
const SMALL_ICON = { size: 15, strokeWidth: 1.75 } as const

/** A vertical wheel over the toolbar scrolls it sideways (it only overflows on a very narrow canvas). */
function wheelScroll(e: WheelEvent<HTMLDivElement>) {
  const el = e.currentTarget
  if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
}

/**
 * `density` follows the canvas width (CanvasView): 'full' shows every label; 'compact' keeps icons for Nối / Chạy and
 * turns the wire / video switches into one-button toggles; 'tight' also drops the zoom −/+ (wheel zooms anyway).
 */
export function CanvasToolbar({ density = 'full', big = false }: { density?: ToolbarDensity; big?: boolean }) {
  const rf = useReactFlow()
  const zoom = useStore((s) => Math.round(s.transform[2] * 100))
  const interaction = useUI((s) => s.interaction)
  const edgeMode = useUI((s) => s.edgeMode)
  const minimapHidden = useUI((s) => !!s.minimapAutoHiddenFor && !s.minimapShownFor.includes(s.minimapAutoHiddenFor))
  const showMinimap = useUI((s) => s.showMinimap) && !minimapHidden
  const takeDisplay = useUI((s) => s.takeDisplay)
  const sceneCount = useUI((s) => countScenes(s.selectedIds))
  const ui = useUI.getState()
  const full = density === 'full'
  const tight = density === 'tight'
  const edge = EDGE_MODES.find((m) => m.id === edgeMode) ?? EDGE_MODES[0]
  const display = TAKE_DISPLAYS.find((m) => m.id === takeDisplay) ?? TAKE_DISPLAYS[0]
  const otherDisplay = TAKE_DISPLAYS.find((m) => m.id !== takeDisplay) ?? TAKE_DISPLAYS[0]
  const edgeTitle = (m: typeof edge) => big && m.id === 'all' ? 'Tất cả dây (dự án lớn: chỉ vẽ dây gần vùng đang xem)' : m.title

  return (
    <div className={`cv-toolbar material nodrag nopan is-${density}`} role="toolbar" aria-label="Công cụ canvas" onWheel={wheelScroll}>
      <button
        className="cv-tb-btn primary"
        onClick={() => nextScene()}
        title={sceneCount ? 'Tạo cảnh tiếp theo sau cảnh đang chọn (N)' : 'Cảnh mới (N)'}
        aria-label="Cảnh mới"
      >
        <Plus {...ICON} />
        {!tight && <span>Cảnh</span>}
      </button>
      <button
        className="cv-tb-btn"
        onClick={() => void createFolderNode()}
        title="Thư mục: chọn một thư mục trên máy, rồi kéo dây từ video (hoặc từ cảnh) vào đó để lưu video vào thư mục"
        aria-label="Thêm thư mục lưu video"
      >
        <FolderPlus {...ICON} />
        {full && <span>Thư mục</span>}
      </button>
      <button className="cv-tb-btn" onClick={() => connectSelection()} title="Nối mọi nhân vật / video đang chọn vào mọi cảnh đang chọn (C)" aria-label="Nối">
        <Link2 {...ICON} />
        {full && <span>Nối</span>}
        {full && <span className="kbd">C</span>}
      </button>
      <button
        className="cv-tb-btn run"
        onClick={() => requestRun(selectedSceneIds())}
        disabled={!sceneCount}
        title="Chạy các cảnh đang chọn (Ctrl+Enter)"
        aria-label="Chạy các cảnh đang chọn"
      >
        <Play size={13} strokeWidth={2} fill="currentColor" />
        {full && <span>Chạy</span>}
        {sceneCount > 0 && <span className="cv-tb-count">{sceneCount}</span>}
      </button>

      <span className="cv-tb-sep" aria-hidden />

      <ArrangeButton />
      <button className="cv-tb-icon" onClick={() => fitCanvas(useUI.getState().selectedIds)} title="Vừa màn hình (F)" aria-label="Vừa màn hình">
        <Maximize {...ICON} />
      </button>

      <span className="cv-tb-sep" aria-hidden />

      <div className="cv-seg" role="group" aria-label="Chế độ chuột">
        <button
          className={interaction === 'hand' ? 'on' : ''}
          aria-pressed={interaction === 'hand'}
          aria-label="Tay"
          onClick={() => ui.setInteraction('hand')}
          title="Tay: kéo nền để di chuyển, Shift+kéo để chọn vùng (H)"
        >
          <Hand {...SMALL_ICON} />
        </button>
        <button
          className={interaction === 'select' ? 'on' : ''}
          aria-pressed={interaction === 'select'}
          aria-label="Chọn"
          onClick={() => ui.setInteraction('select')}
          title="Chọn: kéo để chọn vùng, giữ Space hoặc chuột giữa để di chuyển (V)"
        >
          <MousePointer2 {...SMALL_ICON} />
        </button>
      </div>

      {full ? (
        <div className="cv-seg text" role="group" aria-label="Hiển thị dây nối (E)">
          {EDGE_MODES.map((m) => (
            <button
              key={m.id}
              className={edgeMode === m.id ? 'on' : ''}
              aria-pressed={edgeMode === m.id}
              onClick={() => ui.setEdgeMode(m.id)}
              title={`${edgeTitle(m)} (E để đổi)`}
            >
              {m.label}
            </button>
          ))}
        </div>
      ) : (
        <button
          className="cv-tb-btn cv-tb-toggle"
          onClick={() => ui.cycleEdgeMode()}
          title={`Dây nối: ${edge.label} — ${edgeTitle(edge)}. Bấm để đổi (E)`}
          aria-label={`Hiển thị dây nối: ${edge.label}`}
        >
          <Spline {...SMALL_ICON} />
          <span>{edge.label}</span>
        </button>
      )}

      {full ? (
        <div className="cv-seg text" role="group" aria-label="Hiển thị video (take)">
          <span className="cv-seg-label">Video</span>
          {TAKE_DISPLAYS.map((m) => (
            <button key={m.id} className={takeDisplay === m.id ? 'on' : ''} aria-pressed={takeDisplay === m.id} onClick={() => ui.setTakeDisplay(m.id)} title={m.title}>
              {m.label}
            </button>
          ))}
        </div>
      ) : (
        <button
          className="cv-tb-btn cv-tb-toggle"
          onClick={() => ui.setTakeDisplay(otherDisplay.id)}
          title={`Video: ${display.label} — ${display.title}. Bấm để chuyển sang “${otherDisplay.label}”`}
          aria-label={`Hiển thị video: ${display.label}`}
        >
          <Film {...SMALL_ICON} />
          <span>{display.short}</span>
        </button>
      )}

      <button
        className={`cv-tb-icon ${showMinimap ? 'on' : ''}`}
        onClick={() => ui.toggleMinimap()}
        title={minimapHidden ? 'Bản đồ thu nhỏ đang tạm ẩn vì dự án lớn — bấm để hiện (M)' : 'Bản đồ thu nhỏ (M)'}
        aria-label="Bản đồ thu nhỏ"
        aria-pressed={showMinimap}
      >
        <MapIcon {...ICON} />
      </button>

      <span className="cv-tb-sep" aria-hidden />

      <div className="cv-zoom">
        {!tight && (
          <button className="cv-tb-icon" onClick={() => void rf.zoomOut({ duration: 150 })} title="Thu nhỏ" aria-label="Thu nhỏ">
            <Minus {...SMALL_ICON} />
          </button>
        )}
        <button className="cv-zoom-val" onClick={() => void rf.zoomTo(1, { duration: 200 })} title="Về 100% (lăn chuột để thu phóng)" aria-label={`Thu phóng ${zoom}% — bấm để về 100%`}>
          {zoom}%
        </button>
        {!tight && (
          <button className="cv-tb-icon" onClick={() => void rf.zoomIn({ duration: 150 })} title="Phóng to" aria-label="Phóng to">
            <Plus {...SMALL_ICON} />
          </button>
        )}
      </div>
    </div>
  )
}

/** "3 nhân vật · 2 video · 12 cảnh đang chọn — bấm C để nối" when the selection mixes references and scenes. */
export function SelectionHint() {
  const [selectedIds, librarySelection] = useUI(useShallow((s) => [s.selectedIds, s.librarySelection] as const))
  const sceneSig = useProject((s) => sceneGraphOf(s.project.scenes))
  const assetSig = useProject((s) => assetGraphOf(s.project.assets))
  const scenes = useMemo(() => useProject.getState().project.scenes, [sceneSig])
  const assets = useMemo(() => useProject.getState().project.assets, [assetSig])
  const takeN = useRuns((s) => {
    if (!selectedIds.length) return 0
    const byId = takeIndexOf(s.takes).byId
    let n = 0
    for (const id of selectedIds) if (byId.get(id)?.status === 'completed') n++
    return n
  })
  // Any video node selected: the library selection is not used (same rule as actions.selectedAssetIds).
  const anyTake = useRuns((s) => selectedIds.length > 0 && selectedIds.some((id) => takeIndexOf(s.takes).byId.has(id)))
  const text = useMemo(() => {
    const sm = sceneMapOf(scenes)
    const am = assetMapOf(assets)
    const sceneN = selectedIds.filter((id) => sm.has(id)).length
    // Same rule as actions.selectedAssetIds: canvas selection wins over the library selection.
    const assetIds = pickAssetSelection(selectedIds, anyTake ? [] : librarySelection, new Set(am.keys()))
    if (!sceneN || (!assetIds.length && !takeN)) return null
    const parts: string[] = []
    if (assetIds.length) {
      const kinds = new Set(assetIds.map((id) => am.get(id)!.kind))
      parts.push(`${assetIds.length} ${kinds.size === 1 ? (KIND_LABEL[[...kinds][0]] ?? 'tham chiếu') : 'tham chiếu'}`)
    }
    if (takeN) parts.push(`${takeN} video`)
    parts.push(`${sceneN} cảnh đang chọn`)
    return parts.join(' · ')
  }, [selectedIds, librarySelection, scenes, assets, takeN, anyTake])
  if (!text) return null
  return (
    <div className="cv-sel-hint material" role="status">
      <Link2 size={15} strokeWidth={1.75} />
      <span>{text}</span>
      <span className="faint">— bấm</span>
      <button className="cv-sel-hint-btn" onClick={() => connectSelection()} title="Nối tất cả (C)">
        <span className="kbd">C</span> để nối
      </button>
    </div>
  )
}

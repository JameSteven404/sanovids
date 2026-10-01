// Floating toolbar (bottom-center of the canvas) + selection hint (top-left).
import { useReactFlow, useStore } from '@xyflow/react'
import { Hand, LayoutGrid, Link2, Map as MapIcon, Maximize, Minus, MousePointer2, Play, Plus } from 'lucide-react'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { canvasEvents, connectSelection, nextScene, requestRun, selectedSceneIds } from '../../actions'
import type { EdgeMode } from '../../core/types'
import { useProject } from '../../store/project'
import { useUI } from '../../store/ui'
import { assetMapOf, countScenes, FIT_EVENT, KIND_LABEL, sceneMapOf } from './canvasModel'
import './canvas.css'

const EDGE_MODES: { id: EdgeMode; label: string; title: string }[] = [
  { id: 'hidden', label: 'Ẩn', title: 'Chỉ hiện dây của thẻ đang trỏ chuột' },
  { id: 'selected', label: 'Đang chọn', title: 'Hiện dây của thẻ đang chọn / đang trỏ' },
  { id: 'all', label: 'Tất cả', title: 'Hiện mọi dây nối' },
]

/** Ask the canvas to fit these nodes (all when empty), regardless of whether they are already visible. */
export function fitCanvas(ids: string[] = []) {
  canvasEvents.dispatchEvent(new CustomEvent(FIT_EVENT, { detail: ids }))
}

export function CanvasToolbar() {
  const rf = useReactFlow()
  const zoom = useStore((s) => Math.round(s.transform[2] * 100))
  const interaction = useUI((s) => s.interaction)
  const edgeMode = useUI((s) => s.edgeMode)
  const showMinimap = useUI((s) => s.showMinimap)
  const sceneCount = useUI((s) => countScenes(s.selectedIds))
  const ui = useUI.getState()

  return (
    <div className="cv-toolbar nodrag nopan" role="toolbar" aria-label="Công cụ canvas">
      <button className="cv-tb-btn primary" onClick={() => nextScene()} title={sceneCount ? 'Tạo cảnh tiếp theo sau cảnh đang chọn (N)' : 'Cảnh mới (N)'}>
        <Plus size={15} />
        <span>Cảnh</span>
      </button>
      <button className="cv-tb-btn" onClick={() => connectSelection()} title="Nối mọi nhân vật đang chọn vào mọi cảnh đang chọn (C)">
        <Link2 size={15} />
        <span>Nối</span>
        <span className="kbd">C</span>
      </button>
      <button className="cv-tb-btn run" onClick={() => requestRun(selectedSceneIds())} disabled={!sceneCount} title="Chạy các cảnh đang chọn (Ctrl+Enter)">
        <Play size={13} fill="currentColor" />
        <span>Chạy</span>
        {sceneCount > 0 && <span className="cv-tb-count">{sceneCount}</span>}
      </button>

      <span className="cv-tb-sep" />

      <button
        className="cv-tb-icon"
        onClick={() => {
          useProject.getState().autoLayout()
          setTimeout(() => fitCanvas(), 60)
        }}
        title="Sắp xếp lại theo thứ tự cảnh"
        aria-label="Sắp xếp"
      >
        <LayoutGrid size={15} />
      </button>
      <button className="cv-tb-icon" onClick={() => fitCanvas(useUI.getState().selectedIds)} title="Vừa màn hình (F)" aria-label="Vừa màn hình">
        <Maximize size={15} />
      </button>

      <span className="cv-tb-sep" />

      <div className="cv-seg" role="group" aria-label="Chế độ chuột">
        <button className={interaction === 'hand' ? 'on' : ''} onClick={() => ui.setInteraction('hand')} title="Tay: kéo nền để di chuyển, Shift+kéo để chọn vùng (H)">
          <Hand size={14} />
        </button>
        <button className={interaction === 'select' ? 'on' : ''} onClick={() => ui.setInteraction('select')} title="Chọn: kéo để chọn vùng, giữ Space hoặc chuột giữa để di chuyển (V)">
          <MousePointer2 size={14} />
        </button>
      </div>

      <div className="cv-seg text" role="group" aria-label="Hiển thị dây nối (E)">
        {EDGE_MODES.map((m) => (
          <button key={m.id} className={edgeMode === m.id ? 'on' : ''} onClick={() => ui.setEdgeMode(m.id)} title={`${m.title} (E để đổi)`}>
            {m.label}
          </button>
        ))}
      </div>

      <button className={`cv-tb-icon ${showMinimap ? 'on' : ''}`} onClick={() => ui.toggleMinimap()} title="Bản đồ thu nhỏ (M)" aria-label="Bản đồ thu nhỏ">
        <MapIcon size={15} />
      </button>

      <span className="cv-tb-sep" />

      <div className="cv-zoom">
        <button className="cv-tb-icon" onClick={() => void rf.zoomOut({ duration: 150 })} title="Thu nhỏ" aria-label="Thu nhỏ">
          <Minus size={14} />
        </button>
        <button className="cv-zoom-val" onClick={() => void rf.zoomTo(1, { duration: 200 })} title="Về 100%">
          {zoom}%
        </button>
        <button className="cv-tb-icon" onClick={() => void rf.zoomIn({ duration: 150 })} title="Phóng to" aria-label="Phóng to">
          <Plus size={14} />
        </button>
      </div>
    </div>
  )
}

/** "3 nhân vật · 12 cảnh đang chọn — bấm C để nối" when the selection mixes assets and scenes. */
export function SelectionHint() {
  const [selectedIds, librarySelection] = useUI(useShallow((s) => [s.selectedIds, s.librarySelection] as const))
  const scenes = useProject((s) => s.project.scenes)
  const assets = useProject((s) => s.project.assets)
  const text = useMemo(() => {
    const sm = sceneMapOf(scenes)
    const am = assetMapOf(assets)
    const sceneN = selectedIds.filter((id) => sm.has(id)).length
    const assetIds = [...new Set([...selectedIds, ...librarySelection])].filter((id) => am.has(id))
    if (!sceneN || !assetIds.length) return null
    const kinds = new Set(assetIds.map((id) => am.get(id)!.kind))
    const kindLabel = kinds.size === 1 ? KIND_LABEL[[...kinds][0]] : 'tham chiếu'
    return `${assetIds.length} ${kindLabel} · ${sceneN} cảnh đang chọn`
  }, [selectedIds, librarySelection, scenes, assets])
  if (!text) return null
  return (
    <div className="cv-sel-hint">
      <Link2 size={14} />
      <span>{text}</span>
      <span className="faint">— bấm</span>
      <button className="cv-sel-hint-btn" onClick={() => connectSelection()} title="Nối tất cả (C)">
        <span className="kbd">C</span> để nối
      </button>
    </div>
  )
}

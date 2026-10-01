// Right panel. Switches on the selection:
// 1 scene → SceneInspector · ≥2 scenes → MultiSceneInspector · else 1 asset (canvas or library) → AssetInspector
// · several assets → short summary · nothing → tips.
import { FileText, Keyboard, Link2, MousePointerClick, Plus, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { newScene } from '../../actions'
import type { Project } from '../../core/types'
import { useProject } from '../../store/project'
import { useUI } from '../../store/ui'
import { AssetChip } from '../common/Media'
import { useFileDropGuard } from '../sidebar/shared'
import { AssetInspector } from './AssetInspector'
import './inspector.css'
import { MultiSceneInspector } from './MultiSceneInspector'
import { SceneInspector } from './SceneInspector'
import { EMPTY_IDS } from './shared'

function pickScenes(p: Project, selected: string[]): string[] {
  if (!selected.length) return EMPTY_IDS
  const ids = new Set(p.scenes.map((s) => s.id))
  return selected.filter((id) => ids.has(id))
}
function pickAssets(p: Project, selected: string[], library: string[]): string[] {
  if (!selected.length && !library.length) return EMPTY_IDS
  const ids = new Set(p.assets.map((a) => a.id))
  const onCanvas = selected.filter((id) => ids.has(id))
  return onCanvas.length ? onCanvas : library.filter((id) => ids.has(id))
}

export function Inspector() {
  const selectedIds = useUI((s) => s.selectedIds)
  const librarySelection = useUI((s) => s.librarySelection)
  const sceneIds = useProject(useShallow((s) => pickScenes(s.project, selectedIds)))
  const assetIds = useProject(useShallow((s) => pickAssets(s.project, selectedIds, librarySelection)))
  useFileDropGuard()

  let content
  if (sceneIds.length === 1) content = <SceneInspector key={sceneIds[0]} sceneId={sceneIds[0]} />
  else if (sceneIds.length > 1) content = <MultiSceneInspector sceneIds={sceneIds} />
  else if (assetIds.length === 1) content = <AssetInspector key={assetIds[0]} assetId={assetIds[0]} />
  else if (assetIds.length > 1) content = <MultiAssetSummary assetIds={assetIds} />
  else content = <EmptyInspector />

  return (
    <div className="in-root" aria-label="Thuộc tính">
      {content}
    </div>
  )
}

function MultiAssetSummary({ assetIds }: { assetIds: string[] }) {
  const assets = useProject(
    useShallow((s) => {
      const set = new Set(assetIds)
      return s.project.assets.filter((a) => set.has(a.id))
    }),
  )
  return (
    <div className="in-empty">
      <div className="in-empty-icon">
        <Link2 size={18} />
      </div>
      <h3>{assets.length} mục đang chọn</h3>
      <div className="in-chip-wrap">
        {assets.map((a) => (
          <AssetChip key={a.id} asset={a} />
        ))}
      </div>
      <p className="muted">
        Chọn thêm một hoặc nhiều cảnh rồi bấm <span className="kbd">C</span> để nối tất cả cùng lúc, hoặc kéo các thẻ này thả vào một cảnh.
      </p>
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['N', 'Cảnh mới / cảnh tiếp theo'],
  ['C', 'Nối mục đang chọn vào cảnh'],
  ['Ctrl+Enter', 'Chạy cảnh đang chọn'],
  ['F', 'Vừa màn hình'],
  ['E', 'Đổi chế độ hiện dây nối'],
  ['Del', 'Xoá / cắt dây nối'],
  ['Ctrl+Z', 'Hoàn tác'],
]

function EmptyInspector() {
  const counts = useProject(useShallow((s) => [s.project.scenes.length, s.project.assets.length, s.project.blocks.length]))
  const openDialog = useUI((s) => s.openDialog)
  return (
    <div className="in-empty">
      <div className="in-empty-icon">
        <MousePointerClick size={18} />
      </div>
      <h3>Chưa chọn gì</h3>
      <p className="muted">Chọn một cảnh để sửa prompt, tham chiếu và cấu hình. Chọn nhiều cảnh để sửa hàng loạt.</p>
      <div className="in-stats">
        <span>
          <b>{counts[0]}</b> cảnh
        </span>
        <span>
          <b>{counts[1]}</b> tham chiếu
        </span>
        <span>
          <b>{counts[2]}</b> khối prompt
        </span>
      </div>

      <div className="in-tips">
        <div className="in-tips-title">
          <Link2 size={13} /> Cách nối
        </div>
        <ul>
          <li>Kéo nhân vật từ Thư viện thả vào bất kỳ đâu trên thẻ cảnh.</li>
          <li>Kéo từ chấm bên phải thẻ nhân vật trên canvas sang cảnh. Thả ra chỗ trống để tạo cảnh mới.</li>
          <li>
            Chọn nhiều nhân vật + nhiều cảnh rồi bấm <span className="kbd">C</span> — nối tất cả một lần.
          </li>
          <li>
            Gõ <span className="kbd">@Tên</span> trong prompt — tự nối vào cảnh.
          </li>
        </ul>
      </div>

      <div className="in-tips">
        <div className="in-tips-title">
          <Keyboard size={13} /> Phím tắt
        </div>
        <div className="in-keys">
          {SHORTCUTS.map(([k, label]) => (
            <div key={k} className="in-key-row">
              <span className="kbd">{k}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-sm btn-ghost in-all-keys" onClick={() => openDialog({ kind: 'shortcuts' })}>
          Xem tất cả phím tắt <span className="kbd">?</span>
        </button>
      </div>

      <div className="in-empty-actions">
        <button type="button" className="btn btn-primary" onClick={() => newScene()}>
          <Plus size={14} /> Cảnh mới
        </button>
        <button type="button" className="btn" onClick={() => openDialog({ kind: 'import' })}>
          <FileText size={14} /> Nhập prompt cũ
        </button>
      </div>
      <p className="in-empty-foot faint">
        <Sparkles size={12} /> Chế độ demo: video giả, không tốn tiền.
      </p>
    </div>
  )
}

// Right panel. Switches on the selection:
// 1 scene → SceneInspector · ≥2 scenes → MultiSceneInspector · else 1 asset (canvas or library) → AssetInspector
// · several assets → short summary · take (video) nodes → TakeSummary · nothing → tips.
// Library cards vs canvas nodes: the selection the user changed last wins (see selection.ts).
import { CornerDownRight, Eye, FileText, Film, Keyboard, Link2, MousePointerClick, Plus, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { createSceneFromTake, focusNodes, newScene } from '../../actions'
import { sceneCode } from '../../core/compile'
import { MODELS, usesVideoRefs } from '../../core/models'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { AssetChip, MediaImg } from '../common/Media'
import { modeLabel, useFileDropGuard } from '../sidebar/shared'
import { AssetInspector } from './AssetInspector'
import './inspector.css'
import { MultiSceneInspector } from './MultiSceneInspector'
import { SceneInspector } from './SceneInspector'
import { STATUS_TEXT, useTakeInfos } from './hooks'
import { changedSource, existingIds, pickView, type SelectionSource } from './selection'

/** Which selection the user changed last (kept outside React so it survives the panel being closed). */
let lastSource: SelectionSource = 'canvas'
useUI.subscribe((s, prev) => {
  lastSource = changedSource(s, prev, lastSource)
})

export function Inspector() {
  const selectedIds = useUI((s) => s.selectedIds)
  const librarySelection = useUI((s) => s.librarySelection)
  const scenes = useProject(useShallow((s) => existingIds(s.project.scenes, selectedIds)))
  const canvasAssets = useProject(useShallow((s) => existingIds(s.project.assets, selectedIds)))
  const libraryAssets = useProject(useShallow((s) => existingIds(s.project.assets, librarySelection)))
  const takes = useRuns(useShallow((s) => existingIds(s.takes, selectedIds)))
  useFileDropGuard()

  // Re-rendered on every selection change (both are subscribed above), after lastSource was updated.
  const view = pickView({ scenes, canvasAssets, takes, libraryAssets }, lastSource)
  let content
  if (view.kind === 'scene') content = <SceneInspector key={view.id} sceneId={view.id} />
  else if (view.kind === 'scenes') content = <MultiSceneInspector sceneIds={view.ids} />
  else if (view.kind === 'asset') content = <AssetInspector key={view.id} assetId={view.id} />
  else if (view.kind === 'assets') content = <MultiAssetSummary assetIds={view.ids} />
  else if (view.kind === 'takes') content = <TakeSummary takeIds={view.ids} />
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

/** Take (video) nodes selected on the canvas: what they are and how to continue from them. */
function TakeSummary({ takeIds }: { takeIds: string[] }) {
  const infos = useTakeInfos(takeIds)
  const usedBy = useProject(
    useShallow((s) =>
      s.project.scenes
        .filter((sc) => sc.videoRefs.some((t) => takeIds.includes(t)))
        .sort((a, b) => a.order - b.order)
        .map((sc) => sc.id + '' + sc.order),
    ),
  )
  const single = infos.length === 1 ? infos[0] : null
  // The continuing scene copies the source scene's settings: a mode without reference videos cannot use @video_1.
  // Primitive selection: '' when it accepts videos (or the scene is gone), else why not.
  const noVideo = useProject((s) => {
    const sc = single?.sceneId ? s.project.scenes.find((x) => x.id === single.sceneId) : undefined
    if (!sc || usesVideoRefs(sc.settings)) return ''
    return `${MODELS[sc.settings.model]?.name ?? sc.settings.model} ở chế độ “${modeLabel(sc.settings.mode, sc.settings.model)}” của ${sceneCode(sc.order)} không nhận video tham chiếu — đổi sang Seedance 2.5 hoặc chế độ “${modeLabel('i2v')}” rồi thử lại`
  })
  return (
    <div className="in-empty in-take-sum">
      {single?.posterId ? (
        <button type="button" className="in-take-poster" onClick={() => useUI.getState().openDialog({ kind: 'take', takeId: single.id })} title="Xem video">
          <MediaImg id={single.posterId} className="media-img" />
        </button>
      ) : (
        <div className="in-empty-icon">
          <Film size={18} />
        </div>
      )}
      <h3>{single ? `Video ${single.label}` : `${infos.length} video đang chọn`}</h3>
      {single?.status && (
        <p className="muted">
          <span className={`status-dot ${single.status}`} /> {STATUS_TEXT[single.status]}
          {single.status === 'processing' ? ` · ${single.progress}%` : ''}
        </p>
      )}
      {usedBy.length > 0 && (
        <div className="in-chip-wrap">
          <span className="faint">Dùng làm @video ở</span>
          {usedBy.map((k) => {
            const [id, order] = k.split('')
            return (
              <button
                type="button"
                key={id}
                className="in-code-chip mono"
                onClick={() => {
                  useUI.getState().select([id])
                  focusNodes([id])
                }}
              >
                {sceneCode(Number(order))}
              </button>
            )
          })}
        </div>
      )}
      {single && (
        <div className="in-empty-actions">
          <button type="button" className="btn" onClick={() => useUI.getState().openDialog({ kind: 'take', takeId: single.id })}>
            <Eye size={14} /> Xem
          </button>
          {single.status === 'completed' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => createSceneFromTake(single.id)}
              disabled={!!noVideo}
              title={noVideo || 'Cảnh mới bên dưới cảnh gốc, dùng video này làm @video_1, giữ ảnh tham chiếu và cấu hình'}
            >
              <CornerDownRight size={14} /> Tạo cảnh tiếp nối
            </button>
          )}
        </div>
      )}
      <p className="muted">
        Kéo dây từ video sang một cảnh để dùng làm <span className="mono">@video_N</span>, hoặc chọn video + cảnh rồi bấm <span className="kbd">C</span>.
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
  const counts = useProject(useShallow((s) => [s.project.scenes.length, s.project.assets.length]))
  const takeCount = useRuns((s) => s.takes.length)
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
          <b>{takeCount}</b> video
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
            Gõ <span className="kbd">@</span> trong prompt để chèn <span className="mono">@image_1</span>, <span className="mono">@video_1</span>… hoặc nối & chèn từ thư viện.
          </li>
          <li>Kéo dây từ một video (take) sang cảnh khác để dùng làm video tham chiếu.</li>
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

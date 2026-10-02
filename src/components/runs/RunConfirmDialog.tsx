import { Coins, Play, Plus, Sparkles, TriangleAlert } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { runNow } from '../../actions'
import { compileScene, sceneCode } from '../../core/compile'
import { MODELS, settingsLabel } from '../../core/models'
import type { Asset, Scene } from '../../core/types'
import { useProject } from '../../store/project'
import { useRuns, type SceneRunCheck } from '../../store/runs'
import { useUI } from '../../store/ui'
import { AssetAvatar } from '../common/Media'
import { Modal } from '../common/Modal'
import './runs.css'

interface Row {
  scene: Scene
  check: SceneRunCheck
  assets: Asset[]
  images: number
  /** Reference videos (@video_N) and how many of them are finished takes. */
  videos: number
  videosReady: number
}

interface TakeStat {
  completed: number
  active: number
}

/** The scene already has a finished take or a job that is queued / processing. */
function hasTakeOrJob(stat: TakeStat | undefined): boolean {
  return !!stat && (stat.completed > 0 || stat.active > 0)
}

/** Cost summary + validation before sending scenes to the (mock) queue. */
export function RunConfirmDialog({ sceneIds }: { sceneIds: string[] }) {
  const close = useUI((s) => s.closeDialog)
  const project = useProject((s) => s.project)
  const takes = useRuns((s) => s.takes)
  const credits = useRuns((s) => s.credits)
  // Status of every reference video of these scenes, as one string: re-check only when one of them changes.
  const videoKey = useRuns((s) => {
    const ids = new Set(sceneIds)
    const refs = project.scenes.filter((sc) => ids.has(sc.id) && sc.videoRefs.length)
    if (!refs.length) return ''
    const status = new Map(s.takes.map((t) => [t.id, t.status]))
    return refs.map((sc) => sc.videoRefs.map((t) => status.get(t) ?? '-').join(',')).join('|')
  })
  const [onlyNew, setOnlyNew] = useState(false)
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())

  const rows = useMemo<Row[]>(() => {
    const checks = new Map(useRuns.getState().check(sceneIds).map((c) => [c.sceneId, c]))
    const assetMap = new Map(project.assets.map((a) => [a.id, a]))
    const status = new Map(useRuns.getState().takes.map((t) => [t.id, t.status]))
    return project.scenes
      .filter((s) => checks.has(s.id))
      .sort((a, b) => a.order - b.order)
      .map((scene) => {
        const compiled = compileScene(project, scene)
        return {
          scene,
          check: checks.get(scene.id)!,
          assets: scene.refs.map((id) => assetMap.get(id)).filter((a): a is Asset => !!a),
          images: compiled.images.length,
          videos: scene.videoRefs.length,
          videosReady: scene.videoRefs.filter((t) => status.get(t) === 'completed').length,
        }
      })
    // videoKey: re-run the check when a reference video finishes (or is deleted).
  }, [project, sceneIds, videoKey])

  const stats = useMemo(() => {
    const m = new Map<string, TakeStat>()
    for (const t of takes) {
      const s = m.get(t.sceneId) ?? { completed: 0, active: 0 }
      if (t.status === 'completed') s.completed++
      else if (t.status === 'queued' || t.status === 'processing') s.active++
      m.set(t.sceneId, s)
    }
    return m
  }, [takes])

  // "Only scenes without a take": a scene whose job is still queued/processing already has its take coming —
  // queueing it again would spend the credits twice.
  const shown = onlyNew ? rows.filter((r) => !hasTakeOrJob(stats.get(r.scene.id))) : rows
  const hiddenCount = rows.length - shown.length
  const runnable = shown.filter((r) => r.check.ok && !excluded.has(r.scene.id))
  const skipped = shown.filter((r) => !r.check.ok).length
  const withWarnings = shown.filter((r) => r.check.ok && r.check.warnings.length).length
  const total = runnable.reduce((t, r) => t + r.check.cost, 0)
  const after = credits - total
  const short = after < 0
  const canRun = runnable.length > 0 && !short
  const selectable = shown.filter((r) => r.check.ok)
  const allChecked = selectable.length > 0 && selectable.every((r) => !excluded.has(r.scene.id))

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = () => setExcluded(allChecked ? new Set(selectable.map((r) => r.scene.id)) : new Set())

  const run = () => {
    if (!canRun) return
    const res = runNow(runnable.map((r) => r.scene.id))
    if (!res.error) close()
  }

  const title = sceneIds.length === 1 && rows[0] ? `Chạy ${sceneCode(rows[0].scene.order)}` : `Chạy ${rows.length} cảnh`

  return (
    <ModalShell
      title={title}
      onClose={close}
      footer={
        <>
          <div className="rq-foot-info">
            <span className={`rq-balance${short ? ' short' : ''}`}>
              <Coins size={14} />
              Số dư <b className="mono">{credits.toLocaleString('vi-VN')}</b> → <b className="mono">{after.toLocaleString('vi-VN')}</b> credit
            </span>
            {short && (
              <>
                <span className="rq-short">Thiếu {(-after).toLocaleString('vi-VN')} credit</span>
                <button type="button" className="btn btn-sm" onClick={() => useRuns.getState().addCredits(100)} title="Credit demo, không phải tiền thật">
                  <Plus size={13} /> 100 credit demo
                </button>
              </>
            )}
          </div>
          <button type="button" className="btn" onClick={close}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canRun}
            onClick={run}
            autoFocus
            title={!runnable.length ? 'Không có cảnh nào chạy được' : short ? 'Không đủ credit' : 'Gửi vào hàng đợi'}
          >
            <Play size={14} fill="currentColor" />
            Chạy {runnable.length} cảnh · {total.toLocaleString('vi-VN')} credit
          </button>
        </>
      }
    >
      <div className="rq-confirm-top">
        <div className="rq-summary">
          <span className="badge">{shown.length} cảnh</span>
          <span className="badge ok">{runnable.length} sẽ chạy</span>
          {skipped > 0 && <span className="badge danger">{skipped} bị bỏ qua</span>}
          {withWarnings > 0 && (
            <span className="badge warn">
              <TriangleAlert size={11} /> {withWarnings} có cảnh báo
            </span>
          )}
        </div>
        <span className="rq-spacer" />
        <label className="checkbox">
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
          Chỉ chạy cảnh chưa có take (bỏ qua cảnh đang chạy)
          {onlyNew && hiddenCount > 0 && <span className="faint">(ẩn {hiddenCount} cảnh đã có take hoặc đang chạy)</span>}
        </label>
      </div>

      {shown.length === 0 ? (
        <div className="empty">{rows.length ? 'Mọi cảnh đã chọn đều đã có take hoàn thành hoặc đang chạy.' : 'Không có cảnh nào để chạy.'}</div>
      ) : (
        <div className="rq-table-wrap">
          <table className="rq-table">
            <colgroup>
              <col className="rq-w-check" />
              <col className="rq-w-code" />
              <col className="rq-w-title" />
              <col className="rq-w-settings" />
              <col className="rq-w-refs" />
              <col className="rq-w-videos" />
              <col className="rq-w-warn" />
              <col className="rq-w-credit" />
              <col className="rq-w-status" />
            </colgroup>
            <thead>
              <tr>
                <th className="rq-col-check">
                  <input type="checkbox" checked={allChecked} disabled={!selectable.length} onChange={toggleAll} aria-label="Chọn tất cả" />
                </th>
                <th>Cảnh</th>
                <th>Tên</th>
                <th>Cấu hình</th>
                <th title="Ảnh tham chiếu (@image_N)">Ảnh</th>
                <th title="Video tham chiếu (@video_N)">Video</th>
                <th>Cảnh báo</th>
                <th className="num">Credit</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <ConfirmRow
                  key={r.scene.id}
                  row={r}
                  stat={stats.get(r.scene.id)}
                  included={r.check.ok && !excluded.has(r.scene.id)}
                  onToggle={() => toggle(r.scene.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rq-confirm-note">
        <Sparkles size={12} /> Chế độ demo: video giả, không gửi đi đâu và không tốn tiền thật. Credit bị lỗi/huỷ sẽ được hoàn lại.
      </div>
    </ModalShell>
  )
}

function ConfirmRow({ row, stat, included, onToggle }: { row: Row; stat: TakeStat | undefined; included: boolean; onToggle: () => void }) {
  const { scene, check, assets, images, videos, videosReady } = row
  const spec = MODELS[scene.settings.model]
  const warnings = check.warnings
  return (
    <tr className={!check.ok ? 'bad' : included ? '' : 'off'}>
      <td className="rq-col-check">
        <input type="checkbox" checked={included} disabled={!check.ok} onChange={onToggle} aria-label={`Chạy ${sceneCode(scene.order)}`} />
      </td>
      <td>
        <span className="badge accent mono">{sceneCode(scene.order)}</span>
      </td>
      <td className="rq-cell-title" title={scene.title || undefined}>
        {scene.title || <span className="faint">Chưa đặt tên</span>}
      </td>
      <td className="rq-cell-settings" title={`${spec?.name ?? scene.settings.model} · ${settingsLabel(scene.settings)}`}>
        <span className="rq-model">
          <i style={{ background: spec?.color }} />
          {spec?.short ?? scene.settings.model}
        </span>
        <span className="mono rq-settings-line">{settingsLabel(scene.settings)}</span>
      </td>
      <td>
        {assets.length ? (
          <span className="rq-refs" title={`${images} ảnh tham chiếu: ${assets.map((a) => a.name).join(', ')}`}>
            <span className="rq-avatars">
              {assets.slice(0, 3).map((a) => (
                <AssetAvatar key={a.id} asset={a} size={18} />
              ))}
            </span>
            <span className="faint mono">{images}</span>
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="mono">
        {videos ? (
          <span
            className={videosReady < videos ? 'rq-vcount pending' : 'rq-vcount'}
            title={videosReady < videos ? `${videos - videosReady}/${videos} video tham chiếu chưa tạo xong` : `${videos} video tham chiếu (@video_1…)`}
          >
            {videos}
            {videosReady < videos && <TriangleAlert size={11} />}
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="rq-cell-warn">
        {warnings.length ? (
          <span className="rq-warn" title={warnings.join('\n')}>
            <TriangleAlert size={12} />
            <span className="rq-ellipsis">{warnings[0]}</span>
            {warnings.length > 1 && <b>+{warnings.length - 1}</b>}
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="num mono">{check.cost}</td>
      <td className="rq-cell-status">
        {!check.ok ? (
          <span className="rq-skip">Bỏ qua: {check.reason}</span>
        ) : !included ? (
          <span className="faint">Không chạy</span>
        ) : (
          <span className="rq-ok">
            OK
            {stat?.active ? (
              <span className="rq-active-note" title="Cảnh này đang có job chờ/đang tạo — chạy thêm sẽ tạo thêm take và tốn thêm credit">
                {' '}
                · đang có {stat.active} job
              </span>
            ) : stat?.completed ? (
              <span className="faint"> · đã có {stat.completed} take</span>
            ) : null}
          </span>
        )}
      </td>
    </tr>
  )
}

/** Extra-wide modal (room for the title + warning columns) with the dialog's body wrapper. */
function ModalShell({ title, onClose, footer, children }: { title: string; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  return (
    <Modal title={title} onClose={onClose} footer={footer} size="xwide">
      <div className="rq-confirm">{children}</div>
    </Modal>
  )
}

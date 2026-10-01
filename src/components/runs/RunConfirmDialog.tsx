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
}

interface TakeStat {
  completed: number
  active: number
}

/** Cost summary + validation before sending scenes to the (mock) queue. */
export function RunConfirmDialog({ sceneIds }: { sceneIds: string[] }) {
  const close = useUI((s) => s.closeDialog)
  const project = useProject((s) => s.project)
  const takes = useRuns((s) => s.takes)
  const credits = useRuns((s) => s.credits)
  const [onlyNew, setOnlyNew] = useState(false)
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())

  const rows = useMemo<Row[]>(() => {
    const checks = new Map(useRuns.getState().check(sceneIds).map((c) => [c.sceneId, c]))
    const assetMap = new Map(project.assets.map((a) => [a.id, a]))
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
        }
      })
  }, [project, sceneIds])

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

  const shown = onlyNew ? rows.filter((r) => !stats.get(r.scene.id)?.completed) : rows
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
          Chỉ chạy cảnh chưa có take
          {onlyNew && hiddenCount > 0 && <span className="faint">(ẩn {hiddenCount} cảnh đã có take)</span>}
        </label>
      </div>

      {shown.length === 0 ? (
        <div className="empty">{rows.length ? 'Mọi cảnh đã chọn đều đã có take hoàn thành.' : 'Không có cảnh nào để chạy.'}</div>
      ) : (
        <div className="rq-table-wrap">
          <table className="rq-table">
            <colgroup>
              <col className="rq-w-check" />
              <col className="rq-w-code" />
              <col />
              <col className="rq-w-model" />
              <col className="rq-w-settings" />
              <col className="rq-w-refs" />
              <col />
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
                <th>Model</th>
                <th>Cấu hình</th>
                <th>Tham chiếu</th>
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
  const { scene, check, assets, images } = row
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
      <td>
        <span className="rq-model">
          <i style={{ background: spec?.color }} />
          {spec?.short ?? scene.settings.model}
        </span>
      </td>
      <td className="mono rq-nowrap">{settingsLabel(scene.settings)}</td>
      <td>
        {assets.length ? (
          <span className="rq-refs" title={assets.map((a) => '@' + a.tag).join(', ')}>
            <span className="rq-avatars">
              {assets.slice(0, 4).map((a) => (
                <AssetAvatar key={a.id} asset={a} size={18} />
              ))}
            </span>
            {assets.length > 4 && <span className="faint">+{assets.length - 4}</span>}
            <span className="faint mono">{images} ảnh</span>
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
      <td>
        {!check.ok ? (
          <span className="rq-skip">Bỏ qua: {check.reason}</span>
        ) : !included ? (
          <span className="faint">Không chạy</span>
        ) : (
          <span className="rq-ok">
            OK
            {stat?.active ? <span className="faint"> · đang có {stat.active} job</span> : stat?.completed ? <span className="faint"> · đã có {stat.completed} take</span> : null}
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

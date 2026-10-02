import { Bug, FlaskConical, LoaderCircle, LogIn, Play, RefreshCw, Sparkles, TriangleAlert, Wallet } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { openDevPanel, runNow } from '../../actions'
import { compileScene, sceneCode } from '../../core/compile'
import { MODELS, settingsLabel } from '../../core/models'
import type { Asset, Scene } from '../../core/types'
import { PROVIDER_LABEL } from '../../providers'
import {
  CREDIT_HINT,
  creditUnitLabel,
  formatCreditNumber,
  formatCredits,
  formatVnd,
  isSimulatedCredit,
  refreshRealCredits,
  useCreditInfo,
  type CreditInfo,
} from '../../store/credits'
import { useProject } from '../../store/project'
import { useRuns, type SceneRunCheck } from '../../store/runs'
import { useUI } from '../../store/ui'
import { AssetAvatar } from '../common/Media'
import { Modal } from '../common/Modal'
import { loginToCanvasapp } from '../topbar/CreditPill'
import { runCostPreview, type RunCostPreview } from './creditText'
import { ProviderBadge, useActiveProvider } from './shared'
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

/**
 * Cost summary + validation before sending scenes to the queue (a sheet). The header names the credits the run
 * spends (useCreditInfo(): the provider new takes use):
 *   dev        development mode — the simulated canvasapp account ("credit dev", not real money): current simulated
 *              balance → estimated after ("trừ khi máy chủ giả lập nhận job"); never blocked here (a low balance
 *              only warns — the simulated server answers 402 like canvasapp).
 *   canvasapp  the user's real account — current real balance → estimated after ("trừ trên canvasapp khi job được
 *              nhận"); never blocked here (a low real balance only warns: canvasapp decides).
 *   demo       (legacy) the old demo's play money — blocked when short.
 * Every amount goes through formatCredits / formatCreditNumber.
 */
export function RunConfirmDialog({ sceneIds, follow }: { sceneIds: string[]; follow?: boolean }) {
  const close = useUI((s) => s.closeDialog)
  const project = useProject((s) => s.project)
  const takes = useRuns((s) => s.takes)
  const provider = useActiveProvider()
  const info = useCreditInfo()
  const kind = info.kind
  const demo = kind === 'demo'
  const dev = kind === 'dev'
  /** Not real money (development mode / old demo): the dashed, neutral look. */
  const sim = isSimulatedCredit(kind)
  const unit = creditUnitLabel(kind)
  // dev / canvasapp: make sure the gateway balance shown is recent (throttled — no request when read < 15 s ago).
  useEffect(() => {
    if (!demo) void refreshRealCredits()
  }, [demo])
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
    // videoKey: re-run the check when a reference video finishes (or is deleted). provider: the checks depend on
    // what the provider accepts (canvasapp has no @video yet).
  }, [project, sceneIds, videoKey, provider])

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
  // Only the old demo spent the local demo credits (store/runs enqueue): dev / canvasapp are never blocked here.
  const preview = runCostPreview(kind, total, info.balance)
  const short = preview.short
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
    if (res.error) return
    // Re-run from the take viewer: show the new take there (its progress, then the video).
    const only = runnable.length === 1 ? runnable[0].scene.id : null
    const newest = follow && only ? useRuns.getState().takes.filter((t) => t.sceneId === only).sort((a, b) => b.number - a.number)[0] : undefined
    if (newest) useUI.getState().openDialog({ kind: 'take', takeId: newest.id })
    else close()
  }

  const title = sceneIds.length === 1 && rows[0] ? `Chạy ${sceneCode(rows[0].scene.order)}` : `Chạy ${rows.length} cảnh`

  return (
    <ModalShell
      title={title}
      headerExtra={<CreditSourceBadge kind={kind} />}
      onClose={close}
      footer={
        <>
          <div className="rq-foot-info">
            <FooterBalance preview={preview} info={info} />
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
            title={
              !runnable.length
                ? 'Không có cảnh nào chạy được'
                : short
                  ? 'Không đủ credit demo'
                  : dev
                    ? 'Gửi sang canvasapp giả lập (chế độ Phát triển) — trừ credit dev khi máy chủ giả lập nhận job (không phải tiền thật)'
                    : demo
                      ? 'Gửi vào hàng đợi (demo cũ — credit giả lập)'
                      : 'Gửi sang canvasapp.io.vn — trừ credit canvasapp (tiền thật) khi job được nhận'
            }
          >
            <Play size={14} fill="currentColor" />
            Chạy {runnable.length} cảnh · {formatCredits(total, kind)}
          </button>
        </>
      }
    >
      <div className="rq-sheet-summary">
        <div className="rq-stat">
          <span>Sẽ chạy</span>
          <b className="mono">{runnable.length}</b>
          <small>trên {shown.length} cảnh</small>
        </div>
        <div className={`rq-stat${sim ? '' : ' real'}`} title={CREDIT_HINT[kind] ?? undefined}>
          <span>Chi phí</span>
          <b className="mono">{sim ? formatCreditNumber(total) : `≈ ${formatCreditNumber(total)}`}</b>
          <small>{sim ? `${unit} · giả lập` : `${unit} canvasapp · ≈ ${formatVnd(total)}`}</small>
        </div>
        {demo ? (
          <div className={`rq-stat${short ? ' short' : ''}`} title={CREDIT_HINT.demo ?? undefined}>
            <span>Số dư demo sau khi chạy</span>
            <b className="mono">{formatCreditNumber(preview.after)}</b>
            <small>đang có {formatCredits(preview.before, 'demo')}</small>
          </div>
        ) : (
          <div
            className={`rq-stat real${preview.mayBeShort ? ' short' : ''}`}
            title={dev ? 'Ước tính: máy chủ giả lập trừ credit dev khi nhận từng job' : 'Ước tính: canvasapp trừ credit khi nhận từng job'}
          >
            <span>{dev ? 'Số dư DEV sau khi chạy (ước tính)' : 'Số dư canvasapp sau khi chạy (ước tính)'}</span>
            <b className="mono">{preview.after === null ? '—' : `≈ ${formatCreditNumber(preview.after)}`}</b>
            <small>{gatewayBalanceHint(info)}</small>
          </div>
        )}
        <div className="rq-stat rq-stat-provider">
          <span>Nhà cung cấp</span>
          <ProviderBadge provider={provider} />
          <small>{PROVIDER_LABEL[provider]}</small>
        </div>
      </div>

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
                <th className="num" title={sim ? `${unit} (giả lập, không phải tiền thật)` : 'Credit canvasapp (ước tính, tiền thật)'}>
                  Credit
                </th>
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

      {dev ? (
        <div className="rq-confirm-note sim">
          <Bug size={13} />
          <span>
            Chế độ Phát triển: SanoVids chạy đúng các bước của cổng canvasapp (tải ảnh, lưu canvas, tạo job, theo dõi, tải video) nhưng tới canvasapp giả lập trong máy —
            không gọi mạng, credit dev không phải tiền thật. Video giả ghi nhãn @image_N để kiểm tra đúng nhân vật; muốn thử lỗi thì mở{' '}
            <button type="button" className="rq-link" onClick={() => openDevPanel('faults')}>
              Bảng phát triển
            </button>
            .
          </span>
        </div>
      ) : demo ? (
        <div className="rq-confirm-note">
          <Sparkles size={13} />
          <span>Demo cũ: video giả, không gửi đi đâu. {CREDIT_HINT.demo}. Credit demo của job lỗi/huỷ được hoàn lại.</span>
        </div>
      ) : (
        <div className="rq-confirm-note real">
          <TriangleAlert size={13} />
          <span>
            Gửi sang <b>canvasapp.io.vn</b> bằng tài khoản của bạn — credit thật, trừ trên canvasapp khi job được nhận (số dư DEV không liên quan). Huỷ
            take trong SanoVids không dừng job đã gửi sang canvasapp.
          </span>
        </div>
      )}
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
      <td className="num mono">{formatCreditNumber(check.cost)}</td>
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
function ModalShell({
  title,
  headerExtra,
  onClose,
  footer,
  children,
}: {
  title: string
  headerExtra?: ReactNode
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  return (
    <Modal title={title} headerExtra={headerExtra} onClose={onClose} footer={footer} size="xwide">
      <div className="rq-confirm">{children}</div>
    </Modal>
  )
}

/** Header: which credits this run spends. */
function CreditSourceBadge({ kind }: { kind: CreditInfo['kind'] }) {
  if (kind === 'dev') {
    return (
      <span className="rq-src demo" title={CREDIT_HINT.dev ?? undefined}>
        <FlaskConical size={12} />
        Trả bằng credit dev · giả lập
      </span>
    )
  }
  if (kind === 'demo') {
    return (
      <span className="rq-src demo" title={CREDIT_HINT.demo ?? undefined}>
        <FlaskConical size={12} />
        Trả bằng credit demo · giả lập
      </span>
    )
  }
  return (
    <span className="rq-src real" title="Credit thật của tài khoản canvasapp.io.vn (1 credit ≈ 1.000đ)">
      <Wallet size={12} />
      Trả bằng credit canvasapp · tiền thật
    </span>
  )
}

/** Small line under the estimated gateway balance: where the number comes from, or why it is unknown. */
function gatewayBalanceHint(info: CreditInfo): string {
  const dev = info.kind === 'dev'
  if (info.balance !== null && info.status !== 'login-required') {
    return `đang có ${formatCredits(info.balance, info.kind)}${info.status === 'error' ? ' (chưa cập nhật được)' : ''} · trừ khi job được nhận`
  }
  switch (info.status) {
    case 'login-required':
      return dev ? 'chưa đăng nhập tài khoản giả lập — chưa biết số dư' : 'chưa đăng nhập canvasapp — chưa biết số dư'
    case 'loading':
      return dev ? 'đang đọc số dư giả lập…' : 'đang đọc số dư canvasapp…'
    case 'unavailable':
      return 'không đọc được số dư (chỉ có trong bản desktop)'
    default:
      return dev ? 'chưa đọc được số dư giả lập' : 'chưa đọc được số dư canvasapp'
  }
}

/** Footer: the gateway balance → estimated after (dev: simulated, canvasapp: real), or the old demo wallet. */
function FooterBalance({ preview, info }: { preview: RunCostPreview; info: CreditInfo }) {
  const [busy, setBusy] = useState(false)
  if (preview.kind === 'demo') {
    return (
      <span className={`rq-balance${preview.short ? ' short' : ''}`} title={CREDIT_HINT.demo ?? undefined}>
        <FlaskConical size={14} />
        Số dư demo <b className="mono">{formatCreditNumber(preview.before)}</b> → <b className="mono">{formatCredits(preview.after, 'demo')}</b>
        {preview.short && preview.after !== null && <span className="rq-short">Thiếu {formatCredits(-preview.after, 'demo')}</span>}
      </span>
    )
  }
  const dev = preview.kind === 'dev'
  const act = (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  const loading = busy || info.refreshing
  const stale = info.status === 'error' && preview.before !== null ? `\nSố dư này là số cuối cùng đọc được — chưa cập nhật được: ${info.error ?? 'lỗi không rõ'}` : ''
  return (
    <>
      <span
        className={`rq-balance real${dev ? ' sim' : ''}${preview.mayBeShort ? ' short' : ''}`}
        title={
          (dev
            ? `${CREDIT_HINT.dev}. Ước tính lần chạy này ${formatCredits(preview.total, 'dev')}.`
            : `Credit thật của tài khoản canvasapp.io.vn (1 credit ≈ 1.000đ). Ước tính lần chạy này ≈ ${formatVnd(preview.total)}.`) + stale
        }
      >
        {dev ? <FlaskConical size={14} /> : <Wallet size={14} />}
        {dev ? 'DEV' : 'canvasapp'} <b className="mono">{formatCreditNumber(preview.before)}</b> →{' '}
        <b className="mono">{preview.after === null ? '—' : `≈ ${formatCredits(preview.after, preview.kind)}`}</b>
        <span className="rq-balance-note">{dev ? '· trừ khi máy chủ giả lập nhận job' : '· trừ trên canvasapp khi job được nhận'}</span>
      </span>
      {preview.mayBeShort && <span className="rq-short warn">{dev ? 'Có thể không đủ credit dev' : 'Có thể không đủ credit canvasapp'}</span>}
      {info.status === 'login-required' ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => act(loginToCanvasapp)}
          title={dev ? 'Mở trang đăng nhập giả lập (không cần mật khẩu)' : 'Mở trang đăng nhập của canvasapp.io.vn'}
        >
          {busy ? <LoaderCircle size={13} className="rq-spin" /> : <LogIn size={13} />} {dev ? 'Đăng nhập (giả lập)' : 'Đăng nhập canvasapp'}
        </button>
      ) : (
        info.status !== 'unavailable' && (
          <button
            type="button"
            className="icon-btn rq-icon-sm"
            disabled={loading}
            onClick={() => act(info.refresh)}
            title={dev ? 'Đọc lại số credit dev' : 'Đọc lại số credit canvasapp'}
            aria-label={dev ? 'Đọc lại số credit dev' : 'Đọc lại số credit canvasapp'}
          >
            {loading ? <LoaderCircle size={14} className="rq-spin" /> : <RefreshCw size={14} />}
          </button>
        )
      )}
    </>
  )
}

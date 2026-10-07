import {
  Bug,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Cloud,
  CloudDownload,
  Download,
  Eye,
  ListVideo,
  LoaderCircle,
  LocateFixed,
  MonitorSmartphone,
  RotateCcw,
  Settings2,
  Trash,
  TriangleAlert,
  X,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { cancelTake, deleteTakes, downloadTake, focusNodes, openDevPanel, rerunTake } from '../../actions'
import { sceneCode } from '../../core/compile'
import { MODELS } from '../../core/models'
import type { Scene, Take } from '../../core/types'
import { CREDIT_MARK, formatCredits } from '../../lib/credits'
import { PROVIDER_LABEL } from '../../providers'
import { providerOf } from '../../providers/types'
import { useDevServer, type DevSpeed } from '../../providers/dev'
import { useProject } from '../../store/project'
import { clearableTakes, isParkedTake, useRuns } from '../../store/runs'
import { transferPercent, useTakeTransfers } from '../../store/takeTransfers'
import { toast, useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { sceneMapOf } from '../canvas/canvasModel'
import { activeFaultCount } from '../dev/devModel'
import { CreditPill } from '../topbar/CreditPill'
import { takeCostLine } from './creditText'
import { importedChipTitle, takeCostKnown, takeSettingsText } from './importedTake'
import { openImportJobs } from '../../siteJobActions'
import { formatClock, formatDuration, isActive, ProviderBadge, StatusBadge, takeElapsed, useActiveProvider, useNow } from './shared'
import './runs.css'

const DEV_SPEED_SHORT: Record<DevSpeed, string> = { fast: 'nhanh', realistic: 'thực tế' }
const DONE_PAGE = 40

const openSettings = () => useUI.getState().openDialog({ kind: 'settings' })

/** Queue docked at the bottom of the center area: a 36px material bar that expands into the job list. */
export function QueueDrawer() {
  const open = useUI((s) => s.queueOpen)
  useBatchDoneToast()
  return (
    <section className={`rq-drawer material${open ? ' open' : ''}`} aria-label="Hàng đợi">
      <QueueBar open={open} />
      {open && <QueuePanel />}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------------

function QueueBar({ open }: { open: boolean }) {
  const c = useRuns(
    useShallow((s) => {
      let processing = 0
      let queued = 0
      let completed = 0
      let failed = 0
      let progress = 0
      for (const t of s.takes) {
        if (t.status === 'processing') {
          processing++
          progress += t.progress
        } else if (t.status === 'queued') queued++
        else if (t.status === 'completed') completed++
        else if (t.status === 'failed') failed++
      }
      const active = processing + queued
      return { processing, queued, completed, failed, active, progress: active ? Math.round(progress / active) : 0 }
    }),
  )
  const issue = useRuns((s) => s.providerIssue)
  const elsewhere = useRuns((s) => s.engineElsewhere)
  const toggle = () => useUI.getState().setQueueOpen(!open)

  return (
    <div
      className="rq-bar"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={open ? 'Thu gọn hàng đợi' : 'Mở hàng đợi'}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggle()
        }
      }}
    >
      <ListVideo size={15} className="rq-bar-icon" />
      <span className="rq-bar-title">Hàng đợi</span>
      <span className="rq-counts">
        <Count n={c.processing} label="đang chạy" tone="processing" />
        <Count n={c.queued} label="chờ" tone="queued" />
        <Count n={c.completed} label="xong" tone="completed" />
        <Count n={c.failed} label="lỗi" tone="failed" />
      </span>
      {c.active > 0 && (
        <span className="rq-mini" title={`Tiến độ trung bình của ${c.active} job đang chạy/chờ`}>
          <span className="progress">
            <i style={{ width: `${Math.max(2, c.progress)}%` }} />
          </span>
          <span className="mono">{c.progress}%</span>
        </span>
      )}
      <span className="rq-spacer" />
      {issue && (
        <span className="rq-chip warn" title={`${PROVIDER_LABEL[issue.provider]}: ${issue.message}`}>
          <TriangleAlert size={12} />
          <span className="rq-chip-text">{PROVIDER_LABEL[issue.provider]} đang gặp sự cố</span>
        </span>
      )}
      {elsewhere && (
        <span className="rq-chip info" title="Một tab/cửa sổ khác của dự án này đang chạy hàng đợi — tab này chỉ hiển thị tiến độ.">
          <MonitorSmartphone size={12} />
          <span className="rq-chip-text">Đang chạy ở tab khác</span>
        </span>
      )}
      {/* The same pill as the top bar (demo vs real credits). Its clicks / Enter / Space must not toggle the drawer;
          other keys keep bubbling so the global shortcuts (window keydown, Ctrl+Z…) still work while it has focus. */}
      <span
        className="rq-bar-credit"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
        }}
      >
        <CreditPill size="sm" />
      </span>
      <span className="rq-chevron">{open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</span>
    </div>
  )
}

function Count({ n, label, tone }: { n: number; label: string; tone: Take['status'] }) {
  return (
    <span className={`rq-count${n ? '' : ' zero'}`} title={`${n} ${label}`}>
      <span className={`status-dot ${n ? tone : ''}`} />
      <b className="mono">{n}</b>
      <span className="rq-count-label">{label}</span>
    </span>
  )
}

/** Development mode: opens "Bảng phát triển"; shows the simulated speed and how many faults are armed. */
function DevPanelButton() {
  const speed = useDevServer((s) => s.snapshot?.config.speed ?? 'fast')
  const armed = useDevServer((s) => activeFaultCount(s.snapshot))
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm${armed ? ' rq-dev-armed' : ''}`}
      onClick={() => openDevPanel(armed ? 'faults' : undefined)}
      title="Bảng phát triển: tốc độ, lỗi giả, nhật ký yêu cầu, job của canvasapp giả lập"
    >
      <Bug size={13} />
      <span className="rq-btn-label">
        Bảng phát triển · {DEV_SPEED_SHORT[speed]}
        {armed ? ` · ${armed} lỗi giả` : ''}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------------------------------------------------

interface Group {
  key: string
  title: string
  takes: Take[]
}

function QueuePanel() {
  const takes = useRuns((s) => s.takes)
  const issue = useRuns((s) => s.providerIssue)
  const elsewhere = useRuns((s) => s.engineElsewhere)
  const provider = useActiveProvider()
  const sceneMap = useProject((s) => sceneMapOf(s.project.scenes))
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE)

  const groups = useMemo<Group[]>(() => {
    const newest = [...takes].sort((a, b) => b.createdAt - a.createdAt)
    const pick = (fn: (t: Take) => boolean) => newest.filter(fn)
    return [
      { key: 'processing', title: 'Đang tạo', takes: pick((t) => t.status === 'processing') },
      // Queue order: the next job to start is listed first.
      { key: 'queued', title: 'Đang chờ', takes: pick((t) => t.status === 'queued').reverse() },
      // A newer build's take still running there (parked as 'failed' here): its own group, never "Dọn job lỗi".
      { key: 'newer', title: 'Đang chạy ở bản SanoVids mới hơn', takes: pick(isParkedTake) },
      { key: 'failed', title: 'Lỗi / đã huỷ', takes: pick((t) => (t.status === 'failed' || t.status === 'cancelled') && !isParkedTake(t)) },
      { key: 'completed', title: 'Hoàn thành', takes: pick((t) => t.status === 'completed') },
    ].filter((g) => g.takes.length)
  }, [takes])

  const clearable = useMemo(() => clearableTakes(takes), [takes])

  // The shared delete (actions.deleteTakes): also drops the takes from @video references and the selection and
  // deletes their stored files. Failed / cancelled jobs have no finished video, so nothing needs confirming. A newer
  // build's take parked here (it may still be running, and paid, there) is never part of it (clearableTakes).
  const clearFailed = () => {
    const n = deleteTakes(
      clearable.map((t) => t.id),
      { toast: false },
    )
    if (n) toast(`Đã xoá ${n} job lỗi/đã huỷ khỏi danh sách.`, { tone: 'success' })
  }

  return (
    <div className="rq-panel">
      <div className="rq-panel-head">
        {provider === 'dev' ? (
          <span className="rq-demo-note dev">
            <Bug size={12} /> Chế độ Phát triển: canvasapp giả lập trong máy — credit dev, không gọi mạng, không tốn tiền thật
          </span>
        ) : (
          <span className="rq-demo-note real">
            <Cloud size={12} /> Take mới tạo trên {PROVIDER_LABEL.canvasapp} — trừ credit canvasapp (tiền thật) khi job được nhận
          </span>
        )}
        <span className="rq-spacer" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => openImportJobs()}
          title={`Tìm video đã tạo trực tiếp trên ${provider === 'dev' ? 'canvasapp giả lập' : 'canvasapp.io.vn'} (phiên “SanoVids bridge”) và đưa vào dự án thành take — chỉ đọc, không trừ ${provider === 'dev' ? 'credit dev' : 'credit'}`}
        >
          <CloudDownload size={13} />
          <span className="rq-btn-label">Nhập job</span>
        </button>
        {provider === 'dev' ? (
          <DevPanelButton />
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={openSettings} title="Đăng nhập, số credit và nhà cung cấp video (Cài đặt)">
            <Settings2 size={13} />
            <span className="rq-btn-label">Cổng canvasapp</span>
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" disabled={!clearable.length} onClick={clearFailed} title="Xoá các job lỗi/đã huỷ khỏi danh sách">
          <Trash size={13} />
          <span className="rq-btn-label">Dọn job lỗi/đã huỷ{clearable.length ? ` (${clearable.length})` : ''}</span>
        </button>
      </div>

      <div className="rq-list">
        {issue && (
          <div className="rq-banner warn" role="status">
            <TriangleAlert size={15} />
            <div className="rq-banner-text">
              <b>
                {PROVIDER_LABEL[issue.provider]}: {issue.message}
              </b>
              <small>Các take đang chạy được giữ nguyên; SanoVids tự kiểm tra lại sau · lúc {formatClock(issue.at)}</small>
            </div>
            {issue.provider === 'dev' && (
              <button type="button" className="btn btn-sm" onClick={() => openDevPanel('log')} title="Xem nhật ký yêu cầu và lỗi giả đang bật">
                <Bug size={13} /> Bảng phát triển
              </button>
            )}
            {issue.provider !== 'mock' && (
              <button type="button" className="btn btn-sm" onClick={openSettings}>
                Mở Cài đặt
              </button>
            )}
          </div>
        )}
        {elsewhere && (
          <div className="rq-banner info" role="status">
            <MonitorSmartphone size={15} />
            <div className="rq-banner-text">
              <b>Hàng đợi đang chạy ở một tab/cửa sổ khác của dự án này</b>
              <small>Tab này chỉ hiển thị tiến độ. Khi tab kia đóng hoặc chạy xong, tab này tự nhận việc.</small>
            </div>
          </div>
        )}
        {!groups.length && (
          <div className="rq-empty">
            <ListVideo size={22} />
            <div>Chưa có job nào.</div>
            <div className="faint">
              Chọn cảnh rồi bấm <span className="kbd">Ctrl</span> + <span className="kbd">Enter</span> hoặc nút ▶ trên thẻ cảnh.
            </div>
          </div>
        )}
        {groups.map((g) => {
          const limited = g.key === 'completed' ? g.takes.slice(0, doneLimit) : g.takes
          return (
            <div key={g.key} className="rq-group">
              <div className={`rq-group-head ${g.key}`}>
                <span>{g.title}</span>
                <span className="mono">{g.takes.length}</span>
              </div>
              {limited.map((t) => (
                <QueueRow key={t.id} take={t} scene={sceneMap.get(t.sceneId)} />
              ))}
              {limited.length < g.takes.length && (
                <button type="button" className="rq-show-more" onClick={() => setDoneLimit((n) => n + DONE_PAGE)}>
                  Hiện thêm {Math.min(DONE_PAGE, g.takes.length - limited.length)} / còn {g.takes.length - limited.length}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------

const QueueRow = memo(function QueueRow({ take, scene }: { take: Take; scene: Scene | undefined }) {
  const active = isActive(take)
  const now = useNow(active)
  const code = scene ? sceneCode(scene.order) : 'S??'
  const elapsed = takeElapsed(take, now)
  const ended = take.status === 'failed' || take.status === 'cancelled'
  // Which credits paid it; struck = not (or no longer) paid: demo refunds, a job canvasapp never accepted.
  const cost = takeCostLine(take)
  const open = () => useUI.getState().openDialog({ kind: 'take', takeId: take.id })
  const goto = () => gotoTake(take, scene)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      await downloadTake(take.id)
    } finally {
      setSaving(false)
    }
  }
  // The finished video is downloading: its own progress ("tải 45%"), and "Huỷ" asks first (actions.cancelTake).
  const downloading = useTakeTransfers((s) => take.id in s.byTake)
  const downloadPct = useTakeTransfers((s) => transferPercent(s.byTake[take.id]))
  const shownPct = take.status === 'queued' ? 0 : downloading ? (downloadPct ?? take.progress) : take.progress

  return (
    <div className={`rq-row ${take.status}`}>
      <button type="button" className="rq-row-thumb" onClick={open} title="Xem take">
        {take.posterId ? <MediaImg id={take.posterId} className="rq-thumb-img" /> : <span className="rq-thumb-ph" />}
        {active && (
          <span className="rq-thumb-ov">
            <span className={`status-dot ${take.status}`} />
          </span>
        )}
      </button>

      <div className="rq-row-main">
        <div className="rq-row-line">
          <span className="rq-code mono">
            {code} · T{take.number}
          </span>
          {take.starred && <span className="rq-star-mini">★</span>}
          <span className={`rq-row-title${scene?.title ? '' : ' faint'}`}>{scene ? scene.title || 'Chưa đặt tên' : 'Cảnh đã bị xoá'}</span>
        </div>
        <div className="rq-row-sub">
          <ProviderBadge take={take} />
          {take.imported && (
            <span className="rq-imported" title={importedChipTitle(take)}>
              nhập
            </span>
          )}
          <span className="rq-row-model" style={{ ['--rq-model-c' as string]: MODELS[take.settings.model]?.color }}>
            {MODELS[take.settings.model]?.short ?? take.settings.model}
          </span>
          <span>{takeSettingsText(take)}</span>
          {take.status === 'failed' && take.error && (
            <span className="rq-row-err" title={take.error}>
              {take.error}
            </span>
          )}
        </div>
      </div>

      <div className="rq-row-status">
        <StatusBadge take={take} showProgress={false} />
        {active && (
          <span className="progress">
            <i style={{ width: `${shownPct}%` }} />
          </span>
        )}
      </div>

      <span
        className="rq-row-time mono"
        title={take.status === 'queued' ? 'Thời gian chờ' : downloading ? 'Video đã tạo xong, đang tải về máy · thời gian tạo' : 'Thời gian tạo'}
      >
        {take.status === 'processing' ? (downloading ? `tải ${downloadPct === null ? '…' : `${downloadPct}%`} · ` : `${take.progress}% · `) : ''}
        {formatDuration(elapsed)}
      </span>

      <span className={`rq-row-cost ${cost.kind}${cost.struck ? ' struck' : ''}`} title={`${cost.amount} · ${cost.note}`}>
        <span className="mono">{formatCredits(takeCostKnown(take), cost.kind, { short: true })}</span>
        {CREDIT_MARK[cost.kind] && <span className="rq-demo-mark">{CREDIT_MARK[cost.kind]}</span>}
      </span>

      <div className="rq-row-actions">
        {active && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => cancelTake(take.id)}
            title={
              downloading
                ? `Huỷ ${code} · T${take.number} — video đã tạo xong (đã trừ ${providerOf(take) === 'dev' ? 'credit dev' : 'credit'}), SanoVids hỏi trước khi bỏ`
                : `Huỷ ${code} · T${take.number}`
            }
          >
            <CircleStop size={13} />
            <span className="rq-act-label">Huỷ</span>
          </button>
        )}
        {ended && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={!scene} onClick={() => rerunTake(take.id)} title="Chạy lại cảnh này (xem chi phí trước khi gửi)">
            <RotateCcw size={13} />
            <span className="rq-act-label">Thử lại</span>
          </button>
        )}
        {take.status === 'completed' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={open} title="Xem take">
            <Eye size={13} />
            <span className="rq-act-label">Xem</span>
          </button>
        )}
        {take.status === 'completed' && (
          <button
            type="button"
            className="icon-btn rq-icon-sm rq-dl-icon"
            disabled={saving}
            onClick={() => void save()}
            title={`Tải video ${code}_T${take.number}`}
            aria-label={`Tải video ${code} T${take.number}`}
          >
            {saving ? <LoaderCircle size={14} className="rq-spin" /> : <Download size={14} />}
          </button>
        )}
        <button type="button" className="icon-btn rq-icon-sm" disabled={!scene} onClick={goto} title="Đi tới video này trên canvas" aria-label="Đi tới video trên canvas">
          <LocateFixed size={14} />
        </button>
        {ended && (
          <button
            type="button"
            className="icon-btn rq-icon-sm rq-x"
            onClick={() => deleteTakes([take.id])}
            title="Bỏ khỏi danh sách"
            aria-label={`Bỏ ${code} T${take.number} khỏi danh sách`}
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
})

/**
 * Is this take node visible in the canvas "Chỉ take chọn" mode? Same rule as the canvas: the scene's chosen take
 * (starred, else the newest completed, else the newest) plus every take used as a @video reference.
 */
function shownWhenChosenOnly(take: Take): boolean {
  if (useProject.getState().project.scenes.some((s) => s.videoRefs.includes(take.id))) return true
  const list = useRuns
    .getState()
    .takes.filter((t) => t.sceneId === take.sceneId)
    .sort((a, b) => b.number - a.number)
  const chosen = list.find((t) => t.starred) ?? list.find((t) => t.status === 'completed') ?? list[0]
  return chosen?.id === take.id
}

/**
 * "Đi tới": select the take (video) node and bring it into view on the canvas. When the canvas only shows the
 * chosen take of each scene and this one is hidden, go to its scene instead.
 */
function gotoTake(take: Take, scene: Scene | undefined) {
  if (!scene) return
  const ui = useUI.getState()
  const hidden = ui.takeDisplay === 'chosen' && !shownWhenChosenOnly(take)
  const target = hidden ? scene.id : take.id
  if (hidden) toast(`T${take.number} đang ẩn (canvas chỉ hiện take chọn) — đã đưa tới cảnh ${sceneCode(scene.order)}.`)
  ui.select([target])
  if (ui.view !== 'canvas') {
    ui.setView('canvas')
    // Let the canvas mount and measure its nodes first.
    window.setTimeout(() => focusNodes([target]), 150)
  } else focusNodes([target])
}

// ---------------------------------------------------------------------------------------------------------------------

/** When the queue drains, summarise the batch in a toast (useful while the drawer is collapsed). */
function useBatchDoneToast() {
  const active = useRuns((s) => {
    let n = 0
    for (const t of s.takes) if (t.status === 'queued' || t.status === 'processing') n++
    return n
  })
  const prev = useRef(0)
  const batchStart = useRef<number | null>(null)
  useEffect(() => {
    if (prev.current === 0 && active > 0) batchStart.current = Date.now() - 1000
    if (prev.current > 0 && active === 0 && batchStart.current) {
      const since = batchStart.current
      batchStart.current = null
      let done = 0
      let failed = 0
      for (const t of useRuns.getState().takes) {
        if (!t.finishedAt || t.finishedAt < since) continue
        if (t.status === 'completed') done++
        else if (t.status === 'failed') failed++
      }
      if (done || failed) {
        const queueOpen = useUI.getState().queueOpen
        toast(`Hàng đợi đã xong: ${done} take hoàn thành${failed ? `, ${failed} lỗi` : ''}.`, {
          tone: failed ? 'warning' : 'success',
          action: queueOpen ? undefined : { label: 'Xem', run: () => useUI.getState().setQueueOpen(true) },
        })
      }
    }
    prev.current = active
  }, [active])
}

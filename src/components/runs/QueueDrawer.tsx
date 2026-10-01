import { ChevronDown, ChevronUp, CircleStop, Coins, Eye, ListVideo, LocateFixed, RotateCcw, Settings2, Sparkles, Trash, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { focusNodes, runNow } from '../../actions'
import { sceneCode } from '../../core/compile'
import { MODELS, settingsLabel } from '../../core/models'
import type { Scene, Take } from '../../core/types'
import { deleteMedia } from '../../lib/imageStore'
import { useProject } from '../../store/project'
import { useRuns, type MockSpeed } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { MediaImg } from '../common/Media'
import { formatDuration, isActive, StatusBadge, takeElapsed, useNow } from './shared'
import './runs.css'

const SPEED_LABEL: Record<MockSpeed, string> = { fast: 'nhanh', normal: 'vừa', slow: 'chậm' }
const DONE_PAGE = 40

/** Queue docked at the bottom of the center area: a 36px bar that expands into the job list. */
export function QueueDrawer() {
  const open = useUI((s) => s.queueOpen)
  useBatchDoneToast()
  return (
    <section className={`rq-drawer${open ? ' open' : ''}`} aria-label="Hàng đợi">
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
  const credits = useRuns((s) => s.credits)
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
      <span className="rq-credit-pill" title="Credit demo — không phải tiền thật">
        <Coins size={13} />
        <b className="mono">{credits.toLocaleString('vi-VN')}</b> credit · demo
      </span>
      <span className="rq-chevron">{open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</span>
    </div>
  )
}

function Count({ n, label, tone }: { n: number; label: string; tone: Take['status'] }) {
  return (
    <span className={`rq-count${n ? '' : ' zero'}`}>
      <span className={`status-dot ${n ? tone : ''}`} />
      <b className="mono">{n}</b> {label}
    </span>
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
  const credits = useRuns((s) => s.credits)
  const spent = useRuns((s) => s.spent)
  const mock = useRuns((s) => s.mock)
  const scenes = useProject((s) => s.project.scenes)
  const sceneMap = useMemo(() => new Map(scenes.map((s) => [s.id, s])), [scenes])
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE)

  const groups = useMemo<Group[]>(() => {
    const newest = [...takes].sort((a, b) => b.createdAt - a.createdAt)
    const pick = (fn: (t: Take) => boolean) => newest.filter(fn)
    return [
      { key: 'processing', title: 'Đang tạo', takes: pick((t) => t.status === 'processing') },
      // Queue order: the next job to start is listed first.
      { key: 'queued', title: 'Đang chờ', takes: pick((t) => t.status === 'queued').reverse() },
      { key: 'failed', title: 'Lỗi / đã huỷ', takes: pick((t) => t.status === 'failed' || t.status === 'cancelled') },
      { key: 'completed', title: 'Hoàn thành', takes: pick((t) => t.status === 'completed') },
    ].filter((g) => g.takes.length)
  }, [takes])

  const clearable = useMemo(() => takes.filter((t) => t.status === 'failed' || t.status === 'cancelled'), [takes])

  const clearFailed = () => {
    const { removeTake } = useRuns.getState()
    for (const t of clearable) {
      removeTake(t.id)
      if (t.posterId) void deleteMedia(t.posterId)
      if (t.videoId) void deleteMedia(t.videoId)
    }
    toast(`Đã xoá ${clearable.length} job lỗi/đã huỷ khỏi danh sách.`, { tone: 'success' })
  }

  return (
    <div className="rq-panel">
      <div className="rq-panel-head">
        <span className="rq-wallet">
          Số dư <b className="mono">{credits.toLocaleString('vi-VN')}</b> credit
          <span className="faint"> · đã dùng </span>
          <b className="mono">{spent.toLocaleString('vi-VN')}</b>
        </span>
        <span className="rq-demo-note">
          <Sparkles size={12} /> Chế độ demo: video giả, không tốn tiền
        </span>
        <span className="rq-spacer" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => useUI.getState().openDialog({ kind: 'settings' })}
          title="Chỉnh tốc độ, tỉ lệ lỗi và số luồng của nhà cung cấp giả"
        >
          <Settings2 size={13} />
          Mock: {SPEED_LABEL[mock.speed]} · lỗi {Math.round(mock.failRate * 100)}% · {mock.concurrency} luồng
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!clearable.length} onClick={clearFailed} title="Xoá các job lỗi/đã huỷ khỏi danh sách">
          <Trash size={13} />
          Dọn job lỗi/đã huỷ{clearable.length ? ` (${clearable.length})` : ''}
        </button>
      </div>

      <div className="rq-list">
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
  const refunded = take.status === 'failed' || take.status === 'cancelled'
  const open = () => useUI.getState().openDialog({ kind: 'take', takeId: take.id })
  const goto = () => gotoTake(take, scene)

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
          <span style={{ color: MODELS[take.settings.model]?.color }}>{MODELS[take.settings.model]?.short ?? take.settings.model}</span>
          <span>{settingsLabel(take.settings)}</span>
          {take.status === 'failed' && take.error && <span className="rq-row-err">{take.error}</span>}
        </div>
      </div>

      <div className="rq-row-status">
        <StatusBadge take={take} showProgress={false} />
        {active && (
          <span className="progress">
            <i style={{ width: `${take.status === 'queued' ? 0 : take.progress}%` }} />
          </span>
        )}
      </div>

      <span className="rq-row-time mono" title={take.status === 'queued' ? 'Thời gian chờ' : 'Thời gian tạo'}>
        {take.status === 'processing' ? `${take.progress}% · ` : ''}
        {formatDuration(elapsed)}
      </span>

      <span className={`rq-row-cost mono${refunded ? ' refunded' : ''}`} title={refunded ? 'Đã hoàn credit' : 'Chi phí'}>
        {take.cost} cr
      </span>

      <div className="rq-row-actions">
        {active && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              useRuns.getState().cancel(take.id)
              toast(`Đã huỷ ${code} · T${take.number} · hoàn ${take.cost} credit.`)
            }}
          >
            <CircleStop size={13} />
            Huỷ
          </button>
        )}
        {refunded && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={!scene} onClick={() => runNow([take.sceneId])} title="Chạy lại cảnh này">
            <RotateCcw size={13} />
            Thử lại
          </button>
        )}
        {take.status === 'completed' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={open}>
            <Eye size={13} />
            Xem
          </button>
        )}
        <button type="button" className="icon-btn rq-icon-sm" disabled={!scene} onClick={goto} title="Đi tới video này trên canvas" aria-label="Đi tới video trên canvas">
          <LocateFixed size={14} />
        </button>
        {refunded && (
          <button
            type="button"
            className="icon-btn rq-icon-sm"
            onClick={() => useRuns.getState().removeTake(take.id)}
            title="Bỏ khỏi danh sách"
            aria-label="Bỏ khỏi danh sách"
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

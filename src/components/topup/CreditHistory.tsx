// "Lịch sử credit" tab of the top-up sheet — GET /api/credits/history through the canvasapp gateway (docs/SPEC-v2.md
// §10). Filters Tất cả / Nạp / Tạo video / Hoàn / Điều chỉnh, 20 rows per page with "Xem thêm", empty / error states.
// The parent (TopUpDialog) only mounts it when the gateway can be used (desktop bridge + logged in).
// Row texts and the paging state: topupModel.ts (historyRowView, historyReducer — pure, tested).
import { ArrowDownToLine, Clapperboard, Coins, LoaderCircle, LogIn, ReceiptText, RefreshCw, SlidersHorizontal, TriangleAlert, Undo2 } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { TOPUP_HISTORY_KIND_LABEL, TOPUP_HISTORY_KINDS, type TopupHistoryKind } from '../../core/topup'
import { activeGateway } from '../../providers'
import { CanvasappError, canvasappErrorText, type CreditHistoryItem, type CreditHistoryPage, type CreditHistoryQuery } from '../../providers/canvasapp/api'
import { HISTORY_INITIAL, HISTORY_PAGE_SIZE, historyEmptyText, historyReducer, historyRowView, type HistoryItemKind } from './topupModel'
import './topup.css'

export interface CreditHistoryProps {
  /** Change it to reload the first page of the current filter (e.g. after canvasapp confirmed a top-up). */
  reloadKey?: number | string
  /** Loads one page (default: the app's canvasapp client). Injectable for embedding / previews. */
  load?: (q: CreditHistoryQuery) => Promise<CreditHistoryPage>
  /** "Đăng nhập canvasapp" when canvasapp answers 401. Hidden when absent. */
  onLogin?: () => void
  /** The history is the simulated account's (development mode). Default: the active gateway's. */
  simulated?: boolean
}

const defaultLoad = (q: CreditHistoryQuery) => activeGateway().api.creditHistory(q)

const KIND_ICON: Record<HistoryItemKind, ReactNode> = {
  topup: <ArrowDownToLine size={15} />,
  video: <Clapperboard size={15} />,
  refund: <Undo2 size={15} />,
  adjustment: <SlidersHorizontal size={15} />,
  other: <Coins size={15} />,
}

export function CreditHistory({ reloadKey = 0, load = defaultLoad, onLogin, simulated }: CreditHistoryProps) {
  const [s, dispatch] = useReducer(historyReducer, HISTORY_INITIAL)
  const seq = useRef(0)
  const kindRef = useRef<TopupHistoryKind>(s.kind)
  kindRef.current = s.kind

  const fetchPage = useCallback(
    (kind: TopupHistoryKind, append: boolean, offset: number) => {
      const req = ++seq.current
      dispatch({ type: 'request', req, kind, append })
      load({ kind, offset, limit: HISTORY_PAGE_SIZE }).then(
        (page) => dispatch({ type: 'success', req, page, append }),
        (e: unknown) => dispatch({ type: 'failure', req, message: canvasappErrorText(e), code: e instanceof CanvasappError ? e.code : null, append }),
      )
    },
    [load],
  )

  // First page on mount and whenever reloadKey changes (same filter).
  useEffect(() => {
    fetchPage(kindRef.current, false, 0)
  }, [fetchPage, reloadKey])

  const choose = (kind: TopupHistoryKind) => {
    if (kind === s.kind && s.status !== 'error') return
    fetchPage(kind, false, 0)
  }
  const reload = () => fetchPage(s.kind, false, 0)
  const more = () => {
    if (s.nextOffset !== null && !s.loadingMore) fetchPage(s.kind, true, s.nextOffset)
  }

  // "Hôm nay / Hôm qua" relative to when the rows arrived (keeps the memoized rows stable between renders).
  const now = useMemo(() => Date.now(), [s.items])
  const loginNeeded = s.errorCode === 'login-required'

  return (
    <div className="tu-hist">
      <div className="tu-hist-head">
        <KindFilter value={s.kind} onChange={choose} />
        <button
          type="button"
          className="icon-btn"
          onClick={reload}
          disabled={s.status === 'loading'}
          title="Tải lại lịch sử credit"
          aria-label="Tải lại lịch sử credit"
        >
          {s.status === 'loading' ? <LoaderCircle size={15} className="tu-spin" /> : <RefreshCw size={15} />}
        </button>
      </div>

      {s.status === 'error' ? (
        <div className="tu-empty error" role="alert">
          <TriangleAlert size={22} />
          <b>Không tải được lịch sử credit</b>
          <span>{s.error}</span>
          <div className="tu-empty-actions">
            {loginNeeded && onLogin && (
              <button type="button" className="btn btn-sm btn-primary" onClick={onLogin}>
                <LogIn size={13} /> {(simulated ?? activeGateway().simulated) ? 'Đăng nhập (giả lập)' : 'Đăng nhập canvasapp'}
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={reload}>
              <RefreshCw size={13} /> Thử lại
            </button>
          </div>
        </div>
      ) : s.items.length === 0 ? (
        s.status === 'ok' ? (
          <div className="tu-empty">
            <ReceiptText size={22} />
            <b>{historyEmptyText(s.kind)}</b>
            <span>
              Các lần nạp, trừ credit khi tạo video, hoàn và điều chỉnh của tài khoản {activeGateway().simulated ? 'canvasapp giả lập (credit dev)' : 'canvasapp'} hiện ở đây.
            </span>
          </div>
        ) : (
          <div className="tu-empty loading" aria-busy="true">
            <LoaderCircle size={20} className="tu-spin" />
            <span>Đang tải lịch sử credit…</span>
          </div>
        )
      ) : (
        <>
          <ul className={`tu-hist-list${s.status === 'loading' ? ' stale' : ''}`} aria-busy={s.status === 'loading' || undefined}>
            {s.items.map((it, i) => (
              <HistoryRow key={i} item={it} now={now} />
            ))}
          </ul>
          {s.error && (
            <div className="tu-hist-more-error" role="alert">
              <TriangleAlert size={13} /> {s.error}
            </div>
          )}
          {s.nextOffset !== null && (
            <button type="button" className="btn btn-sm tu-hist-more" onClick={more} disabled={s.loadingMore || s.status === 'loading'}>
              {s.loadingMore ? <LoaderCircle size={13} className="tu-spin" /> : null} {s.loadingMore ? 'Đang tải…' : 'Xem thêm'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

const HistoryRow = memo(function HistoryRow({ item, now }: { item: CreditHistoryItem; now: number }) {
  const v = historyRowView(item, now)
  return (
    <li className="tu-hist-row">
      <span className={`tu-hist-icon ${v.kind}`} aria-hidden="true">
        {KIND_ICON[v.kind]}
      </span>
      <span className="tu-hist-main">
        <span className="tu-hist-title" title={v.title}>
          {v.title}
        </span>
        <span className="tu-hist-sub">
          {v.status && <span className={`tu-hist-status ${v.status.tone}`}>{v.status.label}</span>}
          <time title={v.time.title}>{v.time.text}</time>
        </span>
      </span>
      <span className="tu-hist-side">
        {v.delta && <b className={`tu-hist-delta ${v.delta.sign}`}>{v.delta.text}</b>}
        {v.amount && <small>{v.amount}</small>}
      </span>
    </li>
  )
})

function KindFilter({ value, onChange }: { value: TopupHistoryKind; onChange: (k: TopupHistoryKind) => void }) {
  const index = TOPUP_HISTORY_KINDS.indexOf(value)
  const style = { '--seg-n': TOPUP_HISTORY_KINDS.length, '--seg-i': Math.max(0, index) } as CSSProperties
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const n = TOPUP_HISTORY_KINDS.length
    const next = TOPUP_HISTORY_KINDS[(Math.max(0, index) + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]
    onChange(next)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-kind="${next}"]`)?.focus()
  }
  return (
    <div className="tu-seg sm" role="radiogroup" aria-label="Lọc lịch sử credit" style={style} onKeyDown={onKeyDown}>
      {TOPUP_HISTORY_KINDS.map((k) => {
        const on = k === value
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-kind={k}
            className={on ? 'active' : ''}
            onClick={() => onChange(k)}
          >
            {TOPUP_HISTORY_KIND_LABEL[k]}
          </button>
        )
      })}
    </div>
  )
}

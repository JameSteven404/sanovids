// "Cập nhật SanoVids": the new version (date, size, release notes as TEXT), the download progress, and the way to
// install it — restart now, "Cập nhật khi xong" while videos are still running, or later (installed on quit). A
// portable build only offers the download page. A version refused for its code signature is named in the head line
// (never "Bản mới"), without its notes, with how to check an installer's certificate before installing one by hand.
// Every text / button decision is in lib/updateModel dialogView (pure,
// tested); the commands are in updateActions. Lazy chunk (App.tsx 'updateDialog'). Styles: dialogs.css (dg-upd-).
import { CircleArrowUp, CircleCheck, CloudDownload, ExternalLink, LoaderCircle, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useStore } from 'zustand'
import { pendingDownloadCount } from '../../lib/downloads'
import {
  dialogView,
  formatBytes,
  formatPercent,
  formatReleaseDate,
  installBlockers,
  isSignatureError,
  KIND_LABEL,
  noteBlocks,
  type NoteBlock,
  type UpdateActionId,
} from '../../lib/updateModel'
import { useUpdatePrefs } from '../../lib/updatePrefs'
import { checkUpdates, downloadUpdate, openReleasePage, useUpdates } from '../../lib/updates'
import { UPDATE_RELEASES_PAGE_LABEL } from '../../lib/updateTypes'
import { useRestartWork } from '../../store/runs'
import { toast, useUI } from '../../store/ui'
import { installNow, setInstallWhenIdle, useInstallUi } from '../../updateActions'
import { Modal } from '../common/Modal'
import { topupFlow } from '../topup/appFlow'
import { isOrderInFlight } from '../topup/topupFlow'
import './dialogs.css'

/** Auto-downloads waiting for a folder permission live in lib/downloads (not a store): re-read while open. */
function usePendingDownloadCount(): number {
  const [n, setN] = useState(() => pendingDownloadCount())
  useEffect(() => {
    const id = window.setInterval(() => setN(pendingDownloadCount()), 1500)
    return () => window.clearInterval(id)
  }, [])
  return n
}

/** Work a restart would interrupt (E.3 lines). Queued takes of deleted scenes never start: not counted (store/runs). */
function useBlockers(): { lines: string[]; activeJobs: number } {
  const counts = useRestartWork()
  const pendingDownloads = usePendingDownloadCount()
  const topupInFlight = useStore(topupFlow.store, (s) => isOrderInFlight(s.phase))
  return { lines: installBlockers({ ...counts, pendingDownloads, topupInFlight }), activeJobs: counts.queued + counts.processing }
}

/** Whether the element scrolls (re-measured when `dep` changes or the element resizes). */
function useOverflows<T extends HTMLElement>(dep: unknown): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      setOver(false)
      return
    }
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dep])
  return [ref, over]
}

/** Buttons that start work: disabled while one of them runs. "Đóng" / "Để sau" stay usable. */
const WORK_ACTIONS = new Set<UpdateActionId>(['restart', 'installNow', 'installWhenIdle', 'cancelWait', 'download', 'openPage', 'retry'])

/** Release notes as text blocks: headings, list items (grouped in lists) and paragraphs. Never HTML. */
function Notes({ blocks }: { blocks: NoteBlock[] }) {
  const out: ReactNode[] = []
  let list: string[] = []
  const endList = () => {
    if (!list.length) return
    out.push(
      <ul key={`ul${out.length}`}>
        {list.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>,
    )
    list = []
  }
  blocks.forEach((b, i) => {
    if (b.kind === 'li') {
      list.push(b.text)
      return
    }
    endList()
    out.push(b.kind === 'h' ? <h4 key={i}>{b.text}</h4> : <p key={i}>{b.text}</p>)
  })
  endList()
  return <>{out}</>
}

export function UpdateDialog() {
  const close = () => useUI.getState().closeDialog()
  const state = useUpdates((s) => s.state)
  const autoDownload = useUpdatePrefs((s) => s.autoDownload)
  const installWhenIdle = useInstallUi((s) => s.installWhenIdle)
  const busy = useInstallUi((s) => s.busy)
  const blockers = useBlockers()
  const [acting, setActing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const view = dialogView(state, { blockers: blockers.lines, installWhenIdle, autoDownload, busy, activeJobs: blockers.activeJobs })
  const blocks = view.showNotes ? noteBlocks(state.notes) : []
  const date = formatReleaseDate(state.releaseDate)
  const [notesRef, notesScroll] = useOverflows<HTMLDivElement>(view.showNotes ? state.notes : null)
  // The primary button already opens the download page (portable): no second link to the same page.
  const pageInFooter = view.actions.some((a) => a.id === 'openPage')
  const actionKey = view.actions.map((a) => a.id).join(' ')

  const run = async (id: UpdateActionId) => {
    switch (id) {
      case 'restart':
      case 'installNow':
        await installNow()
        return
      case 'installWhenIdle':
        setInstallWhenIdle(true)
        close()
        return
      case 'cancelWait':
        setInstallWhenIdle(false)
        return
      case 'later':
      case 'close':
        close()
        return
      case 'openPage':
        await openReleasePage()
        return
      case 'download': {
        const res = await downloadUpdate()
        if (!res.ok) toast(res.message, { tone: 'error' })
        return
      }
      case 'retry': {
        const res = state.kind === 'installer' && state.version ? await downloadUpdate() : await checkUpdates()
        // A check / download error shows in the dialog itself; other refusals as a toast.
        if (!res.ok && (res.code === 'busy' || res.code === 'not-ready' || res.code === 'not-allowed' || res.code === 'bad-request')) toast(res.message, { tone: 'info' })
        return
      }
    }
  }

  const act = (id: UpdateActionId) => {
    if (!WORK_ACTIONS.has(id)) {
      void run(id)
      return
    }
    if (acting) return
    setActing(true)
    void run(id).finally(() => setActing(false))
  }

  // Installing (busy): every button is disabled (spec). A running action only blocks the other work buttons, with
  // aria-disabled so the focused button keeps the focus.
  const disabled = !!busy

  // A footer that changed (download started, retry done, wait cancelled) or got disabled drops the focus to <body>:
  // give it back to the dialog's first usable button, so keyboard / screen-reader users keep their place.
  useEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const dialog = rootRef.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const target =
      dialog.querySelector<HTMLElement>('.modal-foot .btn-primary:not(:disabled)') ?? dialog.querySelector<HTMLElement>('.modal-foot button:not(:disabled)') ?? dialog
    target.focus({ preventScroll: true })
  }, [actionKey, disabled])
  const good = state.status === 'ready' || state.status === 'none'
  const icon =
    state.status === 'downloading' ? (
      <CloudDownload size={18} />
    ) : good ? (
      <CircleCheck size={18} />
    ) : state.status === 'error' && isSignatureError(state.error) ? (
      <ShieldAlert size={18} />
    ) : state.status === 'error' ? (
      <TriangleAlert size={18} />
    ) : (
      <CircleArrowUp size={18} />
    )

  return (
    <Modal
      title="Cập nhật SanoVids"
      size="normal"
      onClose={close}
      headerExtra={<span className="badge">{KIND_LABEL[state.kind]}</span>}
      footer={view.actions.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`btn dg-upd-btn${a.primary ? ' btn-primary' : ''}`}
          disabled={disabled}
          aria-disabled={!disabled && acting && WORK_ACTIONS.has(a.id) ? true : undefined}
          title={a.title}
          onClick={() => {
            if (acting && WORK_ACTIONS.has(a.id)) return
            act(a.id)
          }}
        >
          {a.primary && view.busyText ? (
            <>
              <LoaderCircle size={14} className="dg-spin" /> {view.busyText}
            </>
          ) : (
            a.label
          )}
        </button>
      ))}
    >
      <div className="dg-upd" aria-busy={!!busy} ref={rootRef}>
        <div className="dg-upd-head">
          <span className={`dg-app-icon${good ? ' on' : ''}`} aria-hidden="true">
            {icon}
          </span>
          <div className="dg-upd-lines">
            {view.headline ? (
              <b>{view.headline}</b>
            ) : (
              view.showNotes &&
              state.version && (
                <b>
                  Bản mới: {state.version}
                  {date && ` · phát hành ${date}`}
                </b>
              )
            )}
            <span>Đang dùng: {state.current || '—'}</span>
            {/* The portable exe is downloaded whole from the release page: no installer size / partial download there. */}
            {view.showNotes && state.kind === 'installer' && state.size ? <small>Dung lượng tối đa: {formatBytes(state.size)} (thường ít hơn vì chỉ tải phần thay đổi)</small> : null}
          </div>
        </div>

        {/* Announced on status changes only: the download line changes every 500 ms (the progress bar carries it). */}
        <p className="dg-upd-status" role={view.showProgress ? undefined : 'status'}>
          {view.statusText}
        </p>
        {view.showProgress && (
          <div className="dg-upd-progress">
            <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(state.percent ?? 0)} aria-label="Tiến độ tải bản cập nhật">
              <i style={{ width: formatPercent(state.percent) }} />
            </span>
          </div>
        )}
        {view.hint && <p className="dg-field-hint">{view.hint}</p>}
        {view.callout && (
          <div className="dg-callout warn">
            <TriangleAlert size={15} />
            <div>
              <b>{view.callout.title}</b>
              {view.callout.lines.length > 0 && (
                <ul className="dg-upd-callout-list">
                  {view.callout.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
              {view.callout.code && <p className="mono dg-upd-callout-code">{view.callout.code}</p>}
              {view.callout.note && <p className="dg-upd-callout-note">{view.callout.note}</p>}
            </div>
          </div>
        )}

        {view.showNotes && (
          <section className="dg-upd-notes-wrap" aria-label="Có gì mới">
            <h3 className="section-title">Có gì mới</h3>
            {/* A tab stop only when it scrolls (keyboard scrolling). */}
            <div className="dg-upd-notes" ref={notesRef} tabIndex={notesScroll ? 0 : undefined}>
              {blocks.length ? <Notes blocks={blocks} /> : <p className="dg-upd-empty">Chưa có ghi chú cho bản này.</p>}
            </div>
          </section>
        )}
        {state.kind !== 'dev' && !pageInFooter && (
          <button type="button" className="btn btn-sm btn-ghost dg-upd-link" onClick={() => act('openPage')} disabled={acting} title={`Mở trang tải về (${UPDATE_RELEASES_PAGE_LABEL}) trong trình duyệt`}>
            <ExternalLink size={13} /> Xem trang tải về
          </button>
        )}
      </div>
    </Modal>
  )
}

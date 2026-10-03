// "Cập nhật SanoVids": the new version (date, size, release notes as TEXT), the download progress, and the way to
// install it — restart now, "Cập nhật khi xong" while videos are still running, or later (installed on quit). A
// portable build only offers the download page. Every text / button decision is in lib/updateModel dialogView (pure,
// tested); the commands are in updateActions. Lazy chunk (App.tsx 'updateDialog'). Styles: dialogs.css (dg-upd-).
import { CircleArrowUp, CircleCheck, CloudDownload, ExternalLink, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { pendingDownloadCount } from '../../lib/downloads'
import {
  dialogView,
  formatBytes,
  formatPercent,
  formatReleaseDate,
  installBlockers,
  KIND_LABEL,
  noteBlocks,
  type NoteBlock,
  type UpdateActionId,
} from '../../lib/updateModel'
import { useUpdatePrefs } from '../../lib/updatePrefs'
import { checkUpdates, downloadUpdate, openReleasePage, useUpdates } from '../../lib/updates'
import { UPDATE_RELEASES_PAGE_LABEL } from '../../lib/updateTypes'
import { isSendingTake, useRuns } from '../../store/runs'
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

/** Work a restart would interrupt (E.3 lines). */
function useBlockers(): { lines: string[]; activeJobs: number } {
  const counts = useRuns(
    useShallow((s) => {
      let queued = 0
      let processing = 0
      let sending = 0
      for (const t of s.takes) {
        if (t.status === 'queued') queued++
        else if (t.status === 'processing') {
          processing++
          if (isSendingTake(t)) sending++
        }
      }
      return { queued, processing, sending }
    }),
  )
  const pendingDownloads = usePendingDownloadCount()
  const topupInFlight = useStore(topupFlow.store, (s) => isOrderInFlight(s.phase))
  return { lines: installBlockers({ ...counts, pendingDownloads, topupInFlight }), activeJobs: counts.queued + counts.processing }
}

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
  const view = dialogView(state, { blockers: blockers.lines, installWhenIdle, autoDownload, busy, activeJobs: blockers.activeJobs })
  const blocks = view.showNotes ? noteBlocks(state.notes) : []
  const date = formatReleaseDate(state.releaseDate)

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
    if (acting) return
    setActing(true)
    void run(id).finally(() => setActing(false))
  }

  const disabled = !!busy || acting
  const good = state.status === 'ready' || state.status === 'none'
  const icon =
    state.status === 'downloading' ? (
      <CloudDownload size={18} />
    ) : good ? (
      <CircleCheck size={18} />
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
          className={`btn${a.primary ? ' btn-primary' : ''}`}
          disabled={disabled}
          title={a.title}
          onClick={() => act(a.id)}
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
      <div className="dg-upd" aria-busy={!!busy}>
        <div className="dg-upd-head">
          <span className={`dg-app-icon${good ? ' on' : ''}`} aria-hidden="true">
            {icon}
          </span>
          <div className="dg-upd-lines">
            {view.showNotes && state.version && (
              <b>
                Bản mới: {state.version}
                {date && ` · phát hành ${date}`}
              </b>
            )}
            <span>Đang dùng: {state.current || '—'}</span>
            {/* The portable exe is downloaded whole from the release page: no installer size / partial download there. */}
            {view.showNotes && state.kind === 'installer' && state.size ? <small>Dung lượng tối đa: {formatBytes(state.size)} (thường ít hơn vì chỉ tải phần thay đổi)</small> : null}
          </div>
        </div>

        <p className="dg-upd-status" role="status">
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
              <ul className="dg-upd-callout-list">
                {view.callout.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {view.showNotes && (
          <section className="dg-upd-notes-wrap" aria-label="Có gì mới">
            <h3 className="section-title">Có gì mới</h3>
            <div className="dg-upd-notes" tabIndex={0}>
              {blocks.length ? <Notes blocks={blocks} /> : <p className="dg-upd-empty">Chưa có ghi chú cho bản này.</p>}
            </div>
          </section>
        )}
        {state.kind !== 'dev' && (
          <button type="button" className="btn btn-sm btn-ghost dg-upd-link" onClick={() => act('openPage')} disabled={acting} title={`Mở trang tải về (${UPDATE_RELEASES_PAGE_LABEL}) trong trình duyệt`}>
            <ExternalLink size={13} /> Xem trang tải về
          </button>
        )}
      </div>
    </Modal>
  )
}

// "Nhập job từ canvasapp" — jobs the user made on canvasapp's own page (bridge session "SanoVids bridge") become takes
// of the open project (siteJobActions; rules in providers/canvasapp/siteJobs.ts, texts in importJobsModel.ts).
// Read-only toward canvasapp: nothing here can bill anything. Opened from the queue drawer, Settings › Nhà cung cấp
// video and the Bảng phát triển (`back` = the dialog shown again when this one closes).
import { CloudDownload, LoaderCircle, LogIn, RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { canvasappErrorText, isLoginRequired } from '../../providers/canvasapp/api'
import type { Scene } from '../../core/types'
import { useProject } from '../../store/project'
import { useUI, type DialogState } from '../../store/ui'
import { importGateway, importSiteJobs, pendingTakeLabel, scanForImport, type ImportScan } from '../../siteJobActions'
import { Modal } from '../common/Modal'
import { useLive } from '../common/useLive'
import { loginToCanvasapp } from '../topbar/CreditPill'
import {
  candidateSettingsText,
  candidateStatusText,
  candidateTimeText,
  capNote,
  defaultPicks,
  emptyText,
  footNote,
  groupByScene,
  importButtonText,
  importLead,
  importTitle,
  importWords,
  jobNameTitle,
  LOADING_TEXT,
  loginButtonText,
  noBridgeText,
  reimportTitle,
  skipLines,
} from './importJobsModel'
import './runs.css'

export type Phase = { kind: 'loading' } | { kind: 'error'; message: string; login: boolean } | { kind: 'ready'; data: ImportScan }

export function ImportJobsDialog({ back, provider }: { back?: DialogState; provider?: 'dev' | 'canvasapp' }) {
  const close = useCallback(() => {
    const ui = useUI.getState()
    if (back) ui.openDialog(back)
    else ui.closeDialog()
  }, [back])
  const scenes = useProject((s) => s.project.scenes)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<'import' | 'login' | null>(null)
  // answers arriving after the dialog closed are dropped (set again by StrictMode's second mount: useLive)
  const live = useLive()
  // the gateway's words before the first scan answers
  const words = importWords(phase.kind === 'ready' ? phase.data.simulated : importGateway(provider).simulated)

  const scan = useCallback(async () => {
    setPhase({ kind: 'loading' })
    try {
      const data = await scanForImport(provider)
      if (!live.current) return
      setPhase({ kind: 'ready', data })
      setPicked(new Set(defaultPicks(data.scan.candidates)))
    } catch (e) {
      if (!live.current) return
      setPhase({ kind: 'error', message: canvasappErrorText(e), login: isLoginRequired(e) })
    }
  }, [provider])
  useEffect(() => {
    void scan()
  }, [scan])

  const login = async () => {
    if (busy) return
    setBusy('login')
    try {
      if (await loginToCanvasapp(importGateway(provider))) await scan()
    } finally {
      if (live.current) setBusy(null)
    }
  }

  const ready = phase.kind === 'ready' ? phase.data : null
  const cap = capNote(picked.size)

  const toggle = (jobId: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })

  const run = async () => {
    if (!ready || busy || !picked.size || cap) return
    setBusy('import')
    try {
      const res = await importSiteJobs(ready, [...picked])
      if (!live.current) return
      if (res?.takeIds.length) close()
      else await scan()
    } catch (e) {
      if (!live.current) return
      setPhase({ kind: 'error', message: canvasappErrorText(e), login: isLoginRequired(e) })
    } finally {
      if (live.current) setBusy(null)
    }
  }

  return (
    <Modal
      title={
        <span className="rq-imp-title">
          <CloudDownload size={17} /> {importTitle(words)}
        </span>
      }
      size="wide"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={() => void scan()} disabled={phase.kind === 'loading' || !!busy} title="Đọc lại danh sách job (chỉ đọc)">
            <RefreshCw size={14} /> Quét lại
          </button>
          <span className="rq-spacer" />
          <button type="button" className="btn" onClick={close}>
            Đóng
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready || !picked.size || !!cap || !!busy} onClick={() => void run()}>
            {busy === 'import' ? <LoaderCircle size={14} className="rq-spin" /> : <CloudDownload size={14} />}
            {importButtonText(picked.size, busy === 'import')}
          </button>
        </>
      }
    >
      <ImportJobsBody
        simulated={words.simulated}
        phase={phase}
        scenes={scenes}
        picked={picked}
        busy={busy}
        onToggle={toggle}
        onLogin={() => void login()}
        onRetry={() => void scan()}
      />
    </Modal>
  )
}

export interface ImportJobsBodyProps {
  /** Development mode's words until the scan answers (then the scan's own). */
  simulated: boolean
  phase: Phase
  scenes: readonly Pick<Scene, 'id' | 'order' | 'title'>[]
  picked: ReadonlySet<string>
  busy: 'import' | 'login' | null
  onToggle: (jobId: string) => void
  onLogin: () => void
  onRetry: () => void
}

/** What the dialog shows (no state of its own: rendered as is in __tests__/importJobsRender.test.ts). */
export function ImportJobsBody({ simulated, phase, scenes, picked, busy, onToggle, onLogin, onRetry }: ImportJobsBodyProps) {
  const ready = phase.kind === 'ready' ? phase.data : null
  const words = importWords(ready ? ready.simulated : simulated)
  const groups = useMemo(() => (ready ? groupByScene(ready.scan.candidates, scenes) : []), [ready, scenes])
  const skips = useMemo(() => (ready ? skipLines(ready.scan, importWords(ready.simulated), pendingTakeLabel) : []), [ready])
  const skippedCount = ready?.scan.skipped.length ?? 0
  const cap = capNote(picked.size)
  return (
      <div className="rq-imp">
        <p className="rq-imp-lead">{importLead(words)}</p>

        {phase.kind === 'loading' && (
          <div className="rq-imp-state" role="status">
            <LoaderCircle size={16} className="rq-spin" /> {LOADING_TEXT}
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="rq-imp-state warn" role="alert">
            <TriangleAlert size={16} />
            <span className="rq-imp-state-text">{phase.message}</span>
            {phase.login ? (
              <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={onLogin}>
                {busy === 'login' ? <LoaderCircle size={13} className="rq-spin" /> : <LogIn size={13} />} {loginButtonText(words)}
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                <RefreshCw size={13} /> Thử lại
              </button>
            )}
          </div>
        )}

        {ready && !ready.scan.projectId && <div className="rq-imp-state">{noBridgeText(words)}</div>}
        {ready && ready.scan.projectId && !groups.length && <div className="rq-imp-state">{emptyText(words)}</div>}

        {groups.map((g) => (
          <section key={g.sceneId} className="rq-imp-group" aria-label={g.heading}>
            <h4 className="rq-imp-group-head">{g.heading}</h4>
            {g.items.map((c) => (
              <label key={c.jobId} className={`rq-imp-row${picked.has(c.jobId) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.has(c.jobId)} onChange={() => onToggle(c.jobId)} disabled={!!busy} />
                <span className={`rq-badge ${c.state}`}>{candidateStatusText(c)}</span>
                <span className="rq-imp-settings">{candidateSettingsText(c)}</span>
                <span className="rq-imp-meta faint">{candidateTimeText(c)}</span>
                {c.jobName && (
                  <span className="rq-imp-name faint" title={jobNameTitle(c.jobName)}>
                    {c.jobName}
                  </span>
                )}
                {c.reimport && (
                  <span className="rq-imp-again" title={reimportTitle(words)}>
                    đã nhập trước
                  </span>
                )}
              </label>
            ))}
          </section>
        ))}

        {cap && (
          <div className="rq-imp-state warn" role="status">
            <TriangleAlert size={15} /> {cap}
          </div>
        )}

        {skippedCount > 0 && (
          <details className="rq-imp-skip">
            <summary>Không nhập được ({skippedCount})</summary>
            <ul>
              {skips.map((s) => (
                <li key={s.code}>{s.text}</li>
              ))}
            </ul>
          </details>
        )}

        <p className="rq-imp-foot faint">{footNote(words)}</p>
      </div>
  )
}

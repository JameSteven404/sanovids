// "Test giới hạn" tab of the developer panel. Development mode only: everything runs on a temporary project with a
// private simulated server; the user's project is put back at the end. Wiring into DevPanel is done outside this
// folder (see index.ts).
import { memo, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Play, Square, RotateCcw, Download, Copy, Save, Trash2, ShieldCheck, CircleAlert, CircleCheck, TriangleAlert, LoaderCircle } from 'lucide-react'
import { SCENARIOS, NOT_IMPLEMENTED } from './scenarios'
import { TIER_LABEL } from './synth'
import { startBlockedReason, lastReportSummary, leftover } from './sandbox'
import { useStress, startStress, stopStress, downloadReport, downloadFailureProject, copySummary, cleanup } from './store'
import { summaryText } from './report'
import type { FaultLevel, ScenarioGroup, StressReport, Tier } from './types'
import './stress.css'

const GROUP_LABEL: Record<ScenarioGroup, string> = {
  A: 'A · Dữ liệu cực lớn / dị dạng',
  B: 'B · Hàng đợi & lỗi mạng',
  C: 'C · Thao tác lặp lại lâu',
  D: 'D · Ngẫu nhiên tổng hợp',
}
const TIERS: Tier[] = ['S', 'M', 'L', 'XL', 'XXL', 'OVER']
const FAULT_LABEL: Record<FaultLevel, string> = { none: 'Không', sometimes: 'Thỉnh thoảng', storm: 'Bão lỗi' }
const RESULT_LABEL: Record<StressReport['result'], string> = {
  pass: 'Đạt',
  fail: 'Có lỗi',
  stopped: 'Đã dừng',
  'harness-error': 'Lỗi của bộ test',
}

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} ph ${Math.round((ms % 60_000) / 1000)} s`)

function ScenarioPicker({ disabled }: { disabled: boolean }) {
  const selected = useStress(useShallow((s) => s.scenarios))
  const toggle = (id: string) => {
    const cur = useStress.getState().scenarios
    useStress.getState().setForm({ scenarios: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  }
  const groups = useMemo(() => (['A', 'B', 'C', 'D'] as ScenarioGroup[]).map((g) => ({ g, list: SCENARIOS.filter((s) => s.group === g) })), [])
  return (
    <div className="dv-stress-scenarios">
      {groups.map(({ g, list }) => (
        <div key={g} className="dv-stress-group">
          <div className="dv-stress-group-title">{GROUP_LABEL[g]}</div>
          {list.map((s) => (
            <label key={s.id} className={`dv-stress-scn${s.app ? '' : ' off'}`} title={s.app ? s.hint : `${s.hint} — chỉ chạy trong bộ test dòng lệnh`}>
              <input type="checkbox" checked={selected.includes(s.id)} disabled={disabled || !s.app} onChange={() => toggle(s.id)} />
              <span className="dv-stress-scn-name">{s.label}</span>
              <span className="dv-stress-scn-meta">
                {s.tier} · ~{s.minutes} ph
              </span>
            </label>
          ))}
        </div>
      ))}
      <div className="dv-stress-note">Chưa có: {NOT_IMPLEMENTED.join(' ')}</div>
    </div>
  )
}

function Fields({ disabled }: { disabled: boolean }) {
  const f = useStress(useShallow((s) => ({ tier: s.tier, steps: s.steps, minutes: s.minutes, seed: s.seed, faults: s.faults, checkEvery: s.checkEvery, stopOnFirst: s.stopOnFirst })))
  const set = useStress.getState().setForm
  const num = (v: string, min: number) => Math.max(min, Number.parseInt(v, 10) || 0)
  return (
    <div className="dv-stress-fields">
      <label>
        <span>Cỡ dự án</span>
        <select className="select" value={f.tier} disabled={disabled} onChange={(e) => set({ tier: e.target.value as Tier | 'auto' })}>
          <option value="auto">Theo kịch bản</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {TIER_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Số bước</span>
        <input className="input" type="number" min={0} value={f.steps} disabled={disabled} onChange={(e) => set({ steps: num(e.target.value, 0) })} title="0 = chạy tới khi bấm Dừng / hết thời gian" />
      </label>
      <label>
        <span>Thời gian tối đa (phút)</span>
        <input className="input" type="number" min={0} value={f.minutes} disabled={disabled} onChange={(e) => set({ minutes: num(e.target.value, 0) })} title="0 = không giới hạn" />
      </label>
      <label>
        <span>Seed</span>
        <input className="input dv-stress-mono" value={f.seed} placeholder="ngẫu nhiên" disabled={disabled} onChange={(e) => set({ seed: e.target.value.trim() })} />
      </label>
      <label>
        <span>Lỗi mạng</span>
        <select className="select" value={f.faults} disabled={disabled} onChange={(e) => set({ faults: e.target.value as FaultLevel | 'auto' })}>
          <option value="auto">Theo kịch bản</option>
          {(Object.keys(FAULT_LABEL) as FaultLevel[]).map((k) => (
            <option key={k} value={k}>
              {FAULT_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Kiểm tra mỗi N bước</span>
        <input className="input" type="number" min={1} value={f.checkEvery} disabled={disabled} onChange={(e) => set({ checkEvery: num(e.target.value, 1) })} />
      </label>
      <label className="dv-stress-check">
        <input type="checkbox" checked={f.stopOnFirst} disabled={disabled} onChange={(e) => set({ stopOnFirst: e.target.checked })} />
        <span>Dừng ở lỗi đầu tiên</span>
      </label>
    </div>
  )
}

function Progress() {
  const p = useStress((s) => s.progress)
  const phase = useStress((s) => s.phase)
  const phaseText = useStress((s) => s.phaseText)
  if (phase === 'idle') return null
  const pct = p && p.steps > 0 ? Math.min(100, (p.step / p.steps) * 100) : 0
  return (
    <div className="dv-stress-progress">
      <div className="dv-stress-progress-head">
        <LoaderCircle size={14} className="dv-stress-spin" />
        <span>{phase === 'running' ? 'Đang chạy' : phase === 'stopping' ? 'Đang dừng…' : phaseText || 'Đang trả lại dự án của bạn…'}</span>
        {p && (
          <span className="dv-stress-dim">
            bước {p.step}
            {p.steps > 0 ? `/${p.steps}` : ''} · {fmtMs(p.elapsedMs)} · {p.action}
          </span>
        )}
      </div>
      <div className="progress">
        <i style={{ width: `${pct}%` }} />
      </div>
      {p && (
        <div className="dv-stress-counters">
          <span className={`badge${p.errors ? ' danger' : ''}`}>{p.errors} lỗi</span>
          <span className={`badge${p.warnings ? ' warn' : ''}`}>{p.warnings} cảnh báo</span>
          <span className="badge">
            video: {p.takes.queued} chờ · {p.takes.processing} đang tạo · {p.takes.completed} xong · {p.takes.failed} lỗi · {p.takes.cancelled} huỷ
          </span>
        </div>
      )}
    </div>
  )
}

function ReportView({ report }: { report: StressReport }) {
  const hasSnap = useStress((s) => s.hasFailureSnapshot)
  const [copied, setCopied] = useState<boolean | null>(null)
  const slow = useMemo(
    () =>
      Object.entries(report.metrics.perAction)
        .sort((a, b) => b[1].p95 - a[1].p95)
        .slice(0, 8),
    [report],
  )
  const Icon = report.result === 'pass' ? CircleCheck : report.result === 'stopped' ? TriangleAlert : CircleAlert
  return (
    <div className={`dv-stress-report ${report.result}`}>
      <div className="dv-stress-report-head">
        <Icon size={16} />
        <b>{RESULT_LABEL[report.result]}</b>
        <span className="dv-stress-dim">
          seed <code className="dv-stress-mono">{report.seed}</code> · {report.steps} bước · {fmtMs(report.durationMs)} · {report.server.jobs} video giả lập
        </span>
      </div>
      {report.failure && (
        <div className="dv-stress-failure">
          <div>
            <b>[{report.failure.invariant}]</b> {report.failure.message}
          </div>
          <div className="dv-stress-dim">
            Bước {report.failure.step}: <code className="dv-stress-mono">{report.failure.action}</code> · nguồn: {report.failure.kind === 'app' ? 'ứng dụng' : report.failure.kind === 'simulator' ? 'máy chủ giả lập' : 'bộ test'}
          </div>
        </div>
      )}
      {report.warnings.length > 0 && (
        <ul className="dv-stress-warnings">
          {report.warnings.map((w) => (
            <li key={w.invariant + w.firstStep}>
              <span className="badge warn">{w.invariant}</span> ×{w.count} (từ bước {w.firstStep}) — {w.message}
            </li>
          ))}
        </ul>
      )}
      {slow.length > 0 && (
        <table className="dv-stress-table">
          <thead>
            <tr>
              <th>Thao tác chậm nhất</th>
              <th>Số lần</th>
              <th>p50</th>
              <th>p95</th>
              <th>max</th>
            </tr>
          </thead>
          <tbody>
            {slow.map(([id, s]) => (
              <tr key={id}>
                <td className="dv-stress-mono">{id}</td>
                <td>{s.n}</td>
                <td>{fmtMs(s.p50)}</td>
                <td>{fmtMs(s.p95)}</td>
                <td>{fmtMs(s.max)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.notes.length > 0 && (
        <ul className="dv-stress-notes">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <div className="dv-stress-actions">
        <button className="btn btn-sm" onClick={() => downloadReport('json')}>
          <Download size={14} /> Tải báo cáo (.json)
        </button>
        <button className="btn btn-sm" onClick={() => downloadReport('md')}>
          <Download size={14} /> Tải .md
        </button>
        <button className="btn btn-sm" onClick={() => void copySummary().then(setCopied)}>
          <Copy size={14} /> {copied === true ? 'Đã copy' : copied === false ? 'Không copy được' : 'Copy tóm tắt'}
        </button>
        {hasSnap && (
          <button className="btn btn-sm" onClick={downloadFailureProject}>
            <Save size={14} /> Lưu dự án lỗi
          </button>
        )}
      </div>
    </div>
  )
}

function StressTabImpl() {
  const phase = useStress((s) => s.phase)
  const error = useStress((s) => s.error)
  const report = useStress((s) => s.report)
  const nothingPicked = useStress((s) => s.scenarios.length === 0)
  const [cleanMsg, setCleanMsg] = useState('')
  const running = phase !== 'idle'
  const blocked = running ? null : startBlockedReason()
  const last = useMemo(() => (report || running ? null : lastReportSummary()), [report, running])
  const stale = running ? null : leftover()

  return (
    <div className="dv-stress">
      <div className="dv-stress-intro">Đẩy mọi thứ vượt giới hạn trên một dự án thử nghiệm — dự án của bạn không bị đụng tới.</div>
      <div className="dv-stress-chips">
        <span className="chip">
          <ShieldCheck size={12} /> Chỉ máy chủ giả lập
        </span>
        <span className="chip">
          <ShieldCheck size={12} /> Không gửi mạng
        </span>
        <span className="chip">
          <ShieldCheck size={12} /> Dự án tạm, xoá khi xong
        </span>
        <span className="chip">
          <ShieldCheck size={12} /> Không đụng thư mục thật
        </span>
      </div>

      <ScenarioPicker disabled={running} />
      <Fields disabled={running} />

      <div className="dv-stress-actions">
        {!running ? (
          <>
            <button className="btn btn-primary" disabled={!!blocked || nothingPicked} onClick={() => void startStress()} title={blocked ?? undefined}>
              <Play size={14} /> Bắt đầu
            </button>
            <button className="btn" disabled={!!blocked || !report} onClick={() => void startStress({ sameSeed: true })}>
              <RotateCcw size={14} /> Chạy lại seed này
            </button>
          </>
        ) : (
          <button className="btn" disabled={phase !== 'running'} onClick={stopStress}>
            <Square size={14} /> Dừng
          </button>
        )}
        <button
          className="btn btn-sm"
          disabled={running}
          onClick={() => void cleanup().then(setCleanMsg)}
          title="Xoá dự án tạm / dữ liệu còn sót nếu một lần chạy bị ngắt giữa chừng"
        >
          <Trash2 size={14} /> Dọn dữ liệu thử nghiệm
        </button>
      </div>

      {blocked && <div className="dv-stress-blocked">{blocked}</div>}
      {stale && <div className="dv-stress-blocked">Một lần chạy trước bị ngắt giữa chừng — bấm “Dọn dữ liệu thử nghiệm”.</div>}
      {error && <div className="dv-stress-blocked">{error}</div>}
      {cleanMsg && <div className="dv-stress-dim">{cleanMsg}</div>}

      <Progress />
      {report && !running && <ReportView report={report} />}
      {!report && last && (
        <div className="dv-stress-last">
          <div className="section-title">Lần chạy trước</div>
          <pre className="dv-stress-mono">{last.summary}</pre>
        </div>
      )}
    </div>
  )
}

/** Tab body (no props). Lazy-load it from DevPanel: `lazy(() => import('../devtools/stress').then(m => ({ default: m.StressTab })))`. */
export const StressTab = memo(StressTabImpl)
export default StressTab

/** Re-exported so callers can show a one-line result without importing report.ts. */
export { summaryText }

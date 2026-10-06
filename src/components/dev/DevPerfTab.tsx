import { useRef, useState } from 'react'
import { harness } from '../../perf/runner'
import type { PerfReport } from '../../perf/report'
import type { PerfSize } from '../../perf/synth'

export function DevPerfTab() {
  const [size, setSize] = useState<PerfSize | 'custom'>('L')
  const [scenes, setScenes] = useState(600), [takes, setTakes] = useState(1200)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [report, setReport] = useState<PerfReport | null>(() => harness.report())
  const previous = useRef<PerfReport | null>(harness.previousReport())
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setMessage('Đang thực hiện…')
    try { await action(); setMessage('Đã xong.') }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  function download() {
    if (!report) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = `sanovids-perf-${report.size}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="dv-perf" aria-label="Hiệu năng">
    <h3>Đo hiệu năng với dự án thử nghiệm</h3>
    <p>Bản perf · dữ liệu cách ly. Các bài đo khung sửa trên thẻ chờ giao diện E2. Kết quả web chỉ để kiểm nhanh.</p>
    <div className="dv-perf-controls">
      <label>Cỡ dự án <select className="select" value={size} disabled={busy} onChange={(e) => setSize(e.target.value as typeof size)}>
        <option value="M">Vừa · 300 cảnh · 600 video</option>
        <option value="L">Lớn · 600 cảnh · 1.200 video</option>
        <option value="XL">Rất lớn · 1.000 cảnh · 3.000 video</option>
        <option value="custom">Tuỳ chỉnh…</option>
      </select></label>
      {size === 'custom' && <>
        <label>Cảnh <input className="input" type="number" min={1} max={2000} value={scenes} disabled={busy} onChange={(e) => setScenes(e.target.valueAsNumber)} /></label>
        <label>Video <input className="input" type="number" min={scenes} max={6000} value={takes} disabled={busy} onChange={(e) => setTakes(e.target.valueAsNumber)} /></label>
      </>}
      <button className="btn" disabled={busy} onClick={() => void act(() => harness.create(size === 'custom' ? { scenes, takes } : size))}>Tạo dự án thử nghiệm</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => void act(async () => {
        previous.current = report; setReport(await harness.run())
      })}>Chạy tất cả bài đo</button>
      <button className="btn" disabled={!busy} onClick={() => harness.stop()}>Dừng</button>
      <button className="btn" disabled={!report || busy} onClick={download}>Tải kết quả (.json)</button>
      <button className="btn" disabled={!previous.current || !report || busy} onClick={() => {
        try {
          const changes = harness.compare(previous.current!, report!)
          setMessage(changes.length ? changes.map((r) => `${r.id}: ${r.label}${r.percent === null ? '' : ` ${r.percent.toFixed(0)}%`}`).join('; ') : 'Không có bài đo chậm hơn quá 15%.')
        } catch (error) { setMessage(String(error)) }
      }}>So với lần trước</button>
      <button className="btn" disabled={busy} onClick={() => void act(() => harness.cleanup())}>Dọn dữ liệu thử nghiệm</button>
    </div>
    <p role="status" aria-live="polite">{message}</p>
    {report && <table className="dv-perf-results">
      <caption>Kết quả {report.size} · {report.runs} lượt · {report.complete ? 'Đã đo xong các bài khả dụng' : 'Chưa đo đủ'} · thời gian làm việc, không gồm paint</caption>
      <thead><tr><th>Bài đo</th><th>Trung vị</th><th>p95</th><th>Ngân sách</th><th>Kết quả</th></tr></thead>
      <tbody>{report.results.map((r) => <tr key={r.id}>
        <th scope="row">{r.label}{r.estimated ? ' · ước lượng' : ''}</th>
        <td>{r.workMs?.median.toFixed(2) ?? '—'}</td><td>{r.workMs?.p95.toFixed(2) ?? '—'}</td><td>{r.budget ?? '—'}</td>
        <td>{r.status === 'pass' ? '✓ Đạt' : r.status === 'fail'
          ? `⚠ ${r.budget && r.workMs && r.workMs.p95 > r.budget ? `Vượt ${((r.workMs.p95 / r.budget - 1) * 100).toFixed(0)}%` : 'Không đạt kiểm tra'}`
          : r.status === 'unavailable' ? `— ${r.reason ?? 'Chưa có số đo'}` : '— Chưa có ngân sách'}</td>
      </tr>)}</tbody>
    </table>}
  </section>
}

// Reports of a stress run: JSON (replayable: seed + step log), Markdown (for an issue / a chat) and a one-line
// Vietnamese summary.
import { SCENARIO_BY_ID } from './scenarios'
import type { StressReport } from './types'

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} giây` : `${Math.round(ms / 60_000)} phút`)
const nf = (n: number) => n.toLocaleString('vi-VN')

const KIND_LABEL = { app: 'lỗi của SanoVids', simulator: 'giới hạn của canvasapp giả lập', harness: 'lỗi của bộ thử nghiệm' } as const

export function toJSON(r: StressReport): string {
  return JSON.stringify(r, null, 2)
}

/** "Đạt — 2.000 bước trong 41.3 giây, 0 lỗi, 3 cảnh báo." / "Lỗi ở bước 412: … Seed 7f3a91c2." … */
export function summaryText(r: StressReport): string {
  const warnCount = r.warnings.reduce((n, w) => n + w.count, 0)
  switch (r.result) {
    case 'pass':
      return `Đạt — ${nf(r.steps)} bước trong ${fmtMs(r.durationMs)}, 0 lỗi, ${nf(warnCount)} cảnh báo. Seed ${r.seed}.`
    case 'fail':
      return `Lỗi ở bước ${nf(r.failure?.step ?? r.steps)} (${r.failure?.invariant}): ${r.failure?.message} Seed ${r.seed}.`
    case 'stopped':
      return `Đã dừng ở bước ${nf(r.steps)} sau ${fmtMs(r.durationMs)} — ${nf(warnCount)} cảnh báo, chưa thấy lỗi. Seed ${r.seed}.`
    default:
      return `Không chạy tiếp được: ${r.failure?.message ?? 'lỗi không rõ'}`
  }
}

export function toMarkdown(r: StressReport): string {
  const lines: string[] = []
  const names = r.spec.scenarios.map((id) => SCENARIO_BY_ID.get(id)?.label ?? id).join(', ')
  lines.push(`# Báo cáo thử nghiệm giới hạn — ${r.result === 'pass' ? 'ĐẠT' : r.result === 'fail' ? 'LỖI' : r.result === 'stopped' ? 'ĐÃ DỪNG' : 'KHÔNG CHẠY ĐƯỢC'}`)
  lines.push('')
  lines.push(summaryText(r))
  lines.push('')
  lines.push('| | |')
  lines.push('|---|---|')
  lines.push(`| Seed | \`${r.seed}\` |`)
  lines.push(`| Kịch bản | ${names} |`)
  lines.push(`| Cỡ dự án | ${r.spec.tier} |`)
  lines.push(`| Lỗi mạng | ${r.spec.faults} |`)
  lines.push(`| Bước | ${nf(r.steps)} / ${r.spec.steps ? nf(r.spec.steps) : '∞'} |`)
  lines.push(`| Thời gian | ${fmtMs(r.durationMs)} |`)
  lines.push(`| Bản | ${r.app.version} (${r.app.build === 'app' ? 'trong app' : 'không giao diện'}) |`)
  lines.push(`| canvasapp giả lập | ${nf(r.server.jobs)} job, ${nf(r.server.uploads)} ảnh tải lên, ${nf(r.server.requests)} yêu cầu |`)
  lines.push('')
  if (r.failure) {
    const f = r.failure
    lines.push('## Lỗi')
    lines.push('')
    lines.push(`- **${f.invariant}** (${KIND_LABEL[f.kind]}) ở bước ${f.step}, thao tác \`${f.action}\``)
    lines.push(`- ${f.message}`)
    lines.push(`- Tham số: \`${JSON.stringify(f.args)}\``)
    if (f.detail !== undefined) {
      lines.push('')
      lines.push('```json')
      lines.push(JSON.stringify(f.detail, null, 2).slice(0, 4000))
      lines.push('```')
    }
    if (f.stack) {
      lines.push('')
      lines.push('```')
      lines.push(f.stack.slice(0, 3000))
      lines.push('```')
    }
    lines.push('')
    lines.push(`Tái hiện: mở Bảng phát triển → Test giới hạn, nhập seed \`${r.seed}\`, bấm “Chạy lại seed này” (hoặc \`STRESS_REPLAY=<file .json> npm run stress\`).`)
    lines.push('')
  }
  if (r.warnings.length) {
    lines.push('## Cảnh báo')
    lines.push('')
    lines.push('| Mã | Số lần | Bước đầu | Nội dung |')
    lines.push('|---|---|---|---|')
    for (const w of r.warnings.slice(0, 40)) lines.push(`| ${w.invariant} | ${w.count} | ${w.firstStep} | ${w.message.replace(/\|/g, '\\|')} |`)
    lines.push('')
  }
  const per = Object.entries(r.metrics.perAction).sort((a, b) => b[1].p95 - a[1].p95)
  if (per.length) {
    lines.push('## Thời gian theo thao tác (ms)')
    lines.push('')
    lines.push('| Thao tác | Số lần | p50 | p95 | Lâu nhất |')
    lines.push('|---|---|---|---|---|')
    for (const [id, s] of per) lines.push(`| ${id} | ${s.n} | ${s.p50} | ${s.p95} | ${s.max} |`)
    lines.push('')
  }
  if (r.metrics.slowSteps.length) {
    lines.push('## Bước chậm nhất')
    lines.push('')
    for (const s of r.metrics.slowSteps.slice(0, 10)) lines.push(`- bước ${s.step}: \`${s.action}\` ${s.ms} ms`)
    lines.push('')
  }
  if (Object.keys(r.guards).length) {
    lines.push('## Đã chặn')
    lines.push('')
    for (const [k, n] of Object.entries(r.guards)) lines.push(`- ${k}: ${n}`)
    lines.push('')
  }
  if (r.notes.length) {
    lines.push('## Ghi chú')
    lines.push('')
    for (const n of r.notes.slice(0, 50)) lines.push(`- ${n}`)
    lines.push('')
  }
  lines.push('## 20 bước cuối')
  lines.push('')
  for (const s of r.ring.slice(-20)) lines.push(`- ${s.n}. \`${s.id}\` ${JSON.stringify(s.args).slice(0, 160)} — ${s.ms} ms, ${s.scenes} cảnh, ${s.takes} video`)
  lines.push('')
  return lines.join('\n')
}

/** File name for a report: sanovids-stress-<seed>-<result>.<ext> */
export const reportFileName = (r: StressReport, ext: 'json' | 'md') => `sanovids-stress-${r.seed}-${r.result}.${ext}`

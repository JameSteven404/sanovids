// The "Nhập job" dialog body as rendered (server-side, no DOM, no effects): groups by scene, ticks, re-import badge,
// the reasons the other jobs are not offered, the error / empty states — in development-mode words when simulated.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'x'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SiteJobCandidate, SiteJobScan } from '../../../providers/canvasapp/siteJobs'
import { ImportJobsBody, type Phase } from '../ImportJobsDialog'

const cand = (jobId: string, sceneId: string, over: Partial<SiteJobCandidate> = {}): SiteJobCandidate => ({
  jobId,
  remoteId: `proj1:${jobId}`,
  nodeId: 'n',
  sceneId,
  job: { job_id: jobId, status: 'processing' },
  jobName: `Video ${jobId}`,
  state: 'processing',
  progress: 40,
  createdAt: null,
  model: 'seedance_2_5',
  duration: 15,
  ratio: '16:9',
  reimport: false,
  hints: [],
  ...over,
})
const scenes = [
  { id: 's1', order: 1, title: 'Mở đầu' },
  { id: 's2', order: 2, title: 'Đi dạo' },
]
const ready = (scan: Partial<SiteJobScan>, simulated = false): Phase => ({
  kind: 'ready',
  data: { pid: simulated ? 'dev' : 'canvasapp', simulated, projectId: 'p', scan: { projectId: 'proj1', listHasKeys: false, candidates: [], skipped: [], ...scan } },
})
const render = (phase: Phase, picked: string[] = []) =>
  renderToStaticMarkup(
    createElement(ImportJobsBody, {
      simulated: phase.kind === 'ready' ? phase.data.simulated : false,
      phase,
      scenes,
      picked: new Set(picked),
      busy: null,
      onToggle: () => undefined,
      onLogin: () => undefined,
      onRetry: () => undefined,
    }),
  )

describe('ImportJobsBody', () => {
  it('jobs by scene, ticked as picked, the re-import badge, why the others are not offered', () => {
    const html = render(
      ready({
        candidates: [cand('a', 's1'), cand('b', 's2', { reimport: true, state: 'completed', job: { job_id: 'b', status: 'completed', download_available: true } })],
        skipped: [{ jobId: 'c', sceneId: 's1', code: 'in-project' }],
      }),
      ['a'],
    )
    expect(html).toContain('<h4 class="rq-imp-group-head">S01 · Mở đầu</h4>')
    expect(html).toContain('<h4 class="rq-imp-group-head">S02 · Đi dạo</h4>')
    expect(html).toMatch(/<label class="rq-imp-row on"><input type="checkbox" checked=""/)
    expect(html).toContain('Đang tạo 40%')
    expect(html).toContain('Seedance 2.5 · 15s · 16:9')
    expect(html).toContain('Đã xong')
    expect(html).toContain('đã nhập trước')
    expect(html).toContain('<summary>Không nhập được (1)</summary>')
    expect(html).toContain('Đã có trong dự án: 1 job')
    expect(html).toContain('trên canvasapp.io.vn trong phiên “SanoVids bridge”')
  })

  it('no bridge session / nothing new / an error with the right button — development mode never says canvasapp.io.vn', () => {
    expect(render(ready({ projectId: null }, true))).toContain('Chưa có phiên “SanoVids bridge” trên canvasapp giả lập')
    const empty = render(ready({}, true))
    expect(empty).toContain('Không có job mới nào để nhập.')
    expect(empty).not.toContain('canvasapp.io.vn')
    expect(render({ kind: 'error', message: 'Chưa đăng nhập', login: true })).toMatch(/Chưa đăng nhập<\/span><button[^>]*class="btn btn-sm btn-primary"/)
    expect(render({ kind: 'error', message: 'Mất mạng', login: false })).toContain('Thử lại')
    expect(render({ kind: 'loading' })).toContain('Đang đọc danh sách job')
    const many = Array.from({ length: 21 }, (_, i) => cand(`j${i}`, 's1'))
    expect(render(ready({ candidates: many }), many.map((c) => c.jobId))).toContain('Mỗi lần nhập tối đa 20 job')
  })
})

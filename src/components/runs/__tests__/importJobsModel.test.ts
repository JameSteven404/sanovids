// "Nhập job" dialog texts and rules (importJobsModel.ts), for the real site and development mode.
import { describe, expect, it } from 'vitest'
import type { Scene } from '../../../core/types'
import { CREATED_SKEW_MS, NAIVE_CREATED_SKEW_MS, type SiteJobCandidate, type SiteJobScan } from '../../../providers/canvasapp/siteJobs'
import {
  candidateSettingsText,
  candidateStatusText,
  candidateTimeText,
  capNote,
  defaultPicks,
  dropToastText,
  emptyText,
  footNote,
  groupByScene,
  importButtonText,
  importLead,
  importTitle,
  importToastText,
  importWords,
  jobNameTitle,
  loginButtonText,
  noBridgeText,
  reimportTitle,
  skipLines,
} from '../importJobsModel'

const real = importWords(false)
const dev = importWords(true)

const cand = (jobId: string, sceneId: string, over: Partial<SiteJobCandidate> = {}): SiteJobCandidate => ({
  jobId,
  remoteId: `proj1:${jobId}`,
  nodeId: 'n',
  sceneId,
  job: { job_id: jobId, status: 'processing' },
  jobName: null,
  state: 'processing',
  progress: 40,
  createdAt: new Date(2026, 9, 6, 14, 32).getTime(),
  createdWall: null,
  model: 'seedance_2_5',
  duration: 15,
  ratio: '16:9',
  reimport: false,
  hints: [],
  ...over,
})
const scenes = [
  { id: 's1', order: 1, title: 'Mở đầu' },
  { id: 's3', order: 3, title: '' },
] as Pick<Scene, 'id' | 'order' | 'title'>[]

describe('importJobsModel: words', () => {
  it('names the real site or the simulation, its credits — never canvasapp.io.vn in development mode', () => {
    expect(importTitle(real)).toBe('Nhập job từ canvasapp')
    expect(importTitle(dev)).toBe('Nhập job từ canvasapp giả lập')
    for (const text of [importLead(dev), noBridgeText(dev), emptyText(dev), footNote(dev)]) expect(text).not.toContain('canvasapp.io.vn')
    expect(importLead(dev)).toContain('không trừ credit dev')
    expect(importLead(real)).toContain('trên canvasapp.io.vn trong phiên “SanoVids bridge”')
    expect(footNote(real)).toContain('“Chạy lại” một take đã nhập tạo take MỚI và trừ credit như bình thường')
    expect(loginButtonText(real)).toBe('Đăng nhập canvasapp')
    expect(loginButtonText(dev)).toBe('Đăng nhập')
    expect(reimportTitle(real)).toMatch(/Nhập lại không trừ credit\.$/)
    expect(reimportTitle(dev)).toMatch(/Nhập lại không trừ credit dev\.$/)
    // never an API key name in the UI
    expect(jobNameTitle('Video 9')).toBe('Tên job: Video 9')
  })

  it('a row: status, what the list says, when', () => {
    expect(candidateStatusText(cand('a', 's1'))).toBe('Đang tạo 40%')
    expect(candidateStatusText(cand('a', 's1', { state: 'queued' }))).toBe('Đang chờ')
    expect(candidateStatusText(cand('a', 's1', { state: 'completed', job: { job_id: 'a', status: 'completed', download_available: true } }))).toBe('Đã xong')
    expect(candidateStatusText(cand('a', 's1', { state: 'completed', job: { job_id: 'a', status: 'completed', download_available: false } }))).toBe('Đã xong — chưa cho tải')
    expect(candidateSettingsText(cand('a', 's1'))).toBe('Seedance 2.5 · 15s · 16:9')
    expect(candidateSettingsText(cand('a', 's1', { model: 'minimax_h3', duration: null, ratio: null }))).toBe('MiniMax-H3')
    expect(candidateTimeText(cand('a', 's1'))).toBe('tạo lúc 14:32 06/10')
    expect(candidateTimeText(cand('a', 's1', { createdAt: null }))).toBe('')
    // created_at without a time zone: canvasapp's own clock, said so (never converted as if it were this computer's)
    expect(candidateTimeText(cand('a', 's1', { createdAt: null, createdWall: '10:00 06/10' }))).toBe('tạo lúc 10:00 06/10 (giờ canvasapp)')
  })
})

describe('importJobsModel: rules', () => {
  it('ticks new jobs (up to 20), never one imported before; more than 20 ticked → the cap note', () => {
    const many = Array.from({ length: 25 }, (_, i) => cand(`j${i}`, 's1', { reimport: i === 0 }))
    expect(defaultPicks(many)).toHaveLength(20)
    expect(defaultPicks(many)).not.toContain('j0')
    expect(capNote(20)).toBeNull()
    expect(capNote(21)).toMatch(/tối đa 20 job/)
    expect(importButtonText(3, false)).toBe('Nhập 3 job')
    expect(importButtonText(3, true)).toBe('Đang nhập…')
  })

  it('groups by scene, in the scan’s order; a scene deleted meanwhile still shows', () => {
    const groups = groupByScene([cand('a', 's1'), cand('b', 's3'), cand('c', 's1'), cand('d', 'gone')], scenes)
    expect(groups.map((g) => [g.heading, g.items.map((c) => c.jobId)])).toEqual([
      ['S01 · Mở đầu', ['a', 'c']],
      ['S03 · Chưa đặt tên', ['b']],
      ['S?? · cảnh đã xoá', ['d']],
    ])
  })

  it('why the others are not offered, one line per reason (the take an unanswered POST belongs to, when it is here)', () => {
    const scan: Pick<SiteJobScan, 'skipped'> = {
      skipped: [
        { jobId: 'a', sceneId: 's1', code: 'in-project' },
        { jobId: 'b', sceneId: 's1', code: 'in-project' },
        { jobId: 'c', sceneId: 's1', code: 'maybe-pending', pendingTakeId: 'take_1' },
        { jobId: 'd', sceneId: 's1', code: 'maybe-pending', pendingTakeId: 'take_gone' },
        { jobId: 'e', sceneId: null, code: 'no-scene' },
        { jobId: 'f', sceneId: 's1', code: 'no-download' },
        { jobId: 'g', sceneId: 's1', code: 'sanovids' },
      ],
    }
    const lines = skipLines(scan, dev, (id) => (id === 'take_1' ? 'S01·T2' : null))
    expect(lines.map((l) => l.code)).toEqual(['maybe-pending', 'in-project', 'sanovids', 'no-scene', 'no-download'])
    expect(lines[0].text).toMatch(/^Có thể là job của take “không rõ đã gửi” \(S01·T2\): 1 job — chưa nhập được tới khi take đó tìm ra job của nó\. Bấm “Chạy lại”/)
    // a deleted take never looks again: its job is never importable — said so, with where to get the video
    expect(lines[0].text).toContain('đã xoá hoặc ở dự án khác: 1 job — không nhập được ở đây')
    expect(lines[0].text).toContain('take đã xoá: job đó không nhập được nữa — xem job đó trong Bảng phát triển')
    expect(lines[1].text).toBe('Đã có trong dự án: 2 job')
    expect(lines[4].text).toBe('Đã xong nhưng canvasapp giả lập không cho tải nữa: 1 job')
  })

  it('MONEY: the maybe-pending line never promises a time limit — only which jobs around that POST are held (14 h / 27 h without a time zone)', () => {
    const line = (skipped: SiteJobScan['skipped'], w = real) => skipLines({ skipped }, w, (id) => (id === 'take_1' ? 'S01·T2' : null))[0].text
    const zoned = line([{ jobId: 'c', sceneId: 's1', code: 'maybe-pending', pendingTakeId: 'take_1', windowHours: CREATED_SKEW_MS / 3600_000 }])
    expect(zoned).toContain('chỉ giữ job tạo trong khoảng 14 giờ quanh lần gửi đó')
    expect(zoned).not.toMatch(/tối đa/)
    const both = line([
      { jobId: 'c', sceneId: 's1', code: 'maybe-pending', pendingTakeId: 'take_1', windowHours: CREATED_SKEW_MS / 3600_000 },
      { jobId: 'd', sceneId: 's1', code: 'maybe-pending', pendingTakeId: 'take_1', windowHours: NAIVE_CREATED_SKEW_MS / 3600_000 },
    ])
    expect(both).toContain('trong khoảng 14–27 giờ quanh lần gửi đó')
    // matched by key, or no creation time: held whenever it was made — no hours at all
    expect(line([{ jobId: 'c', sceneId: 's1', code: 'maybe-pending', pendingTakeId: 'take_1' }])).not.toMatch(/giờ/)
    // the real site: where the deleted take's video can still be fetched
    expect(line([{ jobId: 'd', sceneId: 's1', code: 'maybe-pending', pendingTakeId: 'take_gone' }])).toContain('tải video trên canvasapp.io.vn (phiên “SanoVids bridge”)')
  })

  it('toasts: what came in and where; partial; another project; dropping them again', () => {
    expect(importToastText({ takeIds: ['t1', 't2'], skipped: [] }, ['S01', 'S03', 'S01'], real)).toEqual({
      text: 'Đã nhập 2 video từ canvasapp.io.vn vào S01, S03 — không trừ credit.',
      ok: true,
    })
    expect(importToastText({ takeIds: ['t1'], skipped: [{ jobId: 'x', code: 'claimed' }] }, ['S01'], dev).text).toBe(
      'Đã nhập 1 video từ canvasapp giả lập vào S01 — không trừ credit dev. 1 job không nhập được (đã có trong dự án, cảnh đã bị xoá, hoặc đang chờ xác minh).',
    )
    expect(importToastText({ takeIds: [], skipped: [{ jobId: 'x', code: 'project-changed' }] }, [], real)).toEqual({ text: 'Đã mở dự án khác — chưa nhập gì.', ok: false })
    expect(importToastText({ takeIds: [], skipped: [{ jobId: 'x', code: 'scene-gone' }] }, [], real).ok).toBe(false)
    expect(dropToastText(2, dev)).toBe('Đã bỏ 2 take vừa nhập — job vẫn còn trên canvasapp giả lập; “Nhập job” để nhập lại (không trừ credit dev).')
  })
})

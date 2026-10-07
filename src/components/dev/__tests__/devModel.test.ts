// Development-mode UI model (Bảng phát triển): fault catalog, rule texts, custom rules, request log, character check.
import { describe, expect, it } from 'vitest'
import { canvasNodeId, sceneNodeId } from '../../../providers/canvasapp/mapping'
import { DEV_ENCRYPTIONS, DEV_LOGIN_COOKIES, KEEP_LOGIN_DAYS, type DevRestartOutcome } from '../../../providers/dev/keepLogin'
import type { DevLogEntry } from '../../../providers/dev/log'
import { DEV_CONFIG_DEFAULT, devVideoProfiles, type DevConfig, type DevServerSnapshot } from '../../../providers/dev/server'
import { profileIssues } from '../../../providers/canvasapp/mapping'
import { NO_LIMITS, NO_LIMITS_INFO, type LimitsInfo, type SettingsLimits } from '../../../providers/types'
import {
  activeFaultCount,
  characterCheck,
  CUSTOM_FAULT_DEFAULT,
  customFaultInput,
  DEV_ENCRYPTION_OPTIONS,
  DEV_LOGIN_COOKIE_OPTIONS,
  DEV_PANEL_TABS,
  DEV_UI_FAULTS,
  devPanelTabs,
  devRestartText,
  devRestartTone,
  faultArmedText,
  faultKindsFor,
  faultKindText,
  faultRuleText,
  filterLog,
  jobNodeOwners,
  jobNodeText,
  siteJobToast,
  siteNodeLabel,
  limitsDifferFromConfig,
  limitsStatusText,
  logExport,
  minutesLeft,
  placeholderQr,
  statusText,
  statusTone,
  uiFaultRule,
} from '../devModel'

const snap = (patch: Partial<DevServerSnapshot> = {}): DevServerSnapshot => ({
  authenticated: true,
  sessionExpired: false,
  balance: 1000,
  config: DEV_CONFIG_DEFAULT,
  faults: [],
  jobFaults: { failNext: null, expireNext: false, streamFailures: 0, logoutCopyStuck: false },
  projects: [],
  jobs: [],
  uploads: [],
  topups: [],
  historyCount: 1,
  persistProblem: null,
  ...patch,
})

const entry = (patch: Partial<DevLogEntry>): DevLogEntry => ({
  id: 1,
  at: 0,
  method: 'GET',
  path: '/api/me',
  endpoint: 'me',
  status: 200,
  ms: 150,
  req: null,
  res: null,
  fault: null,
  processed: true,
  ...patch,
})

describe('activeFaultCount', () => {
  it('counts rules and armed job faults', () => {
    expect(activeFaultCount(null)).toBe(0)
    expect(activeFaultCount(snap())).toBe(0)
    const rule = { id: 'f1', endpoint: 'me' as const, fault: { kind: 'network' as const }, sticky: true, remaining: 0, hits: 0, label: null }
    expect(activeFaultCount(snap({ faults: [rule], jobFaults: { failNext: 'x', expireNext: true, streamFailures: 2, logoutCopyStuck: true } }))).toBe(5)
  })

  it('counts a session ended by "Hết phiên (401)", not a plain logout', () => {
    expect(activeFaultCount(snap({ authenticated: false }))).toBe(0)
    expect(activeFaultCount(snap({ authenticated: false, sessionExpired: true }))).toBe(1)
  })
})

describe('DEV_UI_FAULTS', () => {
  it('offers every fault the user asked for, with Vietnamese hints', () => {
    const labels = DEV_UI_FAULTS.map((f) => f.label)
    for (const want of [
      'Mất mạng khi tạo job',
      'Mất phản hồi sau khi tạo job (đã trừ tiền)',
      '502 sau khi đã tạo job',
      '200 nhưng không có mã job',
      'Không đủ credit (402)',
      'Dữ liệu sai (422)',
      'Invalid canvas payload (400)',
      'Hết phiên (401)',
      'Quá nhiều yêu cầu (429)',
      'Job tiếp theo lỗi',
      'Job tiếp theo hết hạn',
      'Tải video lỗi N lần',
      'Tải ảnh lên lỗi',
      'Chậm 3 giây',
      'Mất mạng giữa chừng khi tải video',
      'Tải video bị treo',
      'Tải video chậm (100 KB/giây)',
      'Video quá lớn (> 1 GB)',
    ]) {
      expect(labels).toContain(want)
    }
    expect(new Set(DEV_UI_FAULTS.map((f) => f.id)).size).toBe(DEV_UI_FAULTS.length)
    for (const f of DEV_UI_FAULTS) expect(f.hint.length).toBeGreaterThan(10)
  })

  it('rules are one-shot by default and sticky with "giữ"', () => {
    const lost = DEV_UI_FAULTS.find((f) => f.id === 'job-lost')!
    expect(lost.stickyByDefault).toBe(false)
    expect(uiFaultRule(lost, false)).toMatchObject({ endpoint: 'job-create', fault: { kind: 'lost-response' }, sticky: false, times: 1 })
    const sticky = uiFaultRule(lost, true)!
    expect(sticky.sticky).toBe(true)
    expect(sticky.times).toBeUndefined()
    // a preset with its own count keeps it
    expect(uiFaultRule(DEV_UI_FAULTS.find((f) => f.id === 'stream-network')!, false)?.times).toBe(3)
    // the offline preset stays on by default
    expect(DEV_UI_FAULTS.find((f) => f.id === 'offline')!.stickyByDefault).toBe(true)
    // non-rule items have no server rule
    expect(uiFaultRule(DEV_UI_FAULTS.find((f) => f.id === 'fail-next')!, true)).toBeNull()
    // "Invalid canvas payload" covers the adapter's retry with only the current scene (else the job is sent anyway)
    expect(uiFaultRule(DEV_UI_FAULTS.find((f) => f.id === 'canvas-400')!, false)).toMatchObject({ endpoint: 'canvas-put', times: 2 })
  })

  it('the arming toast says how often, from the rule itself', () => {
    const item = (id: string) => DEV_UI_FAULTS.find((f) => f.id === id)!
    expect(faultArmedText(item('job-lost'), false)).toBe('Đã bật lỗi giả: Mất phản hồi sau khi tạo job (đã trừ tiền) (1 lần).')
    expect(faultArmedText(item('stream-network'), false)).toBe('Đã bật lỗi giả: Mất mạng khi tải video (3 lần).')
    expect(faultArmedText(item('stream-network'), true)).toBe('Đã bật lỗi giả: Mất mạng khi tải video (giữ).')
    expect(faultArmedText(item('canvas-400'), false)).toBe('Đã bật lỗi giả: Invalid canvas payload (400) (2 lần).')
    expect(faultArmedText(item('stream-failures'), false, 4)).toBe('Đã bật lỗi giả: Tải video lỗi N lần (N = 4).')
    expect(faultArmedText(item('fail-next'), false)).toBe('Đã bật lỗi giả: Job tiếp theo lỗi.')
    // video downloads: one-shot cut / stall / oversize, a sticky slow body (it only shows while it lasts)
    expect(faultArmedText(item('stream-cut'), false)).toBe('Đã bật lỗi giả: Mất mạng giữa chừng khi tải video (1 lần).')
    expect(['stream-slow', 'stream-crawl'].map((id) => item(id).stickyByDefault)).toEqual([true, true])
    expect(['stream-cut', 'stream-stall', 'stream-http', 'stream-oversize'].map((id) => item(id).stickyByDefault)).toEqual([false, false, false, false])
    expect(faultArmedText(item('stream-http'), false)).toBe('Đã bật lỗi giả: Tải video bị chuyển sang http (1 lần).')
    // they come right after "Mất mạng khi tải video"
    const ids = DEV_UI_FAULTS.map((f) => f.id)
    expect(ids.slice(ids.indexOf('stream-network'), ids.indexOf('stream-network') + 7)).toEqual([
      'stream-network',
      'stream-cut',
      'stream-stall',
      'stream-slow',
      'stream-crawl',
      'stream-http',
      'stream-oversize',
    ])
    for (const f of DEV_UI_FAULTS) expect(faultArmedText(f, false)).not.toMatch(/\(\d+ lần\) \(/)
  })
})

describe('fault texts', () => {
  it('describes each kind and an armed rule', () => {
    expect(faultKindText({ kind: 'network' })).toContain('mất mạng')
    expect(faultKindText({ kind: 'processed-then', status: 502 })).toBe('xử lý xong rồi trả 502')
    expect(faultKindText({ kind: 'slow', ms: 3000 })).toBe('chậm 3 giây')
    expect(faultKindText({ kind: 'slow', ms: 1500 })).toBe('chậm 1,5 giây')
    expect(faultKindText({ kind: 'cut', fraction: 0.5 })).toBe('ngắt giữa chừng (sau 50% video)')
    expect(faultKindText({ kind: 'stall' })).toBe('đứng, không gửi tiếp (sau 50% video)')
    expect(faultKindText({ kind: 'trickle', bytesPerSec: 100 * 1024 })).toBe('chậm 100 KB/giây')
    expect(faultKindText({ kind: 'oversize' })).toBe('báo dung lượng > 1 GB')
    expect(faultKindText({ kind: 'insecure-redirect' })).toBe('chuyển hướng sang http (không được theo)')
    expect(faultRuleText({ endpoint: 'job-stream', fault: { kind: 'cut', fraction: 0.5 }, sticky: false, remaining: 1, hits: 0 })).toBe(
      'Tải video · ngắt giữa chừng (sau 50% video) · còn 1 lần',
    )
    expect(faultRuleText({ endpoint: 'job-create', fault: { kind: 'response', status: 402 }, sticky: false, remaining: 1, hits: 0 })).toBe(
      'Tạo job video · trả 402 (không xử lý) · còn 1 lần',
    )
    expect(faultRuleText({ endpoint: '*', fault: { kind: 'network' }, sticky: true, remaining: 0, hits: 3 })).toContain('Mọi yêu cầu · mất mạng')
    expect(faultRuleText({ endpoint: '*', fault: { kind: 'network' }, sticky: true, remaining: 0, hits: 3 })).toContain('giữ tới khi tắt · đã xảy ra 3 lần')
  })
})

describe('customFaultInput', () => {
  it('builds a rule from the form', () => {
    const r = customFaultInput({ ...CUSTOM_FAULT_DEFAULT, status: '503', json: '{"detail":"x"}', times: '2' })
    expect(r).toEqual({ ok: true, input: { endpoint: 'job-create', fault: { kind: 'response', status: 503, json: { detail: 'x' } }, sticky: false, times: 2 } })
    const slow = customFaultInput({ ...CUSTOM_FAULT_DEFAULT, endpoint: '*', kind: 'slow', ms: '500', sticky: true })
    expect(slow).toEqual({ ok: true, input: { endpoint: '*', fault: { kind: 'slow', ms: 500 }, sticky: true } })
    expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, kind: 'network' })).toMatchObject({ ok: true, input: { fault: { kind: 'network' } } })
    // video-download kinds, for "Tải video" only
    const stream = { ...CUSTOM_FAULT_DEFAULT, endpoint: 'job-stream' as const }
    expect(customFaultInput({ ...stream, kind: 'cut' })).toEqual({ ok: true, input: { endpoint: 'job-stream', fault: { kind: 'cut', fraction: 0.5 }, sticky: false, times: 1 } })
    expect(customFaultInput({ ...stream, kind: 'stall' })).toMatchObject({ ok: true, input: { fault: { kind: 'stall', fraction: 0.5 } } })
    expect(customFaultInput({ ...stream, kind: 'trickle', kbps: '50', sticky: true })).toEqual({ ok: true, input: { endpoint: 'job-stream', fault: { kind: 'trickle', bytesPerSec: 51_200 }, sticky: true } })
    expect(customFaultInput({ ...stream, kind: 'oversize' })).toMatchObject({ ok: true, input: { fault: { kind: 'oversize' } } })
  })

  it('offers the video-download kinds only for "Tải video" (and refuses them elsewhere)', () => {
    expect(faultKindsFor('job-stream')).toEqual(['network', 'lost-response', 'processed-then', 'response', 'slow', 'cut', 'stall', 'trickle', 'oversize', 'insecure-redirect'])
    expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, endpoint: 'job-stream', kind: 'insecure-redirect' })).toMatchObject({ ok: true, input: { endpoint: 'job-stream', fault: { kind: 'insecure-redirect' } } })
    for (const ep of ['job-create', '*', 'jobs-list'] as const) {
      expect(faultKindsFor(ep)).toEqual(['network', 'lost-response', 'processed-then', 'response', 'slow'])
      for (const kind of ['cut', 'stall', 'trickle', 'oversize', 'insecure-redirect'] as const) {
        expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, endpoint: ep, kind })).toEqual({ ok: false, error: 'Kiểu lỗi này chỉ dùng cho “Tải video”.' })
      }
    }
    expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, endpoint: 'job-stream', kind: 'trickle', kbps: '0' })).toMatchObject({ ok: false, error: expect.stringContaining('KB/giây') })
  })

  it('refuses bad input with a Vietnamese reason', () => {
    expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, status: '99' })).toMatchObject({ ok: false })
    expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, json: '{oops' })).toMatchObject({ ok: false, error: expect.stringContaining('JSON') })
    expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, kind: 'slow', ms: '-1' })).toMatchObject({ ok: false })
    expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, times: '0' })).toMatchObject({ ok: false })
    expect(customFaultInput({ ...CUSTOM_FAULT_DEFAULT, endpoint: 'nope' as never })).toMatchObject({ ok: false })
  })
})

describe('request log', () => {
  it('tones and texts', () => {
    expect(statusTone({ status: 200 })).toBe('ok')
    expect(statusTone({ status: 402 })).toBe('warn')
    expect(statusTone({ status: 502 })).toBe('danger')
    expect(statusTone({ status: null })).toBe('danger')
    expect(statusText({ status: null })).toBe('không trả lời')
  })

  it('filters newest first by words, and problems only', () => {
    const list = [
      entry({ id: 1, path: '/api/me' }),
      entry({ id: 2, method: 'POST', path: '/api/video-jobs', endpoint: 'job-create', status: null, fault: 'network' }),
      entry({ id: 3, path: '/api/video-jobs?project_id=p', endpoint: 'jobs-list', status: 200 }),
    ]
    expect(filterLog(list, '').map((e) => e.id)).toEqual([3, 2, 1])
    expect(filterLog(list, 'video-jobs').map((e) => e.id)).toEqual([3, 2])
    expect(filterLog(list, 'post network').map((e) => e.id)).toEqual([2])
    expect(filterLog(list, 'tạo job').map((e) => e.id)).toEqual([2])
    expect(filterLog(list, '', true).map((e) => e.id)).toEqual([2])
  })

  it('exports the log with the server settings for a bug report', () => {
    const text = logExport([entry({ at: Date.UTC(2026, 9, 2, 7, 0, 0) })], snap({ balance: 42 }), Date.UTC(2026, 9, 2, 8, 0, 0))
    const data = JSON.parse(text)
    expect(data).toMatchObject({ app: 'SanoVids', mode: 'dev', exportedAt: '2026-10-02T08:00:00.000Z', server: { balance: 42 } })
    expect(data.entries[0].at).toBe('2026-10-02T07:00:00.000Z')
  })
})

describe('simulated SePay page', () => {
  it('draws the same placeholder QR for the same order, with the three finder squares', () => {
    const a = placeholderQr('DEVTOP00001ABCD')
    expect(a).toHaveLength(25)
    expect(a.every((row) => row.length === 25)).toBe(true)
    expect(placeholderQr('DEVTOP00001ABCD')).toEqual(a)
    expect(placeholderQr('DEVTOP00002ABCD')).not.toEqual(a)
    // finder squares: dark outer ring, light gap, dark 3×3 core — top-left, top-right, bottom-left
    for (const [r, c] of [
      [0, 0],
      [0, 18],
      [18, 0],
    ]) {
      expect(a[r][c]).toBe(true)
      expect(a[r + 1][c + 1]).toBe(false)
      expect(a[r + 3][c + 3]).toBe(true)
    }
  })

  it('counts down mm:ss, never below 0:00', () => {
    expect(minutesLeft(15 * 60_000, 0)).toBe('15:00')
    expect(minutesLeft(61_000, 0)).toBe('1:01')
    expect(minutesLeft(500, 0)).toBe('0:01')
    expect(minutesLeft(0, 10_000)).toBe('0:00')
  })
})

describe('characterCheck', () => {
  const assets = [
    { id: 'a1', name: 'Lan', tag: 'Lan', imageIds: ['img_lan'] },
    { id: 'a2', name: 'Minh', tag: 'Minh', imageIds: ['img_minh', 'img_minh2'] },
  ]
  const uploads = [
    { upload_id: 'u1', imageId: 'img_minh' },
    { upload_id: 'u2', imageId: 'img_lan' },
  ]

  it('maps each upload in order to @image_N, its picture and its asset; flags @image_N without an upload', () => {
    const body = { client_request_id: 'k1', prompt: '@image_1 talks to @Image 2, then @image_3 waves', upload_ids: ['u1', 'u2'] }
    const c = characterCheck(body, { uploads, jobs: [], assets })!
    expect(c.kind).toBe('images')
    expect(c.slots.map((s) => [s.label, s.imageId, s.asset?.name, s.mentioned])).toEqual([
      ['@image_1', 'img_minh', 'Minh', true],
      ['@image_2', 'img_lan', 'Lan', true],
    ])
    expect(c.missing).toEqual([{ n: 3, token: '@image_3' }])
    expect(c.promptFromJob).toBe(false)
  })

  it('uses the full prompt of the job when the server has it, and notices a cut prompt otherwise', () => {
    const cut = `${'x'.repeat(300)}… (+120 ký tự)`
    const body = { client_request_id: 'k1', prompt: cut, upload_ids: ['u1'] }
    const fromJob = characterCheck(body, { uploads, jobs: [{ client_request_id: 'k1', prompt: 'full @image_1 and @image_2' }], assets })!
    expect(fromJob.promptFromJob).toBe(true)
    expect(fromJob.promptTruncated).toBe(false)
    expect(fromJob.missing.map((m) => m.n)).toEqual([2])
    const logged = characterCheck(body, { uploads, jobs: [], assets })!
    expect(logged.promptTruncated).toBe(true)
    expect(logged.slots[0].mentioned).toBe(false)
  })

  it('unknown uploads and pictures not in the project are shown as such', () => {
    const c = characterCheck({ prompt: '@image_1', upload_ids: ['zz'] }, { uploads, jobs: [], assets })!
    expect(c.slots[0]).toMatchObject({ uploaded: false, imageId: null, asset: null, mentioned: true })
  })

  it('frames jobs (MiniMax-H3 khung đầu/cuối) list the two frames', () => {
    const c = characterCheck({ prompt: 'a door opens', first_frame_upload_id: 'u2', last_frame_upload_id: 'u1' }, { uploads, jobs: [], assets })!
    expect(c.kind).toBe('frames')
    expect(c.slots.map((s) => [s.label, s.asset?.name])).toEqual([
      ['khung đầu', 'Lan'],
      ['khung cuối', 'Minh'],
    ])
    expect(c.missing).toEqual([])
  })

  it('is null for bodies that are not jobs', () => {
    expect(characterCheck(null, { uploads, jobs: [], assets })).toBeNull()
    expect(characterCheck({ amount_vnd: 10000 }, { uploads, jobs: [], assets })).toBeNull()
  })
})

describe('devPanelTabs', () => {
  it('shows performance only with an explicit perf flag, including desktop', () => {
    expect(devPanelTabs({ simulatedUpdates: false, perf: true }).at(-1)).toEqual({ id: 'perf', label: 'Hiệu năng' })
    expect(devPanelTabs({ simulatedUpdates: true, perf: true }).map((t) => t.id)).toContain('perf')
    expect(devPanelTabs({ simulatedUpdates: false, perf: false }).map((t) => t.id)).not.toContain('perf')
  })
  it('"Cập nhật" only where the updater is simulated (outside Electron)', () => {
    expect(DEV_PANEL_TABS.map((t) => t.id)).toEqual(['status', 'faults', 'log', 'jobs', 'updates', 'stress'])
    expect(DEV_PANEL_TABS.find((t) => t.id === 'updates')?.label).toBe('Cập nhật')
    expect(devPanelTabs({ simulatedUpdates: true }).map((t) => t.id)).toEqual(['status', 'faults', 'log', 'jobs', 'updates', 'stress'])
    expect(devPanelTabs({ simulatedUpdates: false }).map((t) => t.id)).toEqual(['status', 'faults', 'log', 'jobs', 'stress'])
  })
  it('"Test giới hạn" (the stress tester) on the web and in the desktop app, before the perf tab', () => {
    expect(DEV_PANEL_TABS.find((t) => t.id === 'stress')?.label).toBe('Test giới hạn')
    expect(devPanelTabs({ simulatedUpdates: false, perf: true }).map((t) => t.id).slice(-2)).toEqual(['stress', 'perf'])
  })
})

describe('jobNodeOwners / jobNodeText (Job & đơn nạp)', () => {
  const scenes = [
    { id: 'scn_a', order: 3 },
    { id: 'scn_b', order: 12 },
  ]
  const owners = jobNodeOwners('prj_1', scenes)

  it('a scene of the open project, its old node (scene id alone), or anything else', () => {
    expect(owners.get(sceneNodeId('prj_1', 'scn_a'))).toEqual({ kind: 'scene', code: 'S03' })
    expect(owners.get(sceneNodeId('prj_1', 'scn_b'))).toEqual({ kind: 'scene', code: 'S12' })
    expect(owners.get(canvasNodeId('scn_a'))).toEqual({ kind: 'legacy', code: 'S03' })
    // the same scene in a duplicated project, a deleted scene: not the open project's
    expect(owners.get(sceneNodeId('prj_2', 'scn_a'))).toBeUndefined()
    expect(owners.get(sceneNodeId('prj_1', 'scn_gone'))).toBeUndefined()
    expect(owners.size).toBe(4)
  })

  it('labels and tooltips (Vietnamese, the full node id first, no version numbers)', () => {
    const id = sceneNodeId('prj_1', 'scn_a')
    expect(jobNodeText(id, owners.get(id))).toEqual({ label: 'node S03', title: `canvas_node_id: ${id}\nNode của cảnh S03 trong dự án đang mở.` })
    const old = canvasNodeId('scn_a')
    expect(jobNodeText(old, owners.get(old))).toEqual({
      label: 'node cũ S03',
      title: `canvas_node_id: ${old}\nNode đặt theo riêng id cảnh (bản SanoVids cũ): dự án nhân bản hoặc nhập lại từ cùng tệp có thể dùng chung node này.`,
    })
    const gone = sceneNodeId('prj_1', 'scn_gone')
    expect(jobNodeText(gone, owners.get(gone))).toEqual({
      label: 'node khác',
      title: `canvas_node_id: ${gone}\nKhông thuộc cảnh nào đang có trong dự án đang mở (dự án khác, hoặc cảnh đã xoá).`,
    })
    for (const o of [...owners.values(), undefined]) expect(jobNodeText('x', o).title).not.toMatch(/\d+\.\d+\.\d+/)
  })
})

describe('Model (video-profiles): what SanoVids knows of the simulated site', () => {
  const at = new Date(2026, 9, 6, 14, 5, 9).getTime()
  const info = (patch: Partial<LimitsInfo>): LimitsInfo => ({ ...NO_LIMITS_INFO, ...patch })
  /** What the adapter makes of a read of the simulated site with these toggles. */
  const known = (models: DevConfig['models'], firm = true): SettingsLimits => {
    const profiles = devVideoProfiles(models)
    return { source: 'server', firm, issues: (s) => profileIssues(s, profiles) }
  }
  const models = (patch: Partial<Record<keyof DevConfig['models'], Partial<DevConfig['models'][keyof DevConfig['models']]>>>): DevConfig['models'] => ({
    seedance_2_5: { ...DEV_CONFIG_DEFAULT.models.seedance_2_5, ...patch.seedance_2_5 },
    minimax_h3: { ...DEV_CONFIG_DEFAULT.models.minimax_h3, ...patch.minimax_h3 },
  })

  it('status line for each state', () => {
    expect(limitsStatusText(NO_LIMITS_INFO, NO_LIMITS)).toMatch(/^SanoVids chưa đọc cấu hình model — đọc khi mở cấu hình video/)
    expect(limitsStatusText(info({ reading: true }), NO_LIMITS)).toBe('SanoVids đang đọc cấu hình model…')
    expect(limitsStatusText(info({ lastAttempt: { at, result: 'login' } }), NO_LIMITS)).toMatch(/Lần thử lúc 14:05:09: chưa đăng nhập \(401\)\.$/)
    const server = info({ source: 'server', at, firmUntil: at + 600_000, lastAttempt: { at, result: 'read' } })
    expect(limitsStatusText(server, { source: 'server', firm: true })).toBe('SanoVids đọc lúc 14:05:09 — inspector, nút Chạy và hộp Chạy khoá đúng những gì đang tắt ở đây lúc đó.')
    expect(limitsStatusText(server, { source: 'server', firm: false })).toMatch(/đã quá 10 phút: inspector chỉ còn cảnh báo/)
    expect(limitsStatusText({ ...server, lastAttempt: { at: at + 1000, result: 'kept' } }, { source: 'server', firm: true })).toMatch(/Lần đọc lại lúc 14:05:10 lỗi — vẫn dùng lần đọc trước\.$/)
    expect(limitsStatusText({ ...server, lastAttempt: { at: at + 1000, result: 'login' } }, { source: 'server', firm: true })).toMatch(/chưa đăng nhập \(401\) — vẫn dùng lần đọc trước\.$/)
    const fallback = info({ source: 'fallback', at, lastAttempt: { at, result: 'failed' } })
    expect(limitsStatusText(fallback, { source: 'fallback', firm: false })).toMatch(/^SanoVids không đọc được lúc 14:05:09 — đang dùng cấu hình dự phòng .*MiniMax-H3 khoá/)
    // nothing re-reads on a timer: it says what does (showing the settings / run dialog, a submit, the button)
    expect(limitsStatusText(fallback, { source: 'fallback', firm: false })).toMatch(/Không tự đọc lại theo giờ: đọc lại khi mở cấu hình video .*“Đọc lại ngay”\.$/)
  })

  it('says when what SanoVids knows differs from the toggles now ("Đọc lại ngay")', () => {
    const now = DEV_CONFIG_DEFAULT.models
    expect(limitsDifferFromConfig(known(now), now)).toBe(false)
    expect(limitsDifferFromConfig(NO_LIMITS, models({ minimax_h3: { can_create: false } }))).toBe(false) // nothing read: nothing to compare
    const locked = models({ minimax_h3: { can_create: false } })
    expect(limitsDifferFromConfig(known(now), locked)).toBe(true)
    expect(limitsDifferFromConfig(known(locked), locked)).toBe(false)
    const noTransform = models({ minimax_h3: { disabled_modes: ['transform'] } })
    expect(limitsDifferFromConfig(known(now), noTransform)).toBe(true)
    expect(limitsDifferFromConfig(known(noTransform), noTransform)).toBe(false)
    // Seedance's lists narrow (used as sent); MiniMax-H3's narrower lists are ignored by canvasapp's page, so no change
    const short = models({ seedance_2_5: { off_durations: [30], off_resolutions: ['480p'], off_ratios: ['1:1'] } })
    expect(limitsDifferFromConfig(known(now), short)).toBe(true)
    expect(limitsDifferFromConfig(known(short), short)).toBe(false)
    const h3Short = models({ minimax_h3: { off_durations: [15], off_resolutions: ['2k'] } })
    expect(limitsDifferFromConfig(known(now), h3Short)).toBe(false)
    expect(limitsDifferFromConfig(known(h3Short), h3Short)).toBe(false)
  })
})

describe('"Tạo job như trên trang canvasapp" (Job & đơn nạp)', () => {
  const node = { id: 'n1', model: 'seedance_2_5' as const, mode: 't2v', duration: 15, resolution: '1080p', aspectRatio: '16:9', prompt: 'x', pictures: 2 }
  it('names a bridge node after its scene of the open project (old node / another one too)', () => {
    expect(siteNodeLabel(node, { kind: 'scene', code: 'S01' }, 'Ôm nhau')).toBe('S01 · Ôm nhau — Seedance 2.5 · 15s · 1080P')
    expect(siteNodeLabel(node, { kind: 'legacy', code: 'S02' })).toBe('node cũ S02 — Seedance 2.5 · 15s · 1080P')
    expect(siteNodeLabel({ ...node, model: null, duration: null }, undefined)).toBe('node lạ — model lạ · 1080P')
  })
  it('says what was made and billed — or why the simulated site refused', () => {
    expect(siteJobToast({ ok: true, jobId: 'j', number: 4, cost: 20 })).toEqual({
      text: 'Đã tạo job #4 trên canvasapp giả lập (như trên trang) — đã trừ 20 credit dev. Dùng “Nhập job” để đưa vào dự án.',
      ok: true,
    })
    expect(siteJobToast({ ok: false, detail: 'Số dư không đủ' })).toEqual({ text: 'canvasapp giả lập không tạo job: Số dư không đủ', ok: false })
  })
})

describe('"Giữ đăng nhập (giả lập)"', () => {
  const outcomes: DevRestartOutcome[] = ['not-logged-in', 'persistent', 'kept', 'keep-off', 'encryption-unavailable', 'decrypt-fails', 'expired']

  it('one Vietnamese toast per outcome: still logged in (success), lost (warning, with the reason), not logged in (info)', () => {
    for (const o of outcomes) expect(devRestartText(o)).toMatch(/^Đã giả lập mở lại app/)
    expect(new Set(outcomes.map(devRestartText)).size).toBe(outcomes.length)
    expect(devRestartText('kept')).toBe('Đã giả lập mở lại app: vẫn đăng nhập (đang giữ đăng nhập).')
    expect(devRestartText('keep-off')).toContain('phiên mất — cần đăng nhập lại')
    expect(devRestartText('expired')).toContain(`${KEEP_LOGIN_DAYS} ngày`)
    expect(outcomes.map(devRestartTone)).toEqual(['info', 'success', 'success', 'warning', 'warning', 'warning', 'warning'])
  })

  it('the two settings offer every simulated value, with labels', () => {
    expect(DEV_LOGIN_COOKIE_OPTIONS.map((o) => o.id)).toEqual([...DEV_LOGIN_COOKIES])
    expect(DEV_ENCRYPTION_OPTIONS.map((o) => o.id)).toEqual([...DEV_ENCRYPTIONS])
    expect(DEV_LOGIN_COOKIE_OPTIONS[0].label).toBe('Theo phiên (mất khi tắt app)')
    expect(DEV_ENCRYPTION_OPTIONS.map((o) => o.label)).toEqual(['Có', 'Không có', 'Giải mã lỗi'])
  })

  it('the fault "Đăng xuất: không xoá được bản sao đăng nhập" is offered, one-shot, and counted while armed', () => {
    const f = DEV_UI_FAULTS.find((x) => x.id === 'logout-copy-stuck')!
    expect(f).toMatchObject({ label: 'Đăng xuất: không xoá được bản sao đăng nhập', action: { type: 'logout-copy-stuck' }, canStick: false })
    expect(uiFaultRule(f, true)).toBeNull()
    expect(faultArmedText(f, false)).toBe('Đã bật lỗi giả: Đăng xuất: không xoá được bản sao đăng nhập.')
    expect(activeFaultCount(snap({ jobFaults: { failNext: null, expireNext: false, streamFailures: 0, logoutCopyStuck: true } }))).toBe(1)
  })
})

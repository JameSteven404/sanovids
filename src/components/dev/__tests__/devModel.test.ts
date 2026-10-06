// Development-mode UI model (Bảng phát triển): fault catalog, rule texts, custom rules, request log, character check.
import { describe, expect, it } from 'vitest'
import { canvasNodeId, sceneNodeId } from '../../../providers/canvasapp/mapping'
import type { DevLogEntry } from '../../../providers/dev/log'
import { DEV_CONFIG_DEFAULT, type DevServerSnapshot } from '../../../providers/dev/server'
import {
  activeFaultCount,
  characterCheck,
  CUSTOM_FAULT_DEFAULT,
  customFaultInput,
  DEV_PANEL_TABS,
  DEV_UI_FAULTS,
  devPanelTabs,
  faultArmedText,
  faultKindText,
  faultRuleText,
  filterLog,
  jobNodeOwners,
  jobNodeText,
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
  jobFaults: { failNext: null, expireNext: false, streamFailures: 0 },
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
    expect(activeFaultCount(snap({ faults: [rule], jobFaults: { failNext: 'x', expireNext: true, streamFailures: 2 } }))).toBe(4)
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
    for (const f of DEV_UI_FAULTS) expect(faultArmedText(f, false)).not.toMatch(/\(\d+ lần\) \(/)
  })
})

describe('fault texts', () => {
  it('describes each kind and an armed rule', () => {
    expect(faultKindText({ kind: 'network' })).toContain('mất mạng')
    expect(faultKindText({ kind: 'processed-then', status: 502 })).toBe('xử lý xong rồi trả 502')
    expect(faultKindText({ kind: 'slow', ms: 3000 })).toBe('chậm 3 giây')
    expect(faultKindText({ kind: 'slow', ms: 1500 })).toBe('chậm 1,5 giây')
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
  it('"Cập nhật" only where the updater is simulated (outside Electron)', () => {
    expect(DEV_PANEL_TABS.map((t) => t.id)).toEqual(['status', 'faults', 'log', 'jobs', 'updates'])
    expect(DEV_PANEL_TABS.find((t) => t.id === 'updates')?.label).toBe('Cập nhật')
    expect(devPanelTabs({ simulatedUpdates: true }).map((t) => t.id)).toEqual(['status', 'faults', 'log', 'jobs', 'updates'])
    expect(devPanelTabs({ simulatedUpdates: false }).map((t) => t.id)).toEqual(['status', 'faults', 'log', 'jobs'])
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

// Takes imported with "Nhập job": what every place shows of what such a take does not know for sure (importedTake.ts),
// and the cost wording (creditText.ts). Takes SanoVids made read exactly as before.
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

import type { ImportedField, Take, VideoSettings } from '../../../core/types'
import { cancelToastText, takeCostLabel, takeCostLine } from '../creditText'
import {
  fieldState,
  importedChipTitle,
  importedFieldsNote,
  importedSourceText,
  restoreBlock,
  restoreNotes,
  restorePlan,
  takeCostInferred,
  takeCostKnown,
  takeDurationText,
  takeModeText,
  takeSettingsText,
  takesRuntime,
  unknownFieldTitle,
} from '../importedTake'

const SETTINGS: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' }
const AT = new Date(2026, 9, 6, 14, 32).getTime()

type T = Pick<Take, 'settings' | 'imported' | 'cost' | 'provider' | 'charged' | 'status' | 'remoteId' | 'error'>
const take = (unknown: ImportedField[] = [], inferred: ImportedField[] = [], over: Partial<T> = {}): T => ({
  settings: SETTINGS,
  cost: 20,
  provider: 'canvasapp',
  charged: false,
  status: 'processing',
  remoteId: 'proj1:job9',
  error: null,
  imported: { at: AT, jobName: 'Video 9', unknown, inferred },
  ...over,
})
const plain = (over: Partial<T> = {}): T => ({ ...take(), imported: undefined, ...over })

describe('what an imported take shows', () => {
  it('"?" for unknown, "≈" for a guess, as before for takes SanoVids made', () => {
    expect(takeSettingsText(plain())).toBe('15s · 1080P · 16:9')
    expect(takeSettingsText(take(['resolution'], ['ratio']))).toBe('15s · ? · ≈16:9')
    expect(takeSettingsText(take([], ['resolution', 'duration']))).toBe('≈15s · ≈1080P · 16:9')
    expect(takeDurationText(take(['duration']))).toBe('?s')
    expect(takeDurationText(take([], ['duration']))).toBe('≈15s')
    expect(takeDurationText(plain())).toBe('15s')
    // the Storyboard's ★ runtime: a guess as soon as one take does not know its duration for sure
    expect(takesRuntime([plain(), take(['resolution'])])).toEqual({ seconds: 30, guessed: false })
    expect(takesRuntime([plain(), take(['duration'])])).toEqual({ seconds: 30, guessed: true })
    expect(takesRuntime([take([], ['duration'])])).toEqual({ seconds: 15, guessed: true })
    expect(takesRuntime([])).toEqual({ seconds: 0, guessed: false })
    expect(takeModeText(take(['mode'], [], { settings: { ...SETTINGS, model: 'minimax_h3', mode: 't2v' } }))).toBe('chế độ ?')
    expect(takeModeText(take([], ['mode'], { settings: { ...SETTINGS, model: 'minimax_h3', mode: 'transform' } }))).toBe('≈Khung đầu → cuối')
    expect(fieldState(plain(), 'refs')).toBe('known')
  })

  it('cost: unknown when resolution or duration is; a guess when they are inferred — "—" / "≈" everywhere', () => {
    expect(takeCostKnown(take(['resolution']))).toBeNull()
    expect(takeCostKnown(take(['duration']))).toBeNull()
    expect(takeCostKnown(take(['ratio']))).toBe(20)
    expect(takeCostInferred(take([], ['resolution']))).toBe(true)
    expect(takeCostInferred(plain())).toBe(false)
    expect(takeCostLabel(take(['resolution']))).toBe('—')
    expect(takeCostLabel(take([], ['resolution']))).toBe('≈ 20 credit canvasapp')
    expect(takeCostLabel(take([], ['resolution'], { provider: 'dev' }))).toBe('≈ 20 credit dev')
    expect(takeCostLabel(plain({ provider: 'dev' }))).toBe('20 credit dev')
  })

  it('the take viewer "Chi phí": paid on the site when the job was made; importing costs nothing (dev: "≈" only on a guess)', () => {
    expect(takeCostLine(take())).toEqual({ kind: 'canvasapp', amount: '≈ 20 credit', note: 'trả trên canvasapp khi tạo job (ngoài SanoVids) — nhập không trừ thêm', struck: false })
    expect(takeCostLine(take(['resolution']))).toMatchObject({ amount: '—', struck: false })
    expect(takeCostLine(take([], [], { provider: 'dev' }))).toMatchObject({ amount: '20 credit dev', note: 'trả trên canvasapp giả lập khi tạo job (ngoài SanoVids) — nhập không trừ thêm' })
    expect(takeCostLine(take([], ['resolution'], { provider: 'dev' })).amount).toBe('≈ 20 credit dev')
    // ended on the site: still paid there, never "struck"
    expect(takeCostLine(take([], [], { status: 'failed' }))).toMatchObject({ struck: false })
  })

  it('“Huỷ” of a running imported take only stops tracking it (the job was made on the site, not sent by SanoVids)', () => {
    const facts = { label: 'S01·T2', provider: 'canvasapp' as const, status: 'processing' as const, cost: 20, demoPaid: false, sentAway: true, videoReady: false }
    expect(cancelToastText({ ...facts, imported: true }).text).toBe('Đã ngừng theo dõi S01·T2 trong SanoVids — job tạo trên canvasapp.io.vn vẫn chạy ở đó.')
    expect(cancelToastText(facts).text).toBe('Đã huỷ S01·T2 trong SanoVids — job đã gửi sang canvasapp.io.vn vẫn chạy ở đó.')
    // development mode: "canvasapp giả lập" / "credit dev", never the mode's label
    const dev = { ...facts, provider: 'dev' as const }
    expect(cancelToastText({ ...dev, imported: true }).text).toBe('Đã ngừng theo dõi S01·T2 trong SanoVids — job tạo trên canvasapp giả lập vẫn chạy ở đó.')
    expect(cancelToastText({ ...dev, sentAway: false }).text).toBe('Đã huỷ S01·T2 lúc đang gửi sang canvasapp giả lập — nếu job đã được nhận thì có thể đã trừ credit dev.')
  })

  it('source line, chip and the note of what is not sure', () => {
    expect(importedSourceText(take())).toBe('Tạo trên canvasapp.io.vn (phiên “SanoVids bridge”), nhập vào SanoVids lúc 14:32 06/10 · tên job: Video 9')
    expect(importedSourceText(take([], [], { provider: 'dev' }))).toMatch(/^Tạo trên canvasapp giả lập /)
    expect(importedSourceText(plain())).toBeNull()
    expect(importedChipTitle(take())).toMatch(/“Chạy lại” tạo take mới \(trừ credit như thường\)$/)
    // development mode: the simulated credits
    expect(importedChipTitle(take([], [], { provider: 'dev' }))).toMatch(/^Job tạo trên canvasapp giả lập .*\(trừ credit dev như thường\)$/)
    expect(unknownFieldTitle(take())).toBe('canvasapp.io.vn không cho biết — không rõ')
    expect(unknownFieldTitle(take([], [], { provider: 'dev' }))).toBe('canvasapp giả lập không cho biết — không rõ')
    expect(importedFieldsNote(take(['resolution', 'refs'], ['mode']))).toBe('không rõ: độ phân giải, ảnh tham chiếu · đoán theo node: chế độ')
    expect(importedFieldsNote(take())).toBeNull()
  })
})

describe('"Khôi phục prompt này" of an imported take', () => {
  const scene: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '720p', ratio: '9:16' }

  it('refused when the prompt or the references are unknown (it would write "" / drop the scene’s references)', () => {
    expect(restoreBlock(plain())).toBeNull()
    expect(restoreBlock(take([], ['refs']))).toBeNull()
    expect(restoreBlock(take(['refs']))).toBe('Take nhập từ canvasapp.io.vn: không rõ ảnh tham chiếu lúc tạo — không khôi phục được.')
    expect(restoreBlock(take(['prompt', 'refs']))).toBe('Take nhập từ canvasapp.io.vn: không rõ prompt / ảnh tham chiếu lúc tạo — không khôi phục được.')
    // development mode: the simulation, never the real site
    expect(restoreBlock(take(['refs'], [], { provider: 'dev' }))).toBe('Take nhập từ canvasapp giả lập: không rõ ảnh tham chiếu lúc tạo — không khôi phục được.')
  })

  /** The take's snapshot fields as importTakes writes them (no @video references: canvasapp sends none). */
  const snap = { rawPromptSnapshot: '@image_1 đi dạo', refsSnapshot: ['a_node'], videoRefsSnapshot: [] as string[], imageKeysSnapshot: ['a_node:img_n'] }
  const sceneOf = (settings: VideoSettings) => ({ settings, refs: ['a_scene', 'b_scene'], videoRefs: ['take_v'] })
  const H3 = (mode: VideoSettings['mode']): VideoSettings => ({ model: 'minimax_h3', mode, duration: 5, resolution: '768p', ratio: '16:9' })

  it('settings: only the known ones; the scene keeps its own for unknown or inferred fields (said in the toast)', () => {
    const plainTake = { ...plain(), rawPromptSnapshot: 'p', refsSnapshot: ['x'], videoRefsSnapshot: ['v'] }
    expect(restorePlan(plainTake, sceneOf(scene))).toEqual({ source: plainTake, settings: SETTINGS, kept: [], defaulted: [], guessed: [], keepRefs: false })
    const t = { ...take(['resolution'], ['ratio', 'refs']), ...snap }
    const r = restorePlan(t, sceneOf(scene))
    expect(r).toMatchObject({ settings: { ...SETTINGS, resolution: '720p', ratio: '9:16' }, kept: ['resolution', 'ratio'], guessed: [], keepRefs: false })
    // the node's references (exact keys) — the scene's @video references stay
    expect(r.source).toEqual({ ...snap, videoRefsSnapshot: ['take_v'] })
    expect(restoreNotes(t, r)).toEqual([
      'giữ độ phân giải của cảnh (không rõ lúc tạo)',
      'giữ tỉ lệ khung của cảnh (chỉ đoán được lúc tạo)',
      'ảnh tham chiếu theo node trên canvas cầu nối (đoán) — hãy kiểm tra',
    ])
    // a scene value the take's model does not have → that model's default (never an invalid setting), and the toast
    // says so — never "giữ … của cảnh" for a value the scene did not keep
    const h3Take = { ...take(['resolution'], ['duration', 'ratio'], { settings: { ...H3('t2v'), duration: 10 } }), ...snap }
    const h3 = restorePlan(h3Take, sceneOf({ ...scene, duration: 30 }))
    expect(h3.settings).toMatchObject({ model: 'minimax_h3', resolution: '768p', duration: 15, ratio: '9:16' })
    expect(h3).toMatchObject({ kept: ['ratio'], defaulted: ['resolution', 'duration'] })
    expect(restoreNotes(h3Take, h3)).toEqual([
      'giữ tỉ lệ khung của cảnh (chỉ đoán được lúc tạo)',
      'đặt độ phân giải mặc định của MiniMax-H3 (không rõ lúc tạo; giá trị của cảnh không có ở model này) — hãy kiểm tra',
      'đặt thời lượng mặc định của MiniMax-H3 (chỉ đoán được lúc tạo; giá trị của cảnh không có ở model này) — hãy kiểm tra',
      'giữ ảnh tham chiếu của cảnh (job Text → Video không gửi ảnh tham chiếu)',
    ])
  })

  it('MiniMax-H3 Text → Video / Khung đầu → cuối (job sent no reference images, mode maybe only guessed): the scene keeps its references and mode', () => {
    const i2vScene = sceneOf(H3('i2v'))
    for (const mode of ['t2v', 'transform'] as const) {
      const t = { ...take([], ['mode', 'resolution', 'refs'], { settings: H3(mode) }), ...snap, refsSnapshot: [], imageKeysSnapshot: [] }
      expect(restoreBlock(t)).toBeNull()
      const r = restorePlan(t, i2vScene)
      expect(r).toMatchObject({ settings: H3('i2v'), kept: ['mode', 'resolution'], guessed: [], keepRefs: true })
      // the scene's own lists, unchanged — never emptied (and no renumbering against the take's empty list)
      expect(r.source).toEqual({ rawPromptSnapshot: snap.rawPromptSnapshot, refsSnapshot: ['a_scene', 'b_scene'], videoRefsSnapshot: ['take_v'] })
      const label = mode === 't2v' ? '≈Text → Video' : '≈Khung đầu → cuối'
      expect(restoreNotes(t, r)).toEqual(['giữ chế độ, độ phân giải của cảnh (chỉ đoán được lúc tạo)', `giữ ảnh tham chiếu của cảnh (job ${label} không gửi ảnh tham chiếu)`])
    }
    // a mode canvasapp did tell: restored, the scene's references still kept
    const told = take([], [], { settings: H3('t2v') })
    const known = restorePlan({ ...told, ...snap, refsSnapshot: [] }, i2vScene)
    expect(known).toMatchObject({ settings: H3('t2v'), kept: [], keepRefs: true })
    expect(restoreNotes(told, known)).toEqual(['giữ ảnh tham chiếu của cảnh (job Text → Video không gửi ảnh tham chiếu)'])
  })

  it('MiniMax-H3 Ảnh → Video guessed from the node: its references come back WITH that mode (a kept Text → Video would leave them unsent)', () => {
    const t = { ...take([], ['mode', 'refs'], { settings: H3('i2v') }), ...snap }
    const r = restorePlan(t, sceneOf(H3('t2v')))
    expect(r).toMatchObject({ settings: H3('i2v'), kept: [], guessed: ['mode'], keepRefs: false })
    expect(r.source.refsSnapshot).toEqual(['a_node'])
    expect(restoreNotes(t, r)).toEqual(['chế độ, ảnh tham chiếu theo node trên canvas cầu nối (đoán) — hãy kiểm tra'])
  })
})

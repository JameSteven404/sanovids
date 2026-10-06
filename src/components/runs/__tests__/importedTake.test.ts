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
  restorableSettings,
  restoreBlock,
  restoreNotes,
  takeCostInferred,
  takeCostKnown,
  takeDurationText,
  takeModeText,
  takeSettingsText,
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
  })

  it('source line, chip and the note of what is not sure', () => {
    expect(importedSourceText(take())).toBe('Tạo trên canvasapp.io.vn (phiên “SanoVids bridge”), nhập vào SanoVids lúc 14:32 06/10 · tên job: Video 9')
    expect(importedSourceText(take([], [], { provider: 'dev' }))).toMatch(/^Tạo trên canvasapp giả lập /)
    expect(importedSourceText(plain())).toBeNull()
    expect(importedChipTitle(take())).toMatch(/“Chạy lại” tạo take mới/)
    expect(importedFieldsNote(take(['resolution', 'refs'], ['mode']))).toBe('không rõ: độ phân giải, ảnh tham chiếu · đoán theo node: chế độ')
    expect(importedFieldsNote(take())).toBeNull()
  })
})

describe('"Khôi phục prompt này" of an imported take', () => {
  const scene: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '720p', ratio: '9:16' }

  it('refused when the prompt or the references are unknown (it would write "" / drop the scene’s references)', () => {
    expect(restoreBlock(plain())).toBeNull()
    expect(restoreBlock(take([], ['refs']))).toBeNull()
    expect(restoreBlock(take(['refs']))).toBe('Take nhập từ canvasapp: không rõ ảnh tham chiếu lúc tạo — không khôi phục được.')
    expect(restoreBlock(take(['prompt', 'refs']))).toBe('Take nhập từ canvasapp: không rõ prompt / ảnh tham chiếu lúc tạo — không khôi phục được.')
  })

  it('settings: only the known ones; the scene keeps its own for unknown or inferred fields (said in the toast)', () => {
    expect(restorableSettings(plain(), scene)).toEqual({ settings: SETTINGS, kept: [] })
    const r = restorableSettings(take(['resolution'], ['ratio']), scene)
    expect(r).toEqual({ settings: { ...SETTINGS, resolution: '720p', ratio: '9:16' }, kept: ['resolution', 'ratio'] })
    expect(restoreNotes(take(['resolution'], ['refs']), r.kept)).toEqual(['giữ độ phân giải, tỉ lệ khung của cảnh (không rõ lúc tạo)', 'ảnh tham chiếu theo node trên canvas cầu nối — hãy kiểm tra'])
    // a scene value the take's model does not have → that model's default (never an invalid setting)
    const h3 = restorableSettings(take(['resolution'], [], { settings: { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } }), scene)
    expect(h3.settings).toMatchObject({ model: 'minimax_h3', resolution: '768p' })
  })
})

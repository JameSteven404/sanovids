// The catalogue, compile, run rules and newer-build markers of the build that SHIPS seedvis (plan §2, §3, §16.1):
// core/seedvisFlag is mocked on for this file only. The build without it: models.test.ts / migrate.test.ts.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../seedvisFlag', () => ({ SEEDVIS_ENABLED: true }))

import { compileScene } from '../compile'
import { foreignMarkOf, lostConfigValues } from '../foreignMark'
import {
  CATALOGUE,
  costOf,
  frameSlots,
  isModelId,
  modeLabel,
  modelLabel,
  MODELS,
  normalizeSettings,
  PICKER_ORDER,
  priceOf,
  SEEDVIS_ENABLED,
  settingsLabel,
  usesRefs,
} from '../models'
import {
  FIRST_FRAME_IMAGE_REASON,
  FRAME_IMAGE_REASON,
  NO_FIRST_FRAME_REASON,
  NO_FRAMES_REASON,
  NO_IMAGE_REASON,
  retiredModelReason,
  runBlock,
  runBlockReason,
} from '../runRules'
import type { Asset, Mode, ModelId, Project, Scene, VideoSettings } from '../types'
import type { SeedvisPriceReference } from '../../providers/seedvis/contract'

const SD_SV: VideoSettings = { model: 'seedvis/seedance_2.5', mode: 't2v', duration: 5, resolution: 'auto', ratio: '21:9' }
const VEO = (mode: Mode): VideoSettings => ({ model: 'seedvis/veo_3.1', mode, duration: 8, resolution: 'auto', ratio: '16:9' })

const ASSETS: Asset[] = [
  // one asset with 11 pictures: @image_1 … @image_11
  { id: 'many', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: Array.from({ length: 11 }, (_, i) => `i${i + 1}`), color: '#fff', position: null },
  { id: 'cave', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['c1'], color: '#fff', position: null },
  { id: 'blank', kind: 'prop', name: 'Kiếm', tag: 'Kiem', description: '', imageIds: [], color: '#fff', position: null },
]

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  order: 1,
  title: 'Test',
  prompt: 'Elara walks',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: SD_SV,
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
  ...over,
})
const project = (s: Scene): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: ASSETS,
  scenes: [s],
})
const compiled = (s: Scene) => compileScene(project(s), s)
const blockOf = (s: Scene) => runBlock({ scene: s, assets: ASSETS, compiled: compiled(s) })
const reasonOf = (s: Scene) => runBlockReason({ scene: s, assets: ASSETS, compiled: compiled(s) })

describe('the build that ships seedvis: catalogue', () => {
  it('offers every route, the pickers per family', () => {
    expect(SEEDVIS_ENABLED).toBe(true)
    expect(Object.keys(MODELS)).toEqual(Object.keys(CATALOGUE))
    for (const id of Object.keys(CATALOGUE)) expect(isModelId(id)).toBe(true)
    expect(PICKER_ORDER).toEqual(['seedance_2_5', 'seedvis/seedance_2.5', 'seedvis/seedance_2.0_fast', 'seedvis/veo_3.1', 'minimax_h3'])
  })

  it('normalizeSettings clamps per route (unknown → Seedance 2.5 canvasapp, as always)', () => {
    expect(normalizeSettings({ model: 'seedvis/veo_3.1' })).toEqual({ model: 'seedvis/veo_3.1', mode: 't2v', duration: 8, resolution: 'auto', ratio: '16:9' })
    expect(normalizeSettings({ model: 'seedvis/veo_3.1', mode: 'first', duration: 5, resolution: '1080p', ratio: '1:1' })).toEqual({
      model: 'seedvis/veo_3.1',
      mode: 'first',
      duration: 8,
      resolution: '1080p',
      ratio: '16:9',
    })
    expect(normalizeSettings({ model: 'seedvis/seedance_2.5', mode: 'first', duration: 20, resolution: '1080p', ratio: '21:9' })).toEqual({
      model: 'seedvis/seedance_2.5',
      mode: 't2v',
      duration: 20,
      resolution: 'auto',
      ratio: '21:9',
    })
    // 20 s is Seedance 2.5's, not 2.0 Fast's: back to its default (5 s)
    expect(normalizeSettings({ model: 'seedvis/seedance_2.0_fast', duration: 20 }).duration).toBe(5)
    expect(normalizeSettings({ model: 'future/model_x' as ModelId })).toEqual(normalizeSettings({}))
    // canvasapp unchanged
    expect(normalizeSettings({ model: 'seedance_2_5', ratio: '21:9', duration: 20 })).toEqual({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '480p', ratio: '16:9' })
  })

  it('which modes send @image, frames and mode names per route', () => {
    expect(usesRefs(SD_SV)).toBe(true)
    expect(usesRefs({ model: 'seedvis/seedance_2.0_fast', mode: 't2v' })).toBe(true)
    expect((['t2v', 'first', 'i2v', 'transform'] as const).map((m) => usesRefs(VEO(m)))).toEqual([false, false, true, false])
    expect(modeLabel('t2v', 'seedvis/seedance_2.5')).toBe('Text → Video (+ảnh)')
    expect((['t2v', 'first', 'i2v', 'transform'] as const).map((m) => modeLabel(m, 'seedvis/veo_3.1'))).toEqual([
      'Text → Video',
      'Khung đầu → Video',
      'Ảnh tham chiếu → Video (1–3 ảnh)',
      'Khung đầu → cuối',
    ])
    // canvasapp's names are unchanged
    expect(modeLabel('t2v', 'minimax_h3')).toBe('Text → Video')
    expect(modeLabel('i2v', 'minimax_h3')).toBe('Ảnh → Video')
    expect(frameSlots(MODELS['seedvis/veo_3.1'], 'first')).toEqual({ first: true, last: false })
    expect(frameSlots(MODELS.minimax_h3, 'transform')).toEqual({ first: true, last: true })
  })

  it('names carry the service now that two are offered; resolutions by their names, never "AUTO"', () => {
    expect(modelLabel('seedance_2_5', { withService: true })).toBe('Seedance 2.5 · canvasapp')
    expect(modelLabel('seedvis/seedance_2.5', { withService: true })).toBe('Seedance 2.5 · seedvis')
    expect(modelLabel('seedvis/seedance_2.5')).toBe('Seedance 2.5') // the file-name token {model} stays the family name
    expect(settingsLabel(VEO('t2v'))).toBe('8s · Gốc · 16:9')
    expect(settingsLabel({ ...VEO('first'), resolution: '1080p', ratio: '9:16' })).toBe('8s · 1080p (phóng to) · 9:16')
    expect(settingsLabel({ model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '2k', ratio: '16:9' })).toBe('5s · 2K · 16:9')
  })

  it('prices: seedvis from the reference table ("≈"), "—" when not measured; costOf 0 then', () => {
    expect(priceOf(SD_SV)).toBeNull()
    expect(costOf(SD_SV)).toBe(0)
    const ref: SeedvisPriceReference = { measuredAt: '2026-10-20', source: 'support', rows: [{ model: 'seedvis/seedance_2.5', duration: 5, credits: 30 }] }
    expect(priceOf(SD_SV, ref)).toEqual({ credits: 30, estimated: true })
    expect(priceOf({ ...SD_SV, duration: 10 }, ref)).toEqual({ credits: 60, estimated: true })
    expect(priceOf({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '720p', ratio: '16:9' }, ref)).toEqual({ credits: 15, estimated: false })
  })
})

describe('the build that ships seedvis: compile', () => {
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => `@image_${i + 1}`).join(' ')

  it('Seedance · seedvis sends at most 10 images: @image_11 is unsent and named with the service', () => {
    const out = compiled(scene({ refs: ['many'], prompt: tokens(11) }))
    expect(out.images.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(out.unsentTokens).toEqual(['@image_11'])
    expect(out.warnings).toContain('Seedance 2.5 · seedvis nhận tối đa 10 ảnh; 1 ảnh cuối sẽ không được gửi.')
    expect(out.warnings).toContain('@image_11 sẽ không được gửi (Seedance 2.5 · seedvis nhận tối đa 10 ảnh) — nhân vật đó không có trong video.')
  })

  it('Veo i2v sends @image_1–3 only', () => {
    const out = compiled(scene({ settings: VEO('i2v'), refs: ['many'], prompt: tokens(4) }))
    expect(out.images.map((i) => i.n)).toEqual([1, 2, 3])
    expect(out.unsentTokens).toEqual(['@image_4'])
  })

  it('Veo "Khung đầu → Video" sends no reference image: its picture is the first frame', () => {
    const out = compiled(scene({ settings: VEO('first'), refs: ['cave'], prompt: 'Rain on @image_1' }))
    expect(out.images).toEqual([])
    expect(out.unsentTokens).toEqual(['@image_1'])
    expect(out.notes).toContain('Chế độ “Khung đầu → Video” của Veo 3.1 · seedvis không gửi ảnh tham chiếu.')
    expect(out.warnings).toContain('Chế độ Khung đầu → Video cần Khung đầu.')
    expect(compiled(scene({ settings: VEO('first'), firstFrame: 'cave' })).warnings).not.toContain('Chế độ Khung đầu → Video cần Khung đầu.')
    expect(compiled(scene({ settings: VEO('transform'), firstFrame: 'cave' })).warnings).toContain('Chế độ Khung đầu → cuối cần đủ Khung đầu và Khung cuối.')
  })

  it('seedvis notes, never blocking: undocumented @image_N, @image_1 as the opening frame, real people refused', () => {
    const notes = compiled(scene({ refs: ['cave'], prompt: '@image_1 at dawn' })).notes
    expect(notes).toContain('seedvis chưa xác nhận hiểu @image_N — thứ tự ảnh gửi đi vẫn đúng @image_1, @image_2…')
    expect(notes).toContain('@image_1 có thể được Seedance 2.5 · seedvis dùng làm khung mở đầu.')
    expect(notes).toContain('Seedance 2.5 · seedvis hay từ chối ảnh có người thật (kể cả ảnh bối cảnh có người).')
    // no image sent → no note; Veo has no "opening frame" / people note
    expect(compiled(scene({ prompt: 'A field' })).notes.some((n) => n.includes('seedvis'))).toBe(false)
    const veo = compiled(scene({ settings: VEO('i2v'), refs: ['cave'], prompt: '@image_1' })).notes
    expect(veo.some((n) => n.includes('khung mở đầu') || n.includes('người thật'))).toBe(false)
    expect(veo).toContain('seedvis chưa xác nhận hiểu @image_N — thứ tự ảnh gửi đi vẫn đúng @image_1, @image_2…')
  })

  it('no mode / resolution code in any message ("FIRST", "T2V", "AUTO")', () => {
    for (const mode of ['t2v', 'first', 'i2v', 'transform'] as const) {
      const out = compiled(scene({ settings: VEO(mode), refs: ['cave', 'blank'], prompt: '@image_1 @image_5' }))
      for (const text of [...out.warnings, ...out.notes]) expect(text).not.toMatch(/\b(FIRST|T2V|I2V|TRANSFORM|AUTO)\b/)
    }
  })
})

describe('the build that ships seedvis: run rules', () => {
  it('Seedance · seedvis with 11 images: @image_11 blocks; Veo i2v with 4: @image_4 blocks', () => {
    const sd = blockOf(scene({ refs: ['many'], prompt: '@image_1 @image_11' }))
    expect(sd).toMatchObject({ kind: 'unsent' })
    expect(sd!.reason).toContain('@image_11')
    const veo = blockOf(scene({ settings: VEO('i2v'), refs: ['many'], prompt: '@image_1 @image_4' }))
    expect(veo).toMatchObject({ kind: 'unsent' })
    expect(veo!.reason).toContain('@image_4')
    expect(reasonOf(scene({ settings: VEO('i2v'), refs: ['many'], prompt: '@image_1 @image_3' }))).toBeNull()
    expect(reasonOf(scene({ settings: VEO('i2v'), prompt: 'no picture' }))).toBe(NO_IMAGE_REASON)
  })

  it('Veo "Khung đầu → Video" needs the first frame only; "Khung đầu → cuối" both', () => {
    expect(reasonOf(scene({ settings: VEO('first') }))).toBe(NO_FIRST_FRAME_REASON)
    expect(reasonOf(scene({ settings: VEO('first'), firstFrame: 'blank' }))).toBe(FIRST_FRAME_IMAGE_REASON)
    expect(reasonOf(scene({ settings: VEO('first'), firstFrame: 'cave' }))).toBeNull()
    // a last frame left over from another mode is not looked at
    expect(reasonOf(scene({ settings: VEO('first'), firstFrame: 'cave', lastFrame: 'blank' }))).toBeNull()
    expect(reasonOf(scene({ settings: VEO('transform'), firstFrame: 'cave' }))).toBe(NO_FRAMES_REASON)
    expect(reasonOf(scene({ settings: VEO('transform'), firstFrame: 'cave', lastFrame: 'blank' }))).toBe(FRAME_IMAGE_REASON)
    expect(reasonOf(scene({ settings: VEO('transform'), firstFrame: 'cave', lastFrame: 'many' }))).toBeNull()
    expect(reasonOf(scene({ settings: VEO('t2v'), prompt: 'A field' }))).toBeNull()
  })

  it('canvasapp keeps its order and texts (H3 "Khung đầu → cuối")', () => {
    const h3 = (over: Partial<Scene>) => scene({ settings: { model: 'minimax_h3', mode: 'transform', duration: 5, resolution: '768p', ratio: '16:9' }, ...over })
    expect(reasonOf(h3({}))).toBe(NO_FRAMES_REASON)
    expect(reasonOf(h3({ firstFrame: 'cave' }))).toBe(NO_FRAMES_REASON)
    expect(reasonOf(h3({ firstFrame: 'cave', lastFrame: 'blank' }))).toBe(FRAME_IMAGE_REASON)
    expect(reasonOf(h3({ firstFrame: 'cave', lastFrame: 'many' }))).toBeNull()
  })

  it('a discontinued route (hidden) is kept but never runs', () => {
    const s = scene({ prompt: 'A field' })
    const spec = { ...MODELS['seedvis/seedance_2.5'], hidden: true as const }
    expect(runBlock({ scene: s, assets: ASSETS, compiled: compiled(s), spec })).toEqual({ kind: 'settings', reason: retiredModelReason('seedvis/seedance_2.5') })
    expect(retiredModelReason('seedvis/seedance_2.5')).toBe('Seedance 2.5 · seedvis đã ngừng — chọn model khác để chạy')
  })
})

describe('the build that ships seedvis: newer-build markers per service', () => {
  it('a canvasapp scene with a seedvis-only value (21:9, 20 s, "first") is a newer build’s: marked, not fixed', () => {
    expect(lostConfigValues({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '480p', ratio: '21:9' }, false)).toEqual([{ key: 'ratio', value: '21:9' }])
    expect(lostConfigValues({ model: 'seedance_2_5', mode: 't2v', duration: 20, resolution: '480p', ratio: '16:9' }, false)).toEqual([{ key: 'duration', value: 20 }])
    expect(lostConfigValues({ model: 'minimax_h3', mode: 'first', duration: 5, resolution: '768p', ratio: '16:9' }, false)).toEqual([{ key: 'mode', value: 'first' }])
    expect(lostConfigValues({ model: 'minimax_h3', mode: 't2v', duration: 5, resolution: 'auto', ratio: '16:9' }, false)).toEqual([{ key: 'resolution', value: 'auto' }])
    // an older build's own canvasapp mix is still quietly fixed
    expect(lostConfigValues({ model: 'seedance_2_5', mode: 'i2v', duration: 10, resolution: '2k', ratio: '16:9' }, false)).toEqual([])
  })

  it('a seedvis scene: values of another seedvis route are an own mix; values no seedvis route has are marked', () => {
    expect(lostConfigValues({ ...VEO('t2v'), ratio: '1:1', duration: 30 }, false)).toEqual([])
    expect(lostConfigValues({ ...VEO('t2v'), mode: 'r2v' }, false)).toEqual([{ key: 'mode', value: 'r2v' }])
    expect(lostConfigValues({ ...SD_SV, resolution: '1080p' }, false)).toEqual([])
    expect(lostConfigValues({ ...SD_SV, resolution: '4k' }, false)).toEqual([{ key: 'resolution', value: '4k' }])
  })

  it('settings of a seedvis take restored onto a scene carry no marker; an unknown seedvis route does', () => {
    expect(foreignMarkOf(VEO('first'))).toBeNull()
    expect(foreignMarkOf({ ...VEO('first'), model: 'seedvis/omni_flash' })).toEqual({
      foreignModel: 'seedvis/omni_flash',
      foreignSettings: { ...VEO('first'), model: 'seedvis/omni_flash' },
    })
  })
})

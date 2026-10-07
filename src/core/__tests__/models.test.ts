import { describe, expect, it } from 'vitest'
import { imageFallbackName, imageFallbackNames } from '../compile'
import {
  CANVASAPP_MODELS,
  CATALOGUE,
  costOf,
  frameSlots,
  isModelId,
  MODE_LABEL,
  modeLabel,
  modelLabel,
  MODELS,
  normalizeSettings,
  PICKER_ORDER,
  pickerOrder,
  presetSettings,
  priceOf,
  referencePrice,
  sameSettings,
  SEEDVIS_ENABLED,
  serviceOf,
  settingsLabel,
  specOf,
  usesRefs,
} from '../models'
import { SEEDVIS_ROUTE_TABLE } from '../seedvisRoutes'
import { CANVASAPP_MODEL_IDS, SEEDVIS_MODEL_IDS } from '../services'
import type { Mode, ModelId, VideoSettings } from '../types'
import type { SeedvisPriceReference } from '../../providers/seedvis/contract'
import * as projectStore from '../../store/project'

describe('modeLabel', () => {
  it('says "+ảnh" only where the mode sends reference images', () => {
    expect(modeLabel('t2v', 'seedance_2_5')).toBe(MODE_LABEL.t2v)
    expect(modeLabel('t2v', 'minimax_h3')).toBe('Text → Video')
    expect(modeLabel('i2v', 'minimax_h3')).toBe('Ảnh → Video')
    expect(modeLabel('transform', 'minimax_h3')).toBe('Khung đầu → cuối')
    expect(modeLabel('t2v')).toBe('Text → Video')
  })
})

describe('imageFallbackName', () => {
  it('name, else tag, else "ảnh"', () => {
    expect(imageFallbackName({ name: ' Elara ', tag: 'E' })).toBe('Elara')
    expect(imageFallbackName({ name: '   ', tag: 'Lumi' })).toBe('Lumi')
    expect(imageFallbackName({ name: '', tag: '' })).toBe('ảnh')
    expect(imageFallbackName(undefined)).toBe('ảnh')
    expect(imageFallbackNames([{ id: 'a', name: '', tag: 'T' }])('a')).toBe('T')
    expect(imageFallbackNames([])('x')).toBe('ảnh')
  })
  // Test giới hạn monkey (seed ee1219bb, P3): an asset named like a token turned the text into a token of another picture
  it('never an "@": a name like a token or a mention stays plain text', () => {
    expect(imageFallbackName({ name: '@@image_1', tag: 'X' })).toBe('image_1')
    expect(imageFallbackName({ name: '@Lumi ở @video 2', tag: 'X' })).toBe('Lumi ở video 2')
    expect(imageFallbackName({ name: ' @ ', tag: '@Elara' })).toBe('Elara')
    expect(imageFallbackName({ name: '@@', tag: '@' })).toBe('ảnh')
  })
})

// ---------------------------------------------------------------------------------------------
// Catalogue (plan §2): this build WITHOUT seedvis switched on — the seedvis routes exist as data only.
// The build that ships them: seedvisCatalogue.test.ts (the flag mocked on).
// ---------------------------------------------------------------------------------------------

const MODES: readonly Mode[] = ['t2v', 'i2v', 'transform', 'first']

describe('catalogue (SEEDVIS_ENABLED false)', () => {
  it('seedvis stays switched off until wave C flips it — with the per-scene engine (B2) merged', () => {
    // Flipping it before B2 would hand seedvis scenes to the canvasapp queue (store/runs check uses activeProviderId).
    expect(SEEDVIS_ENABLED).toBe(false)
  })

  it('every id ever shipped stays in the catalogue (never deleted; a discontinued route is `hidden`)', () => {
    expect(Object.keys(CATALOGUE)).toEqual(['seedance_2_5', 'minimax_h3', 'seedvis/seedance_2.5', 'seedvis/seedance_2.0_fast', 'seedvis/veo_3.1'])
    expect(Object.keys(CANVASAPP_MODELS)).toEqual([...CANVASAPP_MODEL_IDS])
    for (const id of Object.keys(CATALOGUE) as ModelId[]) {
      const m = CATALOGUE[id]
      expect(m.id).toBe(id)
      expect(id.length).toBeLessThanOrEqual(64) // survives a build without seedvis (foreignMark FOREIGN_ID_MAX)
      expect(m.service).toBe(id.startsWith('seedvis/') ? 'seedvis' : 'canvasapp')
      expect(m.remoteModel).toBeTruthy()
      expect(['seedance', 'minimax', 'veo']).toContain(m.family)
      for (const list of [m.modes, m.durations, m.resolutions, m.ratios]) expect(list.length).toBeGreaterThan(0)
      expect(m.durations).toContain(m.defaultDuration)
      for (const mode of [...m.imageModes, ...(Object.keys(m.frameModes) as Mode[]), ...(m.ratioFromFrames ?? [])]) expect(m.modes).toContain(mode)
      expect(m.hidden).toBeUndefined()
    }
  })

  it('offers and runs canvasapp only: a seedvis id is a newer build’s model here', () => {
    expect(Object.keys(MODELS)).toEqual(['seedance_2_5', 'minimax_h3'])
    expect(PICKER_ORDER).toEqual(['seedance_2_5', 'minimax_h3'])
    for (const id of SEEDVIS_MODEL_IDS) {
      const s: VideoSettings = { model: id, mode: 't2v', duration: 5, resolution: 'auto', ratio: '16:9' }
      expect(isModelId(id)).toBe(false)
      expect(normalizeSettings({ model: id })).toEqual(normalizeSettings({}))
      expect(costOf(s)).toBe(0)
      expect(priceOf(s)).toBeNull()
    }
    // the build that ships seedvis: per family, canvasapp's Seedance first
    expect(pickerOrder(true)).toEqual(['seedance_2_5', 'seedvis/seedance_2.5', 'seedvis/seedance_2.0_fast', 'seedvis/veo_3.1', 'minimax_h3'])
    expect(pickerOrder(false)).toEqual([...PICKER_ORDER])
  })

  it('canvasapp: usesRefs / frameSlots answer exactly as 0.6.0 for every combination', () => {
    const oldUsesRefs = (s: { model: string; mode: string }) => s.model === 'seedance_2_5' || s.mode === 'i2v'
    for (const model of ['seedance_2_5', 'minimax_h3', 'veo_3_1', 'seedvis/veo_3.1', ''] as ModelId[]) {
      for (const mode of MODES) {
        expect(usesRefs({ model, mode }), `${model} ${mode}`).toBe(oldUsesRefs({ model, mode }))
        if (isModelId(model)) expect(frameSlots(MODELS[model], mode)).toEqual({ first: mode === 'transform', last: mode === 'transform' })
      }
    }
    expect(modeLabel('first')).toBe('Khung đầu → Video')
    expect(MODE_LABEL.first).toBe('Khung đầu → Video')
  })

  it('normalizeSettings: unchanged for canvasapp (15 s when offered, first resolution, 16:9)', () => {
    expect(normalizeSettings({})).toEqual({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '480p', ratio: '16:9' })
    expect(normalizeSettings({ model: 'minimax_h3', mode: 'first', duration: 8, resolution: 'auto', ratio: '21:9' })).toEqual({
      model: 'minimax_h3',
      mode: 't2v',
      duration: 15,
      resolution: '768p',
      ratio: '16:9',
    })
  })

  it('names: the family name, the service only where it is ambiguous; settingsLabel unchanged for canvasapp', () => {
    expect(modelLabel('seedance_2_5')).toBe('Seedance 2.5')
    // canvasapp is the only service offered: its labels stay bare
    expect(modelLabel('seedance_2_5', { withService: true })).toBe('Seedance 2.5')
    expect(modelLabel('seedvis/seedance_2.5', { withService: true })).toBe('Seedance 2.5 · seedvis')
    expect(modelLabel('seedvis/veo_3.1')).toBe('Veo 3.1')
    expect(modelLabel('future/model_x', { withService: true })).toBe('future/model_x')
    expect(settingsLabel({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '480p', ratio: '16:9' })).toBe('15s · 480P · 16:9')
    // a seedvis take while seedvis is off: shown like any newer build's take (no route words)
    expect(settingsLabel({ model: 'seedvis/veo_3.1', mode: 'first', duration: 8, resolution: 'auto', ratio: '9:16' })).toBe('8s · AUTO · 9:16')
  })

  it('specOf / serviceOf read the catalogue (data only); an unknown id is canvasapp’s Seedance 2.5', () => {
    expect(specOf('seedvis/veo_3.1')).toBe(CATALOGUE['seedvis/veo_3.1'])
    expect(serviceOf('seedvis/seedance_2.0_fast')).toBe('seedvis')
    expect(serviceOf('minimax_h3')).toBe('canvasapp')
    for (const id of ['future/model_x', '', undefined, null, 'constructor', '__proto__']) {
      expect(specOf(id)).toBe(CATALOGUE.seedance_2_5)
      expect(serviceOf(id)).toBe('canvasapp')
    }
  })

  it('one image cap per seedvis model, the one its request route allows (single-cap invariant)', () => {
    for (const id of SEEDVIS_MODEL_IDS) {
      const spec = CATALOGUE[id]
      const imageRequests = SEEDVIS_ROUTE_TABLE[id].requests.filter((r) => spec.imageModes.includes(r.mode) && r.maxImages > 0)
      expect(imageRequests.length).toBeGreaterThan(0)
      for (const r of imageRequests) expect(r.maxImages).toBe(spec.maxRefImages)
    }
    expect([CATALOGUE['seedvis/seedance_2.5'].maxRefImages, CATALOGUE['seedvis/veo_3.1'].maxRefImages]).toEqual([10, 3])
    // Veo "Khung đầu → Video" takes its picture from the first-frame slot, never from refs
    const veo = CATALOGUE['seedvis/veo_3.1']
    expect(veo.imageModes).toEqual(['i2v'])
    expect(frameSlots(veo, 'first')).toEqual({ first: true, last: false })
    expect(frameSlots(veo, 'transform')).toEqual({ first: true, last: true })
    expect(frameSlots(veo, 'i2v')).toEqual({ first: false, last: false })
    expect(frameSlots(CATALOGUE['seedvis/seedance_2.5'], 'transform')).toEqual({ first: false, last: false })
  })

  it('priceOf: canvasapp’s table exactly (never estimated); a missing cell or an unknown model → null ("—")', () => {
    for (const id of CANVASAPP_MODEL_IDS) {
      const spec = CANVASAPP_MODELS[id]
      for (const resolution of spec.resolutions) {
        for (const duration of spec.durations) {
          const s: VideoSettings = { model: id, mode: spec.modes[0], duration, resolution, ratio: '16:9' }
          expect(priceOf(s)).toEqual({ credits: spec.pricing[resolution][duration], estimated: false })
          expect(costOf(s)).toBe(spec.pricing[resolution][duration])
        }
      }
    }
    const odd: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 7, resolution: '480p', ratio: '16:9' }
    expect([priceOf(odd), costOf(odd)]).toEqual([null, 0])
    expect(priceOf({ ...odd, model: 'future/model_x' as ModelId, duration: 5 })).toBeNull()
  })

  it('referencePrice: exact row, linear between measured durations, per second beyond them, null when unmeasured', () => {
    const ref: SeedvisPriceReference = {
      measuredAt: '2026-10-20',
      source: 'live-test',
      rows: [
        { model: 'seedvis/seedance_2.0_fast', duration: 5, credits: 20 },
        { model: 'seedvis/seedance_2.0_fast', duration: 15, credits: 50 },
        { model: 'seedvis/veo_3.1', duration: 4, upscale: 'none', credits: 40 },
        { model: 'seedvis/veo_3.1', duration: 8, upscale: '1080p', credits: 100 },
      ],
    }
    expect(referencePrice('seedvis/seedance_2.0_fast', 5, 'auto', ref)).toEqual({ credits: 20, estimated: true })
    expect(referencePrice('seedvis/seedance_2.0_fast', 10, 'auto', ref)).toEqual({ credits: 35, estimated: true })
    // per second from the nearest measured row on one side
    expect(referencePrice('seedvis/veo_3.1', 6, 'auto', ref)).toEqual({ credits: 60, estimated: true })
    expect(referencePrice('seedvis/veo_3.1', 4, '1080p', ref)).toEqual({ credits: 50, estimated: true })
    // "Gốc" and "1080p (phóng to)" are priced apart; a model without a row → "—"
    expect(referencePrice('seedvis/veo_3.1', 8, '1080p', ref)).toEqual({ credits: 100, estimated: true })
    expect(referencePrice('seedvis/seedance_2.5', 5, 'auto', ref)).toBeNull()
    expect(referencePrice('seedvis/seedance_2.0_fast', 0, 'auto', ref)).toBeNull()
    expect(referencePrice('seedvis/seedance_2.0_fast', Number.NaN, 'auto', ref)).toBeNull()
    // shipped empty in waves A–B: nothing is invented
    expect(referencePrice('seedvis/seedance_2.0_fast', 5, 'auto')).toBeNull()
  })

  it('presetSettings / sameSettings live in core/models (store/project re-exports the same functions)', () => {
    expect(projectStore.presetSettings).toBe(presetSettings)
    expect(projectStore.sameSettings).toBe(sameSettings)
    const s: VideoSettings = { model: 'minimax_h3', mode: 'i2v', duration: 10, resolution: '2k', ratio: '9:16' }
    expect(presetSettings({ id: 'p', name: 'P', ...s })).toEqual(s)
    expect(sameSettings(s, { ...s })).toBe(true)
    expect(sameSettings(s, { ...s, ratio: '16:9' })).toBe(false)
  })
})

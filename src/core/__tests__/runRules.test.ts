// runBlockReason: the one list of "why this scene cannot run" (engine check(), scene card, inspector, storyboard).
// The canonical order and wording are the engine's (store/runs check() before 0.6.0). Visible changes against the old
// copies (CHANGELOG 0.6.0):
//   - card / inspector: up to 3 unsent tokens + "…" (was 2), in the engine's sentence;
//   - inspector: also "Prompt quá dài", "Thiếu ảnh tham chiếu", "Khung đầu/cuối chưa có ảnh";
//   - scene table / storyboard Run buttons: the full rule list (was: empty prompt only);
//   - a sure refusal of the settings by the gateway (settingsBlock, /api/video-profiles) comes last.
// Reference videos were retired (0.6.0, "Đợt RV"): @video text left in a prompt is kept verbatim and blocks the run
// with its own sentence (rule 7, before the generic unsent-token rule 8, which now speaks of images only); a scene
// that once used reference videos but whose prompt names none runs with its images; no take status or gateway video
// cap is asked any more.
import { describe, expect, it } from 'vitest'
import { compileScene } from '../compile'
import * as gate from '../runGate'
import {
  compiledOf,
  EMPTY_PROMPT_REASON,
  FRAME_IMAGE_REASON,
  foreignConfigReason,
  foreignModelReason,
  LONG_PROMPT_REASON,
  mismatchReason,
  NO_FRAMES_REASON,
  NO_IMAGE_REASON,
  refStatusLookup,
  retiredVideoReason,
  runBlockReason,
  sceneRunBlockReason,
  unsentTokensReason,
  waitingReason,
} from '../runRules'
import type { Asset, Project, Scene, VideoSettings } from '../types'

const SD: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' }
const H3 = (mode: VideoSettings['mode']): VideoSettings => ({ model: 'minimax_h3', mode, duration: 5, resolution: '768p', ratio: '16:9' })

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  order: 1,
  title: 'Test',
  prompt: 'Elara walks',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: SD,
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
  ...over,
})
const ASSETS: Asset[] = [
  { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1', 'i2'], color: '#fff', position: null },
  { id: 'b', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i3'], color: '#fff', position: null },
  { id: 'empty', kind: 'prop', name: 'Kiếm', tag: 'Kiem', description: '', imageIds: [], color: '#fff', position: null },
]
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

/** Reason the way check() computes it. */
function reasonOf(s: Scene, settingsBlock: string | null = null): string | null {
  return runBlockReason({ scene: s, assets: ASSETS, compiled: compileScene(project(s), s), settingsBlock })
}

describe('runBlockReason — each rule', () => {
  it('a scene that can run has no reason', () => {
    expect(reasonOf(scene())).toBeNull()
    expect(reasonOf(scene({ prompt: '@image_1 and @image_3', refs: ['a', 'b'] }))).toBeNull()
  })

  it('1. a model of a newer SanoVids build blocks first, whatever else is wrong', () => {
    const s = scene({ prompt: '', foreignModel: 'model_x@futurevendor' })
    expect(reasonOf(s)).toBe(foreignModelReason('model_x@futurevendor'))
    expect(foreignModelReason('model_x@futurevendor')).toBe(
      'Cảnh dùng model của bản SanoVids mới hơn (model_x@futurevendor) — cập nhật SanoVids để chạy (hoặc chọn lại model để chạy bằng model này).',
    )
    expect(reasonOf(scene({ foreignModel: '' }))).toBeNull()
    expect(reasonOf(scene({ prompt: '@video_1', foreignModel: 'veo' }))).toBe(foreignModelReason('veo'))
  })

  it('1b. values of a newer build for a model this build knows (config marker: foreignSettings alone) block too', () => {
    const config = { model: 'seedance_2_5', mode: 't2v', duration: 20, resolution: '4k', ratio: '16:9' }
    const s = scene({ prompt: '', foreignSettings: config })
    expect(reasonOf(s)).toBe(foreignConfigReason(config))
    expect(foreignConfigReason(config)).toBe(
      'Cảnh dùng cấu hình của bản SanoVids mới hơn (thời lượng 20s, độ phân giải 4k) — cập nhật SanoVids để chạy (hoặc chọn lại cấu hình để chạy bằng cấu hình này).',
    )
    // a model marker wins (its own text)
    expect(reasonOf(scene({ foreignModel: 'veo', foreignSettings: config }))).toBe(foreignModelReason('veo'))
  })

  it('2. empty prompt', () => {
    expect(reasonOf(scene({ prompt: '' }))).toBe(EMPTY_PROMPT_REASON)
    expect(reasonOf(scene({ prompt: '  \n\t ' }))).toBe('Prompt trống')
  })

  it('3. prompt longer than the model allows (code points, after trimming)', () => {
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: 'a'.repeat(7001) }))).toBe(LONG_PROMPT_REASON)
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: '  ' + 'ạ'.repeat(7000) + '  ' }))).toBeNull()
    expect(reasonOf(scene({ settings: H3('transform'), prompt: 'a'.repeat(7001), firstFrame: 'a', lastFrame: 'b' }))).toBeNull()
  })

  it('4. image → video without any image that is sent', () => {
    expect(reasonOf(scene({ settings: H3('i2v') }))).toBe(NO_IMAGE_REASON)
    expect(reasonOf(scene({ settings: H3('i2v'), refs: ['empty'] }))).toBe('Thiếu ảnh tham chiếu')
    expect(reasonOf(scene({ settings: H3('i2v'), refs: ['a'] }))).toBeNull()
  })

  it('5–6. first → last frame needs both frames, each with an image', () => {
    expect(reasonOf(scene({ settings: H3('transform') }))).toBe(NO_FRAMES_REASON)
    expect(reasonOf(scene({ settings: H3('transform'), firstFrame: 'a' }))).toBe('Thiếu khung đầu/cuối')
    expect(reasonOf(scene({ settings: H3('transform'), firstFrame: 'a', lastFrame: 'empty' }))).toBe(FRAME_IMAGE_REASON)
    expect(reasonOf(scene({ settings: H3('transform'), firstFrame: 'gone', lastFrame: 'b' }))).toBe('Khung đầu/cuối chưa có ảnh')
    expect(reasonOf(scene({ settings: H3('transform'), firstFrame: 'a', lastFrame: 'b' }))).toBeNull()
  })

  it('7. retired @video text: its own sentence, every spelling, 3 tokens then "…", in every mode', () => {
    expect(reasonOf(scene({ prompt: 'Continue from @video_1: Elara walks' }))).toBe(retiredVideoReason(['@video_1']))
    expect(retiredVideoReason(['@video_1'])).toBe('Prompt còn @video_1 — SanoVids đã bỏ video tham chiếu: xoá hoặc viết lại chữ đó để chạy')
    expect(reasonOf(scene({ prompt: '@Video 2 @VIDEO3 @video_?4(S01·T1) @video_5' }))).toBe(
      'Prompt còn @Video 2, @VIDEO3, @video_?4(S01·T1)… — SanoVids đã bỏ video tham chiếu: xoá hoặc viết lại chữ đó để chạy',
    )
    // whatever the mode (it used to be "unsent" text in a mode without videos) and whatever links the scene had
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: '@video_1' }))).toBe(retiredVideoReason(['@video_1']))
    expect(reasonOf(scene({ prompt: '@video_1', legacyVideoRefs: ['t1'] }))).toBe(retiredVideoReason(['@video_1']))
    // not a token anywhere: plain text runs
    expect(reasonOf(scene({ prompt: 'video @video2go @video1abc' }))).toBeNull()
  })

  it('7 before 8: a scene with a wrong @image number AND @video text gets the specific @video sentence', () => {
    expect(reasonOf(scene({ prompt: '@image_9 then @video_1', refs: ['b'] }))).toBe(retiredVideoReason(['@video_1']))
    expect(reasonOf(scene({ prompt: '@image_9 then plain', refs: ['b'] }))).toBe(unsentTokensReason(['@image_9']))
  })

  it('8. tokens with no picture in the request: the engine sentence (images only), 3 tokens then "…"', () => {
    expect(reasonOf(scene({ prompt: '@image_2', refs: ['b'] }))).toBe('Prompt nhắc @image_2 nhưng không có ảnh đó trong lần gửi — sửa số hoặc nối thêm ảnh')
    expect(reasonOf(scene({ prompt: '@image_1 @image_2 @image_3 @image_4' }))).toBe(unsentTokensReason(['@image_1', '@image_2', '@image_3', '@image_4']))
    expect(unsentTokensReason(['@image_1', '@image_2', '@image_3', '@image_4'])).toBe(
      'Prompt nhắc @image_1, @image_2, @image_3… nhưng không có ảnh đó trong lần gửi — sửa số hoặc nối thêm ảnh',
    )
    expect(unsentTokensReason(['@image_1', '@image_2', '@image_3'])).not.toContain('…')
    // a placeholder left by an edit
    expect(reasonOf(scene({ prompt: 'x @image_?2', refs: ['a'] }))).toMatch(/^Prompt nhắc @image_\?2 /)
  })

  it('a scene that once used reference videos but names none runs with its images (it was blocked before)', () => {
    expect(reasonOf(scene({ prompt: '@image_1 walks', refs: ['a'], legacyVideoRefs: ['t1', 'gone'] }))).toBeNull()
    expect(reasonOf(scene({ settings: H3('t2v'), legacyVideoRefs: ['t1'] }))).toBeNull()
  })

  it('9. a sure refusal of the settings by the gateway comes last; a newer build’s marker still first', () => {
    const LOCKED = 'MiniMax-H3 hiện không khả dụng trên canvasapp'
    expect(reasonOf(scene({ settings: H3('t2v') }), LOCKED)).toBe(LOCKED)
    expect(reasonOf(scene({ settings: H3('t2v') }), null)).toBeNull()
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: ' ' }), LOCKED)).toBe(EMPTY_PROMPT_REASON)
    expect(reasonOf(scene({ prompt: '@video_1' }), LOCKED)).toBe(retiredVideoReason(['@video_1']))
    expect(reasonOf(scene({ foreignModel: 'veo' }), LOCKED)).toBe(foreignModelReason('veo'))
  })

  it('the first failing rule wins (engine order)', () => {
    expect(reasonOf(scene({ prompt: '', settings: H3('i2v') }))).toBe(EMPTY_PROMPT_REASON)
    expect(reasonOf(scene({ prompt: 'a'.repeat(7001), settings: H3('i2v') }))).toBe(LONG_PROMPT_REASON)
    expect(reasonOf(scene({ prompt: '@image_1 @video_1', settings: H3('i2v') }))).toBe(NO_IMAGE_REASON)
    expect(reasonOf(scene({ prompt: '@image_5 @video_1', settings: H3('transform') }))).toBe(NO_FRAMES_REASON)
    expect(reasonOf(scene({ prompt: '@image_5 @video_1' }))).toBe(retiredVideoReason(['@video_1']))
  })

  it('old call shapes still compile and the retired inputs are ignored', () => {
    const s = scene({ prompt: '@video_1' })
    const compiled = compileScene(project(s), s)
    const old = runBlockReason({ scene: s, assets: ASSETS, compiled, takeStatus: () => 'completed', providerVideoCap: 10 })
    expect(old).toBe(retiredVideoReason(['@video_1']))
    expect(runBlockReason({ scene: scene(), assets: ASSETS, compiled: compileScene(project(scene()), scene()), takeStatus: () => undefined, providerVideoCap: 0 })).toBeNull()
    expect(refStatusLookup(['t1'], 'completed')('t1')).toBeUndefined()
  })
})

describe('runBlockReason = the documented order on a matrix of scenes', () => {
  /** The v0.5.0 engine's image rules (store/runs check()) with the 0.6.0 retired-@video rule in front of rule 8. */
  function expected(s: Scene): string | null {
    const compiled = compileScene(project(s), s)
    if (!s.prompt.trim()) return 'Prompt trống'
    if (compiled.charCount > compiled.limit) return 'Prompt quá dài'
    if (s.settings.mode === 'i2v' && compiled.images.length === 0) return 'Thiếu ảnh tham chiếu'
    if (s.settings.mode === 'transform' && (!s.firstFrame || !s.lastFrame)) return 'Thiếu khung đầu/cuối'
    if (s.settings.mode === 'transform' && [s.firstFrame, s.lastFrame].some((id) => !ASSETS.find((a) => a.id === id)?.imageIds[0])) return 'Khung đầu/cuối chưa có ảnh'
    const retired = [...new Set(s.prompt.trim().match(/@video(?:_\?\d+(?:\([^()\n]{1,60}\))?|[ _]?\d+\b)/gi) ?? [])]
    if (retired.length) return `Prompt còn ${retired.slice(0, 3).join(', ')}${retired.length > 3 ? '…' : ''} — SanoVids đã bỏ video tham chiếu: xoá hoặc viết lại chữ đó để chạy`
    if (compiled.unsentTokens.length)
      return `Prompt nhắc ${compiled.unsentTokens.slice(0, 3).join(', ')}${compiled.unsentTokens.length > 3 ? '…' : ''} nhưng không có ảnh đó trong lần gửi — sửa số hoặc nối thêm ảnh`
    return null
  }

  it('agrees on a matrix of scenes (legacy links never matter)', () => {
    const prompts = ['', 'plain', '@image_1', '@image_3 @image_9', '@video_1', 'Continue from @video_2: x', 'a'.repeat(7001), '@image_?1', '@video_?3(S01·T1) @image_1']
    const settings = [SD, H3('t2v'), H3('i2v'), H3('transform')]
    const refsList = [[], ['a'], ['empty'], ['a', 'b']]
    const legacyList = [undefined, ['t1'], ['t1', 'gone']]
    const frames: [string | null, string | null][] = [
      [null, null],
      ['a', 'b'],
      ['a', 'empty'],
    ]
    let n = 0
    for (const prompt of prompts)
      for (const st of settings)
        for (const refs of refsList)
          for (const legacyVideoRefs of legacyList)
            for (const [firstFrame, lastFrame] of frames) {
              const s = scene({ prompt, settings: st, refs, legacyVideoRefs, firstFrame, lastFrame })
              expect(reasonOf(s), JSON.stringify({ prompt: prompt.slice(0, 12), st, refs, legacyVideoRefs, firstFrame, lastFrame })).toBe(expected(s))
              n++
            }
    expect(n).toBe(9 * 4 * 4 * 3 * 3)
  })
})

describe('UI helpers', () => {
  it('compiledOf caches per scene object and assets array', () => {
    const s = scene({ prompt: '@image_2', refs: ['a'] })
    const first = compiledOf(ASSETS, s)
    expect(compiledOf(ASSETS, s)).toBe(first)
    expect(first).toEqual(compileScene(project(s), s))
    const moreAssets = [...ASSETS]
    expect(compiledOf(moreAssets, s)).not.toBe(first)
    const edited = { ...s, prompt: '@image_3' }
    expect(compiledOf(moreAssets, edited).unsentTokens).toEqual(['@image_3'])
  })

  it('sceneRunBlockReason = runBlockReason with the cached compile', () => {
    expect(sceneRunBlockReason(ASSETS, scene({ prompt: '@video_1' }))).toBe(retiredVideoReason(['@video_1']))
    expect(sceneRunBlockReason(ASSETS, scene({ prompt: ' ' }))).toBe(EMPTY_PROMPT_REASON)
    expect(sceneRunBlockReason(ASSETS, scene(), 'X')).toBe('X')
    expect(sceneRunBlockReason(ASSETS, scene())).toBeNull()
  })

  it('core/runGate (the one-scene Run buttons) answers with this same list, newer-build markers included', () => {
    const s = scene({ prompt: '', foreignModel: 'veo' })
    expect(gate.sceneRunBlock(s, ASSETS)).toBe(foreignModelReason('veo'))
    expect(gate.runBlockReason(s, compileScene(project(s), s), ASSETS)).toBe(foreignModelReason('veo'))
    const v = scene({ prompt: '@video_1', legacyVideoRefs: ['t1'] })
    expect(gate.sceneRunBlock(v, ASSETS, 'X')).toBe(retiredVideoReason(['@video_1']))
    expect(gate.sceneRunBlock(scene({ legacyVideoRefs: ['t1'] }), ASSETS, 'X')).toBe('X')
    expect(gate.runBlockReason(scene(), compileScene(project(scene()), scene()), ASSETS, { settingsBlock: 'X' })).toBe('X')
  })
})

describe('runBlockReason — red placeholders (GT1)', () => {
  it('8a. labelled placeholders name who they wait for (3, then "…") before any other unsent token', () => {
    expect(reasonOf(scene({ prompt: '@image_?2(Lumi) waves at @image_1', refs: ['a'] }))).toBe(waitingReason([{ name: 'Lumi', token: '@image_?2' }]))
    expect(waitingReason([{ name: 'Lumi', token: '@image_?2' }])).toBe(
      'Còn chữ đỏ chờ ảnh: Lumi (@image_?2) — nối ảnh thay thế rồi bấm “Gắn vào chỗ…”, hoặc bấm “Đổi thành chữ” nếu không cần nhân vật đó',
    )
    const many = reasonOf(scene({ prompt: '@image_?1(A) @image_?2(B) @image_?3(C · ảnh 2) @image_?4(D) @image_9' }))
    expect(many).toBe('Còn chữ đỏ chờ ảnh: A (@image_?1), B (@image_?2), C · ảnh 2 (@image_?3)… — nối ảnh thay thế rồi bấm “Gắn vào chỗ…”, hoặc bấm “Đổi thành chữ” nếu không cần nhân vật đó')
  })
  it('8a\'. a labelled token whose label does not fit its picture ("?" deleted by hand) keeps blocking', () => {
    // a = Elara (1, 2), b = Cave (3)
    expect(reasonOf(scene({ prompt: '@image_3(Lumi) walks', refs: ['a', 'b'] }))).toBe(mismatchReason(3, 'Cave', 'Lumi'))
    expect(mismatchReason(3, 'Cave', 'Lumi')).toBe('@image_3 đang là “Cave”, không phải “Lumi” — kiểm tra ở dải “Chữ đỏ chờ ảnh” dưới ô prompt')
    expect(reasonOf(scene({ prompt: '@image_3(Cave) walks', refs: ['a', 'b'] }))).toBeNull()
    expect(reasonOf(scene({ prompt: '@image_1(Elara · ảnh 2) walks', refs: ['a'] }))).toBe(mismatchReason(1, 'Elara', 'Elara · ảnh 2'))
  })
  it('8b. a bare placeholder keeps the old generic sentence', () => {
    expect(reasonOf(scene({ prompt: '@image_1 and @image_?2', refs: ['b'] }))).toBe(unsentTokensReason(['@image_?2']))
  })
  it('the retired @video sentence still wins over placeholders', () => {
    expect(reasonOf(scene({ prompt: '@image_?2(Lumi) @video_1' }))).toBe(retiredVideoReason(['@video_1']))
  })
})

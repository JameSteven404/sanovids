// runBlockReason: the one list of "why this scene cannot run" (engine check(), scene card, inspector, scene table,
// storyboard). The canonical order and wording are the engine's (store/runs check() before 0.6.0), plus the card's more
// precise "deleted video" sentence. Visible changes against the old copies (CHANGELOG 0.6.0):
//   - card / inspector: up to 3 unsent tokens + "…" (was 2), in the engine's sentence;
//   - card / inspector: @video blocks only when videos are REALLY sent past the gateway limit (was: any videoRefs),
//     with NO_VIDEO_REFS_REASON; a mode that sends no video runs (the engine always let it);
//   - inspector: also "Prompt quá dài", "Thiếu ảnh tham chiếu", "Khung đầu/cuối chưa có ảnh";
//   - engine: "Video tham chiếu đã bị xoá — bỏ video đó khỏi cảnh" instead of "chưa sẵn sàng" when the take is gone;
//   - scene table / storyboard Run buttons: the full rule list (was: empty prompt only).
// Merged with the @video gate of PR #11 (core/runGate.test.ts tests the same list through runGate's call shapes):
//   - engine: the gateway's @video cap is checked BEFORE readiness (waiting for a video would not help), and readiness
//     only looks at the SENT videos — a leftover reference of a mode that sends none never blocks (it did before);
//   - NO_VIDEO_REFS_REASON says to remove the reference, not the token ("bỏ video tham chiếu khỏi cảnh");
//   - a sure refusal of the settings by the gateway (settingsBlock, /api/video-profiles) comes last.
import { describe, expect, it } from 'vitest'
import { compileScene } from '../compile'
import * as gate from '../runGate'
import {
  compiledOf,
  DELETED_VIDEO_REASON,
  EMPTY_PROMPT_REASON,
  FRAME_IMAGE_REASON,
  foreignConfigReason,
  foreignModelReason,
  LONG_PROMPT_REASON,
  NO_FRAMES_REASON,
  NO_IMAGE_REASON,
  NO_VIDEO_REFS_REASON,
  PENDING_VIDEO_REASON,
  refVideosProblem,
  runBlockReason,
  sceneRunBlockReason,
  takeStatusFromKey,
  unsentTokensReason,
  videoStatusKey,
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

type Statuses = Record<string, string>
/** Reason the way check() computes it. */
function reasonOf(s: Scene, statuses: Statuses = {}, cap: number | null = 0, settingsBlock: string | null = null): string | null {
  const takeStatus = (id: string) => statuses[id]
  return runBlockReason({ scene: s, assets: ASSETS, compiled: compileScene(project(s), s, { takeStatus }), takeStatus, providerVideoCap: cap, settingsBlock })
}

/** The engine's copy before 0.6.0 (store/runs.ts check(), v0.5.0), kept here as the oracle. */
function oldEngineReason(s: Scene, statuses: Statuses, cap: number | null): string | null {
  const compiled = compileScene(project(s), s, { takeStatus: (id) => statuses[id] })
  if (!s.prompt.trim()) return 'Prompt trống'
  if (compiled.charCount > compiled.limit) return 'Prompt quá dài'
  if (s.settings.mode === 'i2v' && compiled.images.length === 0) return 'Thiếu ảnh tham chiếu'
  if (s.settings.mode === 'transform' && (!s.firstFrame || !s.lastFrame)) return 'Thiếu khung đầu/cuối'
  if (s.settings.mode === 'transform' && [s.firstFrame, s.lastFrame].some((id) => !ASSETS.find((a) => a.id === id)?.imageIds[0])) return 'Khung đầu/cuối chưa có ảnh'
  if (compiled.unsentTokens.length)
    return `Prompt nhắc ${compiled.unsentTokens.slice(0, 3).join(', ')}${compiled.unsentTokens.length > 3 ? '…' : ''} nhưng không có ảnh/video đó trong lần gửi — sửa số hoặc nối thêm`
  if (s.videoRefs.some((id) => statuses[id] !== 'completed')) return 'Video tham chiếu chưa sẵn sàng'
  if (cap !== null && compiled.videos.length > cap) return 'Cổng canvasapp chưa hỗ trợ video tham chiếu'
  return null
}

describe('runBlockReason — each rule', () => {
  it('a scene that can run has no reason', () => {
    expect(reasonOf(scene())).toBeNull()
    expect(reasonOf(scene({ prompt: '@image_1 and @image_3', refs: ['a', 'b'] }))).toBeNull()
  })

  it('1. a model of a newer SanoVids build blocks first, whatever else is wrong', () => {
    const s = scene({ prompt: '', foreignModel: 'veo_3_1@seedvis' })
    expect(reasonOf(s)).toBe(foreignModelReason('veo_3_1@seedvis'))
    expect(foreignModelReason('veo_3_1@seedvis')).toBe(
      'Cảnh dùng model của bản SanoVids mới hơn (veo_3_1@seedvis) — cập nhật SanoVids để chạy (hoặc chọn lại model để chạy bằng model này).',
    )
    expect(reasonOf(scene({ foreignModel: '' }))).toBeNull()
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

  it('7. tokens with no media in the request: the engine sentence, 3 tokens then "…"', () => {
    expect(reasonOf(scene({ prompt: '@image_2', refs: ['b'] }))).toBe(
      'Prompt nhắc @image_2 nhưng không có ảnh/video đó trong lần gửi — sửa số hoặc nối thêm',
    )
    expect(reasonOf(scene({ prompt: '@image_1 @image_2 @image_3 @image_4' }))).toBe(unsentTokensReason(['@image_1', '@image_2', '@image_3', '@image_4']))
    expect(unsentTokensReason(['@image_1', '@image_2', '@image_3', '@image_4'])).toBe(
      'Prompt nhắc @image_1, @image_2, @image_3… nhưng không có ảnh/video đó trong lần gửi — sửa số hoặc nối thêm',
    )
    expect(unsentTokensReason(['@image_1', '@image_2', '@image_3'])).not.toContain('…')
    // a placeholder left by an edit
    expect(reasonOf(scene({ prompt: 'x @image_?2', refs: ['a'] }))).toMatch(/^Prompt nhắc @image_\?2 /)
    // a mode that sends no video: @video_1 is only text → unsent
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: '@video_1', videoRefs: ['t1'] }), { t1: 'completed' })).toBe(unsentTokensReason(['@video_1']))
  })

  it('9–10. sent reference videos: a deleted take beats a take still rendering', () => {
    const s = scene({ prompt: '@video_1 @video_2', videoRefs: ['t1', 't2'] })
    expect(reasonOf(s, { t1: 'processing' }, null)).toBe(DELETED_VIDEO_REASON)
    expect(DELETED_VIDEO_REASON).toBe('Video tham chiếu đã bị xoá — bỏ video đó khỏi cảnh')
    expect(reasonOf(s, { t1: 'processing', t2: 'completed' }, null)).toBe(PENDING_VIDEO_REASON)
    expect(reasonOf(s, { t1: 'failed', t2: 'completed' }, null)).toBe('Video tham chiếu chưa sẵn sàng')
    expect(reasonOf(s, { t1: 'completed', t2: 'completed' }, null)).toBeNull()
    // only the videos the request carries count: a leftover reference of a mode that sends none (H3 t2v) never blocks,
    // whatever its status (before the merge with PR #11 the engine refused it as "chưa sẵn sàng")
    for (const st of [{ t1: 'queued' }, { t1: 'processing' }, {}] as Statuses[]) expect(reasonOf(scene({ settings: H3('t2v'), videoRefs: ['t1'] }), st)).toBeNull()
  })

  it('8. the gateway limit counts the videos really sent', () => {
    const s = scene({ prompt: '@video_1', videoRefs: ['t1'] })
    const done = { t1: 'completed' }
    expect(reasonOf(s, done, 0)).toBe(NO_VIDEO_REFS_REASON)
    expect(reasonOf(s, done, 1)).toBeNull()
    expect(reasonOf(s, done, null)).toBeNull() // old demo: no gateway limit
    // H3 Text → Video sends no video: a leftover videoRef no longer blocks the card (the engine let it run)
    expect(reasonOf(scene({ settings: H3('t2v'), videoRefs: ['t1'] }), done, 0)).toBeNull()
    // removing the token alone does not unblock (the reference is still sent): the text says to remove the reference
    expect(reasonOf(scene({ prompt: 'không còn token', videoRefs: ['t1'] }), done, 0)).toBe(NO_VIDEO_REFS_REASON)
    expect(NO_VIDEO_REFS_REASON).toContain('bỏ video tham chiếu khỏi cảnh')
    // one constant, whichever module a caller imports it from
    expect(gate.NO_VIDEO_REFS_REASON).toBe(NO_VIDEO_REFS_REASON)
    // a cap above 0: refused past it, naming the cap; never sent with fewer videos
    expect(refVideosProblem(2, 1)).toMatch(/tối đa 1 video tham chiếu/)
    expect(reasonOf(scene({ prompt: '@video_1 @video_2', videoRefs: ['t1', 't1b'] }), { t1: 'completed', t1b: 'completed' }, 1)).toMatch(/tối đa 1/)
  })

  it('11. a sure refusal of the settings by the gateway comes last; a newer build’s marker still first', () => {
    const LOCKED = 'MiniMax-H3 hiện không khả dụng trên canvasapp'
    expect(reasonOf(scene({ settings: H3('t2v') }), {}, 0, LOCKED)).toBe(LOCKED)
    expect(reasonOf(scene({ settings: H3('t2v') }), {}, 0, null)).toBeNull()
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: ' ' }), {}, 0, LOCKED)).toBe(EMPTY_PROMPT_REASON)
    expect(reasonOf(scene({ prompt: '@video_1', videoRefs: ['t1'] }), { t1: 'processing' }, 0, LOCKED)).toBe(NO_VIDEO_REFS_REASON)
    expect(reasonOf(scene({ foreignModel: 'veo' }), {}, 0, LOCKED)).toBe(foreignModelReason('veo'))
  })

  it('the first failing rule wins (engine order)', () => {
    expect(reasonOf(scene({ prompt: '', settings: H3('i2v') }))).toBe(EMPTY_PROMPT_REASON)
    expect(reasonOf(scene({ prompt: 'a'.repeat(7001), settings: H3('i2v') }))).toBe(LONG_PROMPT_REASON)
    expect(reasonOf(scene({ prompt: '@image_1', settings: H3('i2v') }))).toBe(NO_IMAGE_REASON)
    expect(reasonOf(scene({ prompt: '@image_5', settings: H3('transform') }))).toBe(NO_FRAMES_REASON)
    expect(reasonOf(scene({ prompt: '@image_5 @video_1', videoRefs: ['gone'] }))).toMatch(/^Prompt nhắc @image_5/)
    // the gateway's cap before readiness: waiting for the video would not help (merged with PR #11)
    expect(reasonOf(scene({ prompt: '@video_1', videoRefs: ['t1'] }), { t1: 'processing' }, 0)).toBe(NO_VIDEO_REFS_REASON)
    expect(reasonOf(scene({ prompt: '@video_1', videoRefs: ['t1'] }), { t1: 'processing' }, null)).toBe(PENDING_VIDEO_REASON)
  })
})

describe('runBlockReason = the v0.5.0 engine, except the documented sentences and @video order', () => {
  it('agrees on a matrix of scenes', () => {
    const prompts = ['', 'plain', '@image_1', '@image_3 @image_9', '@video_1', '@video_2', 'a'.repeat(7001), '@image_?1']
    const settings = [SD, H3('t2v'), H3('i2v'), H3('transform')]
    const refsList = [[], ['a'], ['empty'], ['a', 'b']]
    const videoList = [[], ['t1'], ['t1', 'gone'], ['run']]
    const frames: [string | null, string | null][] = [
      [null, null],
      ['a', 'b'],
      ['a', 'empty'],
    ]
    const statuses = { t1: 'completed', run: 'processing' }
    let n = 0
    for (const prompt of prompts)
      for (const st of settings)
        for (const refs of refsList)
          for (const videoRefs of videoList)
            for (const [firstFrame, lastFrame] of frames)
              for (const cap of [0, null]) {
                const s = scene({ prompt, settings: st, refs, videoRefs, firstFrame, lastFrame })
                const now = reasonOf(s, statuses, cap)
                const old = oldEngineReason(s, statuses, cap)
                // What the request carries (the only videos the merged rules look at).
                const sent = compileScene(project(s), s).videos.map((v) => v.takeId)
                const status = (id: string) => (statuses as Statuses)[id]
                const expected =
                  old === 'Video tham chiếu chưa sẵn sàng'
                    ? cap !== null && sent.length > cap
                      ? NO_VIDEO_REFS_REASON // the gateway's cap comes first now
                      : sent.some((id) => status(id) === undefined)
                        ? DELETED_VIDEO_REASON
                        : sent.some((id) => status(id) !== 'completed')
                          ? PENDING_VIDEO_REASON
                          : null // only leftover references of a mode that sends none were not ready
                    : old === 'Cổng canvasapp chưa hỗ trợ video tham chiếu'
                      ? NO_VIDEO_REFS_REASON
                      : old
                expect(now, JSON.stringify({ prompt: prompt.slice(0, 12), st, refs, videoRefs, firstFrame, lastFrame, cap })).toBe(expected)
                n++
              }
    expect(n).toBe(8 * 4 * 4 * 4 * 3 * 2)
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
    const s = scene({ prompt: '@video_1', videoRefs: ['t1'] })
    const status = takeStatusFromKey(videoStatusKey(s.videoRefs, () => 'completed'))
    expect(sceneRunBlockReason(ASSETS, s, status, 0)).toBe(NO_VIDEO_REFS_REASON)
    expect(sceneRunBlockReason(ASSETS, s, status, null)).toBeNull()
    expect(sceneRunBlockReason(ASSETS, scene({ prompt: ' ' }), () => undefined, 0)).toBe(EMPTY_PROMPT_REASON)
  })

  it('core/runGate (the one-scene Run buttons) answers with this same list, newer-build markers included', () => {
    const s = scene({ prompt: '', foreignModel: 'veo' })
    expect(gate.sceneRunBlock(s, ASSETS, '', 0)).toBe(foreignModelReason('veo'))
    expect(gate.runBlockReason(s, compileScene(project(s), s), ASSETS, { maxRefVideos: 0, takeStatus: () => undefined })).toBe(foreignModelReason('veo'))
    const v = scene({ prompt: '@video_1', videoRefs: ['t1'] })
    expect(gate.sceneRunBlock(v, ASSETS, 'completed', 0, 'X')).toBe(NO_VIDEO_REFS_REASON)
    expect(gate.sceneRunBlock(v, ASSETS, 'completed', 3, 'X')).toBe('X')
    expect(gate.sceneRunBlock(v, ASSETS, '', 3)).toBe(DELETED_VIDEO_REASON)
    expect(sceneRunBlockReason(ASSETS, v, () => 'completed', 3, 'X')).toBe('X')
  })

  it('videoStatusKey / takeStatusFromKey: one stable string, deleted takes stay deleted', () => {
    const statuses: Statuses = { t1: 'completed', t2: 'processing' }
    const key = videoStatusKey(['t1', 't2', 'gone'], (id) => statuses[id])
    expect(key).toBe('t1=completed,t2=processing,gone=')
    expect(videoStatusKey([], () => 'completed')).toBe('')
    const lookup = takeStatusFromKey(key)
    expect(['t1', 't2', 'gone', 'other'].map(lookup)).toEqual(['completed', 'processing', undefined, undefined])
    expect(takeStatusFromKey('')('t1')).toBeUndefined()
  })
})

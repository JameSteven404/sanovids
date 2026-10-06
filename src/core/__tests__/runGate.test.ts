// The run rules every place shares (core/runGate): store/runs check(), the scene card, the inspector's Run button.
import { describe, expect, it } from 'vitest'
import { compileScene } from '../compile'
import { MODELS } from '../models'
import { NO_VIDEO_REFS_REASON, refStatusLookup, refVideosProblem, runBlockReason, type RunGate } from '../runGate'
import type { Project, Scene, VideoSettings } from '../types'

const SEEDANCE: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' }
const H3 = (mode: VideoSettings['mode']): VideoSettings => ({ model: 'minimax_h3', mode, duration: 5, resolution: '768p', ratio: '16:9' })

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  order: 1,
  title: 'Test',
  prompt: 'Một con đường vắng',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: SEEDANCE,
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
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1'], color: '#fff', position: null },
    { id: 'b', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i2'], color: '#fff', position: null },
    { id: 'empty', kind: 'location', name: 'Trống', tag: 'Trong', description: '', imageIds: [], color: '#fff', position: null },
  ],
  scenes: [s],
})

/** Takes: t1 / t2 / t3 finished, run1 still running; anything else does not exist (deleted). */
const STATUS: Record<string, string> = { t1: 'completed', t2: 'completed', t3: 'completed', run1: 'processing' }
const gate = (maxRefVideos: number): RunGate => ({ maxRefVideos, takeStatus: (id) => STATUS[id] })
const reasonOf = (s: Scene, maxRefVideos: number) => {
  const p = project(s)
  return runBlockReason(s, compileScene(p, s), p.assets, gate(maxRefVideos))
}

describe('refVideosProblem: the @video cap of the gateway', () => {
  it.each([
    [0, 0, null],
    [1, 0, NO_VIDEO_REFS_REASON],
    [10, 0, NO_VIDEO_REFS_REASON],
    [3, 3, null],
    [0, 3, null],
  ])('%i video(s) sent, gateway takes %i → %s', (sent, cap, out) => {
    expect(refVideosProblem(sent, cap)).toBe(out)
  })

  it('over a cap above 0: refused (never sent with fewer videos), naming the cap', () => {
    expect(refVideosProblem(4, 3)).toMatch(/tối đa 3 video tham chiếu/)
  })

  it('the reason names development mode too and says what unblocks the scene (the reference, not the token)', () => {
    expect(NO_VIDEO_REFS_REASON).toContain('cả chế độ Phát triển')
    expect(NO_VIDEO_REFS_REASON).toContain('bỏ video tham chiếu khỏi cảnh')
    expect(NO_VIDEO_REFS_REASON).not.toMatch(/bỏ @video để chạy/)
  })
})

describe('runBlockReason: reference videos', () => {
  it('a Seedance scene that sends a video is refused by a gateway without @video — removing the token alone does not unblock it', () => {
    expect(reasonOf(scene({ videoRefs: ['t1'], prompt: 'Continue from @video_1: chạy' }), 0)).toBe(NO_VIDEO_REFS_REASON)
    expect(reasonOf(scene({ videoRefs: ['t1'], prompt: 'không còn token' }), 0)).toBe(NO_VIDEO_REFS_REASON)
    // the old demo took every video the model takes
    expect(reasonOf(scene({ videoRefs: ['t1'], prompt: '@video_1' }), MODELS.seedance_2_5.maxRefVideos)).toBeNull()
  })

  it('the gateway refusal comes before readiness (waiting for the video would not help)', () => {
    expect(reasonOf(scene({ videoRefs: ['run1'], prompt: '@video_1' }), 0)).toBe(NO_VIDEO_REFS_REASON)
    expect(reasonOf(scene({ videoRefs: ['gone'], prompt: '@video_1' }), 0)).toBe(NO_VIDEO_REFS_REASON)
  })

  it('where videos are sent, each one must be a finished take', () => {
    expect(reasonOf(scene({ videoRefs: ['t1', 'run1'], prompt: '@video_1 @video_2' }), 10)).toBe('Video tham chiếu chưa sẵn sàng')
    expect(reasonOf(scene({ videoRefs: ['gone'], prompt: '@video_1' }), 10)).toMatch(/đã bị xoá/)
  })

  it('H3 t2v / transform send no video: leftover references (finished, running or deleted) never block the run', () => {
    for (const ref of ['t1', 'run1', 'gone']) {
      expect(reasonOf(scene({ settings: H3('t2v'), videoRefs: [ref] }), 0)).toBeNull()
      expect(reasonOf(scene({ settings: H3('transform'), videoRefs: [ref], firstFrame: 'a', lastFrame: 'b' }), 0)).toBeNull()
    }
    const s = scene({ settings: H3('t2v'), videoRefs: ['t1', 't2'] })
    expect(compileScene(project(s), s).videos).toEqual([]) // what the run dialog counts and the request carries
  })

  it('…but a @video token in a mode without videos still blocks (character sync: nothing behind the token)', () => {
    expect(reasonOf(scene({ settings: H3('t2v'), videoRefs: ['t1'], prompt: '@video_1 chạy' }), 0)).toMatch(/^Prompt nhắc @video_1/)
  })

  it('H3 i2v sends videos: refused on a gateway without @video', () => {
    expect(reasonOf(scene({ settings: H3('i2v'), refs: ['a'], videoRefs: ['t1'], prompt: '@image_1' }), 0)).toBe(NO_VIDEO_REFS_REASON)
    expect(reasonOf(scene({ settings: H3('i2v'), refs: ['a'], videoRefs: ['t1'], prompt: '@image_1' }), 3)).toBeNull()
  })

  it('only the videos within the model cap are sent: a gateway cap below it refuses, never truncates', () => {
    const refs = Array.from({ length: 12 }, (_, i) => `t${(i % 3) + 1}x${i}`)
    const s = scene({ videoRefs: refs })
    const status = (id: string) => (id.includes('x') ? 'completed' : undefined)
    const p = project(s)
    const c = compileScene(p, s)
    expect(c.videos).toHaveLength(MODELS.seedance_2_5.maxRefVideos)
    expect(runBlockReason(s, c, p.assets, { maxRefVideos: 10, takeStatus: status })).toBeNull()
    expect(runBlockReason(s, c, p.assets, { maxRefVideos: 3, takeStatus: status })).toMatch(/tối đa 3/)
  })
})

describe('runBlockReason: the other rules, in the queue’s order', () => {
  it('prompt, length, images, frames, then tokens', () => {
    expect(reasonOf(scene({ prompt: '  ' }), 0)).toBe('Prompt trống')
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: 'x'.repeat(7001) }), 0)).toBe('Prompt quá dài')
    expect(reasonOf(scene({ settings: H3('i2v') }), 0)).toBe('Thiếu ảnh tham chiếu')
    expect(reasonOf(scene({ settings: H3('transform'), firstFrame: 'a' }), 0)).toBe('Thiếu khung đầu/cuối')
    expect(reasonOf(scene({ settings: H3('transform'), firstFrame: 'a', lastFrame: 'empty' }), 0)).toBe('Khung đầu/cuối chưa có ảnh')
    expect(reasonOf(scene({ prompt: '@image_1 @image_2 @image_3 @image_4' }), 0)).toBe(
      'Prompt nhắc @image_1, @image_2, @image_3… nhưng không có ảnh/video đó trong lần gửi — sửa số hoặc nối thêm',
    )
    // a token problem is named before the video refusal (fixing the number may be all that is needed)
    expect(reasonOf(scene({ videoRefs: ['t1'], prompt: '@video_2' }), 0)).toMatch(/^Prompt nhắc @video_2/)
    expect(reasonOf(scene({ refs: ['a'], prompt: '@image_1 chạy' }), 0)).toBeNull()
  })
})

describe('refStatusLookup: statuses joined in videoRefs order', () => {
  it('reads each take by its place; "" and unknown ids are deleted takes', () => {
    const look = refStatusLookup(['t1', 'gone', 'run1'], 'completed,,processing')
    expect(['t1', 'gone', 'run1', 'other'].map(look)).toEqual(['completed', undefined, 'processing', undefined])
    expect(refStatusLookup([], '')('t1')).toBeUndefined()
  })
})

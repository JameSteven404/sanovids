// The run rules every place shares (core/runGate): store/runs check() and every one-scene Run button (scene card,
// inspector head + Take section; the hidden, frozen Storyboard card).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileScene } from '../compile'
import { retiredVideoReason } from '../runRules'
import { runBlockReason, sceneRunBlock } from '../runGate'
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

const reasonOf = (s: Scene) => {
  const p = project(s)
  return runBlockReason(s, compileScene(p, s), p.assets)
}

describe('runBlockReason: retired reference videos (0.6.0)', () => {
  it('@video text blocks the scene by itself (every mode, every spelling), whatever links it had', () => {
    expect(reasonOf(scene({ prompt: 'Continue from @video_1: chạy', legacyVideoRefs: ['t1'] }))).toBe(retiredVideoReason(['@video_1']))
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: '@Video 2 chạy' }))).toBe(retiredVideoReason(['@Video 2']))
    expect(reasonOf(scene({ settings: H3('i2v'), refs: ['a'], prompt: '@image_1 @video_?1(S01·T1)' }))).toBe(retiredVideoReason(['@video_?1(S01·T1)']))
  })

  it('a scene that once used reference videos but names none runs with its images (no take status, no gateway cap)', () => {
    expect(reasonOf(scene({ legacyVideoRefs: ['t1', 'gone'], prompt: 'không còn token' }))).toBeNull()
    expect(reasonOf(scene({ settings: H3('i2v'), refs: ['a'], legacyVideoRefs: ['run1'], prompt: '@image_1' }))).toBeNull()
    const s = scene({ settings: H3('t2v'), legacyVideoRefs: ['t1', 't2'] })
    expect(compileScene(project(s), s)).not.toHaveProperty('videos')
  })
})

describe('runBlockReason: the other rules, in the queue’s order', () => {
  it('prompt, length, images, frames, then tokens', () => {
    expect(reasonOf(scene({ prompt: '  ' }))).toBe('Prompt trống')
    expect(reasonOf(scene({ settings: H3('t2v'), prompt: 'x'.repeat(7001) }))).toBe('Prompt quá dài')
    expect(reasonOf(scene({ settings: H3('i2v') }))).toBe('Thiếu ảnh tham chiếu')
    expect(reasonOf(scene({ settings: H3('transform'), firstFrame: 'a' }))).toBe('Thiếu khung đầu/cuối')
    expect(reasonOf(scene({ settings: H3('transform'), firstFrame: 'a', lastFrame: 'empty' }))).toBe('Khung đầu/cuối chưa có ảnh')
    expect(reasonOf(scene({ prompt: '@image_1 @image_2 @image_3 @image_4' }))).toBe(
      'Prompt nhắc @image_1, @image_2, @image_3… nhưng không có ảnh đó trong lần gửi — sửa số hoặc nối thêm ảnh',
    )
    // the specific @video sentence is named before a wrong @image number
    expect(reasonOf(scene({ prompt: '@image_9 @video_2' }))).toBe(retiredVideoReason(['@video_2']))
    expect(reasonOf(scene({ refs: ['a'], prompt: '@image_1 chạy' }))).toBeNull()
  })
})

describe('runBlockReason: settings the gateway surely refuses now (settingsBlock, /api/video-profiles)', () => {
  const LOCKED = 'MiniMax-H3 hiện không khả dụng trên canvasapp'
  const withBlock = (s: Scene, settingsBlock: string | null | undefined) => {
    const p = project(s)
    return runBlockReason(s, compileScene(p, s), p.assets, { settingsBlock })
  }

  it('blocks a scene that would otherwise run; none / null → no block', () => {
    const s = scene({ settings: H3('t2v') })
    expect(withBlock(s, LOCKED)).toBe(LOCKED)
    expect(withBlock(s, null)).toBeNull()
    expect(withBlock(s, undefined)).toBeNull()
  })

  it('comes last, like the profile checks of the submit: the scene’s own problems are named first', () => {
    expect(withBlock(scene({ settings: H3('t2v'), prompt: ' ' }), LOCKED)).toBe('Prompt trống')
    expect(withBlock(scene({ settings: H3('i2v') }), LOCKED)).toBe('Thiếu ảnh tham chiếu')
    expect(withBlock(scene({ prompt: '@video_1' }), LOCKED)).toBe(retiredVideoReason(['@video_1']))
  })

  it('sceneRunBlock passes it on (one-scene Run buttons = store/runs check())', () => {
    const s = scene({ settings: H3('t2v') })
    expect(sceneRunBlock(s, project(s).assets, LOCKED)).toBe(LOCKED)
    expect(sceneRunBlock(s, project(s).assets)).toBeNull()
  })
})

describe('sceneRunBlock: what a one-scene Run button holds (assets + the gateway’s refusal)', () => {
  it.each([
    ['blank prompt', scene({ prompt: ' ' })],
    ['old @video text', scene({ legacyVideoRefs: ['t1'], prompt: '@video_1' })],
    ['old link, no @video text', scene({ legacyVideoRefs: ['t1', 'gone'] })],
    ['H3 t2v leftover token', scene({ settings: H3('t2v'), prompt: '@video_1 chạy' })],
    ['i2v without a picture', scene({ settings: H3('i2v'), refs: ['empty'] })],
    ['runnable', scene({ refs: ['a', 'b'], prompt: '@image_1 trong @image_2' })],
  ])('%s: same answer as runBlockReason (= store/runs check())', (_name, s) => {
    expect(sceneRunBlock(s, project(s).assets)).toBe(reasonOf(s))
  })
})

describe('every one-scene Run button is gated by core/runGate (no drift to a prompt-only check)', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  // (Bảng cảnh / SceneTable.tsx was deleted in 0.6.0; the hidden Storyboard is frozen but still gated)
  const FILES = ['../../components/canvas/SceneNode.tsx', '../../components/inspector/SceneInspector.tsx', '../../components/views/Storyboard.tsx']
  /** The <button>…</button> around each `requestRun([…])` (a one-scene run; a selection opens the dialog). */
  const runButtons = (src: string) =>
    [...src.matchAll(/requestRun\(\[/g)].map((m) => src.slice(src.lastIndexOf('<button', m.index), src.indexOf('</button>', m.index)))
  it.each(FILES)('%s', (file) => {
    const src = read(file)
    expect(src).toMatch(/useSceneRunBlock\(|runBlockReason\(|runBlock\(\{/)
    const buttons = runButtons(src)
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) {
      expect(b).toMatch(/disabled=\{!!\w+\}/)
      expect(b).not.toMatch(/prompt\.trim\(\)/)
    }
  })
  it('the inspector gates its Run button (head; the costed one moved onto the scene node in 0.6.0)', () => {
    expect(runButtons(read('../../components/inspector/SceneInspector.tsx'))).toHaveLength(1)
  })
  it('the places that call runBlockReason / runBlock themselves pass the gateway’s refusal of the settings too', () => {
    // the scene node: core/runRules runBlock (the reason + which rule, for "Chưa chạy · còn chữ đỏ")
    expect(read('../../components/canvas/SceneNode.tsx')).toMatch(/runBlock\(\{[^)]*settingsBlock/)
    expect(read('../../store/runs.ts')).toMatch(/runBlockReason\([^)]*settingsBlock/)
    expect(read('../../components/runs/shared.tsx')).toMatch(/sceneRunBlock\(scene, assets, settingsBlock\)/)
  })
})

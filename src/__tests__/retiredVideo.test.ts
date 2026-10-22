// Reference videos retired (0.6.0) — what the user sees through the actions and the stores: nothing links a video to a
// scene any more, "Tạo cảnh tiếp theo từ video này" replaces "Tạo cảnh tiếp nối", deleting a video never rewrites a
// prompt, the open-project notice comes once per project, and the quick fixes only run on a click (one undo each).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectSelection,
  createSceneFromVideo,
  deleteTakes,
  edgeId,
  refuseTakesAsReference,
  noteRecentScene,
  parseEdgeId,
  setCanvasViewSource,
  VIDEO_NOT_REFERENCE_TEXT,
} from '../actions'
import type { Asset, Preset, Project, Scene, Take } from '../core/types'
import { undo, useProject } from '../store/project'
import { useRuns } from '../store/runs'
import { useUI } from '../store/ui'
import {
  initRetiredVideoNotice,
  noteRetiredVideos,
  removeContinueStarter,
  removeRetiredTextFromScenes,
  removeRetiredTokenFromScene,
  RETIRED_NOTICE_KEY,
  retiredNoticeText,
  retiredTokenCounts,
  retiredVideoScenes,
  withoutRetiredText,
  withoutRetiredToken,
} from '../videoRetired'

const SD = { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' } as const
const H3 = { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' } as const

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
  id,
  order,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { ...SD },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 420, y: 60 + (order - 1) * 400 },
  note: '',
  ...over,
})
const asset = (id: string): Asset => ({ id, kind: 'character', name: id.toUpperCase(), tag: id.toUpperCase(), description: '', imageIds: ['img_' + id], color: '#fff', position: null })
const take = (id: string, sceneId: string, over: Partial<Take> = {}): Take => ({
  id,
  sceneId,
  number: 1,
  status: 'completed',
  progress: 100,
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
  promptSnapshot: '',
  rawPromptSnapshot: '',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: { ...SD },
  cost: 1,
  starred: false,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
  ...over,
})
const project = (scenes: Scene[], extra: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [asset('a'), asset('b'), asset('c')],
  scenes,
  ...extra,
})

const st = () => useProject.getState()
const sc = (id: string) => st().project.scenes.find((s) => s.id === id)!
const steps = () => useProject.temporal.getState().pastStates.length
const lastToast = () => useUI.getState().toasts.at(-1)
const load = (p: Project, takes: Take[] = []) => {
  st().loadProject(p)
  useProject.temporal.getState().clear()
  useRuns.setState({ takes })
}

let offView: () => void = () => undefined
const storage = new Map<string, string>()
beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) })
  useUI.setState({ selectedIds: [], selectedEdgeIds: [], takeDisplay: 'all', view: 'canvas', toasts: [], dialog: { kind: 'none' } })
  noteRecentScene(null)
  offView = setCanvasViewSource(() => null)
})
afterEach(() => {
  offView()
  useRuns.setState({ takes: [] })
  vi.unstubAllGlobals()
})

describe('nothing links a video to a scene any more', () => {
  it('the vref wire kind is gone: never built, never parsed', () => {
    expect(parseEdgeId('vref:t1->s1')).toBeNull()
    expect(parseEdgeId(edgeId('ref', 'a', 's1'))).toEqual({ kind: 'ref', from: 'a', to: 's1' })
    expect(parseEdgeId(edgeId('save', 't1', 'f1'))).toEqual({ kind: 'save', from: 't1', to: 'f1' })
  })
  // Only the refusal itself (what a video wire / prompt-editor drop calls): no drop handler is exercised here.
  it('refuseTakesAsReference links nothing and says where a video goes', () => {
    load(project([scene('s1', 1), scene('s2', 2)]), [take('t1', 's1')])
    const before = st().project
    refuseTakesAsReference()
    expect(st().project).toBe(before)
    expect(steps()).toBe(0)
    expect(lastToast()?.text).toBe(`${VIDEO_NOT_REFERENCE_TEXT}.`)
    expect(VIDEO_NOT_REFERENCE_TEXT).toBe('Video không dùng làm tham chiếu được nữa — kéo vào Thư mục để lưu')
  })
  it('"C" with only videos and scenes selected links nothing', () => {
    load(project([scene('s1', 1), scene('s2', 2)]), [take('t1', 's1')])
    useUI.setState({ selectedIds: ['t1', 's2'] })
    const before = st().project
    connectSelection()
    expect(st().project).toBe(before)
    expect(lastToast()).toMatchObject({ tone: 'warning', text: expect.stringContaining('1 nhân vật/bối cảnh và 1 cảnh') })
  })
})

describe('"Tạo cảnh tiếp theo từ video này" (createSceneFromVideo)', () => {
  const preset: Preset = { id: 'pr', name: 'Nháp', ...SD }
  it('the take’s own references and settings, characters deleted since left out, the preset kept while it matches, an empty prompt — one undo step', () => {
    const src = scene('s1', 1, { refs: ['c'], prompt: '@image_1 đi', presetId: 'pr', legacyVideoRefs: ['old'] })
    load(project([src], { presets: [preset] }), [take('t1', 's1', { refsSnapshot: ['a', 'gone', 'b'], settings: { ...SD } })])
    const id = createSceneFromVideo('t1')!
    expect(sc(id)).toMatchObject({ refs: ['a', 'b'], settings: SD, presetId: 'pr', prompt: '', videoRefs: [], order: 2 })
    expect(sc(id)).not.toHaveProperty('legacyVideoRefs')
    expect(lastToast()?.text).toBe('Đã tạo S02 tiếp theo S01·T1 — cùng ảnh tham chiếu và cấu hình của video đó, prompt để trống (bỏ 1 nhân vật đã xoá).')
    expect(steps()).toBe(1)
    undo()
    expect(st().project.scenes.map((s) => s.id)).toEqual(['s1'])
  })
  it('a take made with other settings than the scene has now: its own settings, and no preset unless they match it', () => {
    load(project([scene('s1', 1, { refs: ['c'], presetId: 'pr' })], { presets: [preset] }), [take('t1', 's1', { refsSnapshot: ['a'], settings: { ...H3 } })])
    const id = createSceneFromVideo('t1')!
    expect(sc(id)).toMatchObject({ refs: ['a'], settings: H3, presetId: null })
  })
  it('a take of a newer build’s model, settings this build cannot use, or an imported take that is not sure: the scene’s current images and settings', () => {
    const src = scene('s1', 1, { refs: ['c'], settings: { ...SD, duration: 5 } })
    const cases: Partial<Take>[] = [
      { foreignModel: 'veo_3_1', settings: { ...SD } },
      { settings: { ...SD, duration: 7 } },
      { imported: { at: 1, jobName: null, unknown: ['refs'], inferred: [] } },
      { imported: { at: 1, jobName: null, unknown: [], inferred: ['mode'] } },
    ]
    for (const over of cases) {
      load(project([src]), [take('t1', 's1', { refsSnapshot: ['a'], ...over })])
      const id = createSceneFromVideo('t1')!
      expect(sc(id)).toMatchObject({ refs: ['c'], settings: { ...SD, duration: 5 }, prompt: '', videoRefs: [] })
      expect(lastToast()?.text).toContain('dùng ảnh và cấu hình hiện tại của S01 (cấu hình của video không dùng được ở bản này)')
    }
  })
  it('refuses a video that is not finished, or whose scene was deleted', () => {
    load(project([scene('s1', 1)]), [take('t1', 's1', { status: 'processing' }), take('t2', 'gone')])
    expect(createSceneFromVideo('t1')).toBeNull()
    expect(createSceneFromVideo('t2')).toBeNull()
    expect(createSceneFromVideo('nope')).toBeNull()
    expect(st().project.scenes).toHaveLength(1)
  })
})

describe('deleting videos never rewrites a prompt', () => {
  it('no @video question, prompts kept, folder links dropped', () => {
    load(
      project([scene('s1', 1), scene('s2', 2, { prompt: 'Continue from @video_1: x', legacyVideoRefs: ['t1'] })], {
        folders: [{ id: 'f1', name: 'A', path: 'D:\\A', position: { x: 0, y: 0 }, mode: 'copy', takes: ['t1'] }],
      }),
      [take('t1', 's1')],
    )
    // the two-click buttons ('usedOnly') used to ask when a scene used the video as @video: nothing to ask now (a
    // question would call window.confirm, which this test environment does not have)
    expect(deleteTakes(['t1'], { confirm: 'usedOnly' })).toBe(1)
    expect(sc('s2').prompt).toBe('Continue from @video_1: x')
    expect(st().project.folders?.[0].takes ?? []).toEqual([])
    expect(lastToast()?.text).not.toContain('@video')
  })
})

describe('open-project notice (once per project on this device)', () => {
  const withData = () =>
    project([
      scene('s1', 1, { prompt: 'Continue from @video_1: x', legacyVideoRefs: ['t1'] }),
      scene('s2', 2, { prompt: '@image_1 thôi', legacyVideoRefs: ['t2'] }),
      scene('s3', 3, { prompt: '@Video 2 nữa' }),
      scene('s4', 4, { prompt: 'không gì' }),
    ])
  it('counts the scenes with @video text (A) and those that only had links (B)', () => {
    expect(retiredVideoScenes(withData())).toEqual({ withText: ['s1', 's3'], linkedOnly: ['s2'] })
    expect(retiredNoticeText(2, 1)).toBe('Dự án có 2 cảnh còn chữ @video (chưa chạy được cho tới khi sửa) và 1 cảnh từng nối video (nay chỉ gửi ảnh). SanoVids đã bỏ video tham chiếu.')
    expect(retiredNoticeText(3, 0)).toBe('Dự án có 3 cảnh còn chữ @video: chữ được giữ nguyên, nhưng các cảnh đó chưa chạy được cho tới khi bạn sửa. SanoVids đã bỏ video tham chiếu.')
    expect(retiredNoticeText(0, 2)).toBe('Dự án có 2 cảnh từng nối video tham chiếu. SanoVids đã bỏ tính năng này: các cảnh đó từ nay chỉ gửi ảnh.')
    expect(retiredNoticeText(0, 0)).toBeNull()
  })
  it('shows once per project; "Xem" selects those scenes; a project without such data writes nothing', () => {
    load(withData())
    expect(noteRetiredVideos(st().project)).toBe(true)
    expect(lastToast()).toMatchObject({ tone: 'warning', text: retiredNoticeText(2, 1) })
    expect(storage.get(RETIRED_NOTICE_KEY('p1'))).toBe('1')
    lastToast()!.action!.run()
    expect(useUI.getState().selectedIds).toEqual(['s1', 's3', 's2'])
    expect(noteRetiredVideos(st().project)).toBe(false)
    const clean = { ...project([scene('s1', 1)]), id: 'p2' }
    expect(noteRetiredVideos(clean)).toBe(false)
    expect(storage.has(RETIRED_NOTICE_KEY('p2'))).toBe(false)
  })
  it('initRetiredVideoNotice shows it when another project is opened (not on edits)', async () => {
    load(project([scene('s1', 1)]))
    const off = initRetiredVideoNotice()
    try {
      useUI.setState({ toasts: [] })
      st().loadProject({ ...withData(), id: 'p9' })
      await Promise.resolve()
      expect(lastToast()?.text).toBe(retiredNoticeText(2, 1))
      useUI.setState({ toasts: [] })
      st().updateScene('s4', { title: 'x' })
      await Promise.resolve()
      expect(useUI.getState().toasts).toEqual([])
    } finally {
      off()
    }
  })
})

describe('quick fixes: only on a click, one undo step each, nothing else changes', () => {
  it('pure helpers', () => {
    expect(retiredTokenCounts('@video_1 a @Video 2 b @video_1')).toEqual([
      { text: '@video_1', count: 2 },
      { text: '@Video 2', count: 1 },
    ])
    expect(withoutRetiredToken('@video_1 a @Video 2 b @video_1', '@video_1')).toBe('a @Video 2 b ')
    expect(withoutRetiredText('Continue from @video_1: Elara @video_?2(S01·T1) đi')).toBe('Elara đi')
  })
  it('"Xoá @video_1" removes every occurrence of that token in one step; Ctrl+Z brings it back', () => {
    load(project([scene('s1', 1, { prompt: '@video_1 mở @Video 2 và @video_1.' })]))
    expect(removeRetiredTokenFromScene('s1', '@video_1')).toBe(true)
    expect(sc('s1').prompt).toBe('mở @Video 2 và .')
    expect(steps()).toBe(1)
    expect(lastToast()?.text).toBe('Đã xoá @video_1 khỏi prompt S01.')
    undo()
    expect(sc('s1').prompt).toBe('@video_1 mở @Video 2 và @video_1.')
    expect(removeRetiredTokenFromScene('s1', '@video_9')).toBe(false)
    expect(steps()).toBe(0)
  })
  it('"Xoá câu Continue from @video_1:" only for the exact starter older builds wrote', () => {
    load(project([scene('s1', 1, { prompt: 'Continue from @video_1: trời mưa' }), scene('s2', 2, { prompt: 'continue from @video_1: x' })]))
    expect(removeContinueStarter('s1')).toBe(true)
    expect(sc('s1').prompt).toBe('trời mưa')
    expect(lastToast()?.text).toBe('Đã xoá câu “Continue from @video_1:” khỏi prompt S01.')
    expect(removeContinueStarter('s2')).toBe(false)
    expect(sc('s2').prompt).toBe('continue from @video_1: x')
  })
  it('"Xoá chữ @video ở N cảnh đang chọn": every selected scene in ONE step', () => {
    load(project([scene('s1', 1, { prompt: 'Continue from @video_1: a' }), scene('s2', 2, { prompt: 'b @Video 2' }), scene('s3', 3, { prompt: 'c' })]))
    expect(removeRetiredTextFromScenes(['s1', 's2', 's3'])).toBe(2)
    expect([sc('s1').prompt, sc('s2').prompt, sc('s3').prompt]).toEqual(['a', 'b ', 'c'])
    expect(steps()).toBe(1)
    expect(lastToast()?.text).toBe('Đã xoá chữ @video ở 2 cảnh.')
    undo()
    expect([sc('s1').prompt, sc('s2').prompt]).toEqual(['Continue from @video_1: a', 'b @Video 2'])
  })
})

// Canvas prefs: stored values are validated; the OS "reduce motion" setting softens 'full'; the editor on a scene card
// (mode + width) and the big-project optimisations are read, clamped and saved like the others.
import { afterEach, describe, expect, it } from 'vitest'
import {
  BIG_PROJECT_LABEL,
  BIG_PROJECT_MODES,
  clampEditorWidth,
  DEFAULT_CANVAS_PREFS,
  EDITOR_WIDTH_MAX,
  EDITOR_WIDTH_MIN,
  isEditorWidth,
  motionLevel,
  NODE_EDITOR_LABEL,
  NODE_EDITOR_MODES,
  parseCanvasPrefs,
  useCanvasPrefs,
} from '../canvasPrefs'

describe('parseCanvasPrefs', () => {
  it('defaults: click to cut on, full animations, editor opens on a click, 380 px wide, big-project optimisations on', () => {
    expect(DEFAULT_CANVAS_PREFS).toEqual({ clickToCut: true, animations: 'full', nodeEditor: 'click', editorWidth: 380, bigProject: 'auto' })
    expect(parseCanvasPrefs(null)).toEqual(DEFAULT_CANVAS_PREFS)
    expect(parseCanvasPrefs('')).toEqual(DEFAULT_CANVAS_PREFS)
  })
  it('reads saved values and ignores garbage', () => {
    expect(parseCanvasPrefs('{"clickToCut":false,"animations":"off"}')).toEqual({ ...DEFAULT_CANVAS_PREFS, clickToCut: false, animations: 'off' })
    expect(parseCanvasPrefs('{"animations":"reduced"}')).toEqual({ ...DEFAULT_CANVAS_PREFS, animations: 'reduced' })
    expect(parseCanvasPrefs('{"clickToCut":"no","animations":"fast"}')).toEqual(DEFAULT_CANVAS_PREFS)
    expect(parseCanvasPrefs('not json')).toEqual(DEFAULT_CANVAS_PREFS)
    expect(parseCanvasPrefs('null')).toEqual(DEFAULT_CANVAS_PREFS)
    expect(parseCanvasPrefs('[1]')).toEqual(DEFAULT_CANVAS_PREFS)
  })
  it('the scene-card editor and the big-project optimisations', () => {
    expect(parseCanvasPrefs('{"nodeEditor":"select","editorWidth":500,"bigProject":"off"}')).toEqual({
      ...DEFAULT_CANVAS_PREFS,
      nodeEditor: 'select',
      editorWidth: 500,
      bigProject: 'off',
    })
    expect(parseCanvasPrefs('{"nodeEditor":"always","bigProject":"on","editorWidth":"wide"}')).toEqual(DEFAULT_CANVAS_PREFS)
    // a width out of range is clamped (the resize grip and a hand-edited value), not dropped
    expect(parseCanvasPrefs('{"editorWidth":9999}').editorWidth).toBe(EDITOR_WIDTH_MAX)
    expect(parseCanvasPrefs('{"editorWidth":12}').editorWidth).toBe(EDITOR_WIDTH_MIN)
    expect(parseCanvasPrefs('{"editorWidth":401.6}').editorWidth).toBe(402)
    expect(parseCanvasPrefs('{"editorWidth":null}').editorWidth).toBe(380)
  })
  it('labels of every mode (Settings rows)', () => {
    expect(NODE_EDITOR_MODES.map((m) => NODE_EDITOR_LABEL[m])).toEqual(['Bấm vào prompt', 'Tự mở khi chọn 1 cảnh', 'Tắt (chỉ sửa ở bảng bên phải)'])
    expect(BIG_PROJECT_MODES.map((m) => BIG_PROJECT_LABEL[m])).toEqual(['Tự động', 'Tắt'])
  })
})

describe('editor width', () => {
  it('clampEditorWidth rounds and clamps numbers, refuses the rest', () => {
    expect(clampEditorWidth(380)).toBe(380)
    expect(clampEditorWidth(339.4)).toBe(340)
    expect(clampEditorWidth(1e9)).toBe(640)
    expect(clampEditorWidth(-5)).toBe(340)
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, '400', null, undefined, {}]) expect(clampEditorWidth(v)).toBeNull()
  })
  it('isEditorWidth: only what this build stores (an integer in range)', () => {
    expect([340, 380, 640].every(isEditorWidth)).toBe(true)
    expect([339, 641, 380.5, '380', Number.NaN].some(isEditorWidth)).toBe(false)
  })
})

describe('motionLevel', () => {
  it("the OS reduce-motion setting turns 'full' into 'reduced'; explicit choices stay", () => {
    expect(motionLevel('full', false)).toBe('full')
    expect(motionLevel('full', true)).toBe('reduced')
    expect(motionLevel('reduced', false)).toBe('reduced')
    expect(motionLevel('off', true)).toBe('off')
  })
})

describe('useCanvasPrefs.set', () => {
  afterEach(() => useCanvasPrefs.getState().set({ ...DEFAULT_CANVAS_PREFS }))

  it('applies valid values only', () => {
    const s = useCanvasPrefs.getState()
    s.set({ clickToCut: false })
    expect(useCanvasPrefs.getState().clickToCut).toBe(false)
    s.set({ animations: 'reduced' })
    expect(useCanvasPrefs.getState().animations).toBe('reduced')
    s.set({ animations: 'bogus' as never, clickToCut: 'x' as never })
    expect(useCanvasPrefs.getState()).toMatchObject({ clickToCut: false, animations: 'reduced' })
    s.set({ ...DEFAULT_CANVAS_PREFS })
    expect(useCanvasPrefs.getState()).toMatchObject(DEFAULT_CANVAS_PREFS)
  })

  it('the editor mode, its width (clamped) and the big-project mode', () => {
    const s = useCanvasPrefs.getState()
    s.set({ nodeEditor: 'off', bigProject: 'off', editorWidth: 455.2 })
    expect(useCanvasPrefs.getState()).toMatchObject({ nodeEditor: 'off', bigProject: 'off', editorWidth: 455 })
    s.set({ editorWidth: 5000 })
    expect(useCanvasPrefs.getState().editorWidth).toBe(640)
    s.set({ nodeEditor: 'sometimes' as never, bigProject: 'max' as never, editorWidth: Number.NaN })
    expect(useCanvasPrefs.getState()).toMatchObject({ nodeEditor: 'off', bigProject: 'off', editorWidth: 640 })
  })
})

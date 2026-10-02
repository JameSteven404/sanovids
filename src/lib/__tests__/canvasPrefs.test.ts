// Canvas prefs: stored values are validated; the OS "reduce motion" setting softens 'full'.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CANVAS_PREFS, motionLevel, parseCanvasPrefs, useCanvasPrefs } from '../canvasPrefs'

describe('parseCanvasPrefs', () => {
  it('defaults: click to cut on, full animations', () => {
    expect(DEFAULT_CANVAS_PREFS).toEqual({ clickToCut: true, animations: 'full' })
    expect(parseCanvasPrefs(null)).toEqual(DEFAULT_CANVAS_PREFS)
    expect(parseCanvasPrefs('')).toEqual(DEFAULT_CANVAS_PREFS)
  })
  it('reads saved values and ignores garbage', () => {
    expect(parseCanvasPrefs('{"clickToCut":false,"animations":"off"}')).toEqual({ clickToCut: false, animations: 'off' })
    expect(parseCanvasPrefs('{"animations":"reduced"}')).toEqual({ clickToCut: true, animations: 'reduced' })
    expect(parseCanvasPrefs('{"clickToCut":"no","animations":"fast"}')).toEqual(DEFAULT_CANVAS_PREFS)
    expect(parseCanvasPrefs('not json')).toEqual(DEFAULT_CANVAS_PREFS)
    expect(parseCanvasPrefs('null')).toEqual(DEFAULT_CANVAS_PREFS)
    expect(parseCanvasPrefs('[1]')).toEqual(DEFAULT_CANVAS_PREFS)
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
})

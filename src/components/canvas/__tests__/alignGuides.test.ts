// UI-05 alignment guides: canvasModel.alignToGuides (pure).
import { describe, expect, it } from 'vitest'
import { alignToGuides } from '../canvasModel'

const scene = { x: 0, y: 0, w: 352, h: 304 }

describe('alignToGuides', () => {
  it('snaps the left edge to another left edge within the tolerance, with a vertical guide over both boxes', () => {
    const r = alignToGuides({ x: 4, y: 500, w: 200, h: 100 }, [scene], 6)
    expect(r.x).toBe(0)
    expect(r.y).toBe(500)
    expect(r.guides.v).toEqual({ x: 0, y1: 0, y2: 600 })
    expect(r.guides.h).toBeNull()
  })
  it('centres and far edges count too; the nearest candidate wins on each axis', () => {
    // centre 176 of the scene vs centre of a 100-wide box at x 128 (centre 178): delta -2
    const r = alignToGuides({ x: 128, y: 400, w: 100, h: 50 }, [scene], 6)
    expect(r.x).toBe(126)
    expect(r.guides.v?.x).toBe(176)
    // bottom edge 304 vs top edge 300 of the dragged box: delta 4 on y
    const below = alignToGuides({ x: 900, y: 300, w: 100, h: 50 }, [scene], 6)
    expect(below.y).toBe(304)
    expect(below.guides.h).toEqual({ y: 304, x1: 0, x2: 1000 })
  })
  it('nothing within the tolerance: the position is kept and no guide is drawn', () => {
    const r = alignToGuides({ x: 37, y: 911, w: 100, h: 50 }, [scene], 6)
    expect(r).toEqual({ x: 37, y: 911, guides: { v: null, h: null } })
    expect(alignToGuides({ x: 4, y: 0, w: 10, h: 10 }, [], 6).guides).toEqual({ v: null, h: null })
  })
  it('tolerance is in canvas units (the caller divides 6 screen px by the zoom)', () => {
    expect(alignToGuides({ x: 10, y: 900, w: 50, h: 50 }, [scene], 6).x).toBe(10)
    expect(alignToGuides({ x: 10, y: 900, w: 50, h: 50 }, [scene], 12).x).toBe(0)
  })
})

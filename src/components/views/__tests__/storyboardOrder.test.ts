// Storyboard drag reorder: index math (preview shifting, drop → moveScene), grid hit testing, keyboard steps,
// auto-scroll, slide offsets and the words announced. Plus: the store move and the "Phát liền" / .zip order follow it.
import { beforeEach, describe, expect, it } from 'vitest'
import { chosenTakeIds } from '../../../actions'
import { sceneCode } from '../../../core/compile'
import type { Project, Scene, Take } from '../../../core/types'
import { sortedScenes, undo, useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import {
  AUTOSCROLL_EDGE,
  AUTOSCROLL_MAX,
  autoScrollStep,
  columnsOf,
  DRAG_SLOP,
  edgeAnnouncement,
  flipOffsets,
  gapOf,
  gridStep,
  insertBar,
  insertSide,
  moveAnnouncement,
  movedPast,
  moveItem,
  reorderToast,
  rowsOf,
  sceneOrderAt,
  shiftedIndex,
  slotAt,
  type Slot,
} from '../storyboardOrder'

/** A grid like the storyboard: `cols` columns of 232×190 cards with 16px gaps and 16px padding. */
function grid(count: number, cols: number, w = 232, h = 190, gap = 16, pad = 16): Slot[] {
  return Array.from({ length: count }, (_, i) => ({ x: pad + (i % cols) * (w + gap), y: pad + Math.floor(i / cols) * (h + gap), w, h }))
}
const center = (s: Slot) => [s.x + s.w / 2, s.y + s.h / 2] as const

describe('moveItem / shiftedIndex: where every card ends up', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  it('moves one item forward and backward', () => {
    expect(moveItem(ids, 1, 4)).toEqual(['a', 'c', 'd', 'e', 'b', 'f'])
    expect(moveItem(ids, 4, 1)).toEqual(['a', 'e', 'b', 'c', 'd', 'f'])
    expect(moveItem(ids, 0, 5)).toEqual(['b', 'c', 'd', 'e', 'f', 'a'])
    expect(moveItem(ids, 2, 2)).toEqual(ids)
  })
  it('never mutates the input; clamps the target; ignores a bad source', () => {
    const copy = [...ids]
    moveItem(ids, 0, 3)
    expect(ids).toEqual(copy)
    expect(moveItem(ids, 0, 99)).toEqual(['b', 'c', 'd', 'e', 'f', 'a'])
    expect(moveItem(ids, 3, -4)).toEqual(['d', 'a', 'b', 'c', 'e', 'f'])
    expect(moveItem(ids, 9, 0)).toEqual(ids)
  })
  it('the live shift shows exactly the order the drop will produce (every from → to)', () => {
    for (let from = 0; from < ids.length; from++)
      for (let to = 0; to < ids.length; to++) {
        const after = moveItem(ids, from, to)
        const shown: string[] = []
        ids.forEach((id, i) => (shown[shiftedIndex(i, from, to)] = id))
        expect(shown).toEqual(after)
      }
  })
  it('cards outside the range between from and to do not move', () => {
    expect(shiftedIndex(0, 2, 4)).toBe(0)
    expect(shiftedIndex(5, 2, 4)).toBe(5)
    expect(shiftedIndex(3, 2, 4)).toBe(2)
    expect(shiftedIndex(1, 4, 1)).toBe(2)
    expect(shiftedIndex(4, 4, 1)).toBe(1)
  })
})

describe('grid geometry: rows, columns, gaps', () => {
  it('groups slots into rows (last row may be short)', () => {
    const slots = grid(10, 4)
    expect(rowsOf(slots)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ])
    expect(columnsOf(slots)).toBe(4)
    expect(columnsOf(grid(3, 5))).toBe(3)
    expect(columnsOf(grid(5, 1))).toBe(1)
    expect(columnsOf([])).toBe(1)
  })
  it('tolerates sub-pixel row tops', () => {
    const slots = grid(4, 2).map((s, i) => (i === 1 ? { ...s, y: s.y + 0.6 } : s))
    expect(rowsOf(slots)).toEqual([
      [0, 1],
      [2, 3],
    ])
  })
  it('measures the gaps between cards', () => {
    expect(gapOf(grid(10, 4))).toEqual({ x: 16, y: 16 })
    expect(gapOf(grid(10, 4, 200, 150, 24))).toEqual({ x: 24, y: 24 })
    expect(gapOf(grid(1, 4))).toEqual({ x: 16, y: 16 }) // one card: fallback
  })
})

describe('slotAt: which slot the pointer is over', () => {
  const slots = grid(10, 4)
  it('a point inside a card picks that card', () => {
    slots.forEach((s, i) => expect(slotAt(slots, ...center(s))).toBe(i))
    expect(slotAt(slots, slots[5].x + 1, slots[5].y + 1)).toBe(5)
    expect(slotAt(slots, slots[5].x + slots[5].w - 1, slots[5].y + slots[5].h - 1)).toBe(5)
  })
  it('gaps split in the middle (left / right and above / below)', () => {
    const a = slots[1]
    const gapMid = a.x + a.w + 8
    expect(slotAt(slots, gapMid - 1, a.y + 50)).toBe(1)
    expect(slotAt(slots, gapMid + 1, a.y + 50)).toBe(2)
    const rowGapMid = a.y + a.h + 8
    expect(slotAt(slots, a.x + 50, rowGapMid - 1)).toBe(1)
    expect(slotAt(slots, a.x + 50, rowGapMid + 1)).toBe(5)
  })
  it('outside the grid clamps to the nearest row / card', () => {
    expect(slotAt(slots, -100, -100)).toBe(0)
    expect(slotAt(slots, 99999, -100)).toBe(3)
    expect(slotAt(slots, -100, 99999)).toBe(8)
  })
  it('the empty end of the last row means "at the end"', () => {
    const empty = slots[3] // column 4 of row 1 → same column on the last row is empty
    expect(slotAt(slots, empty.x + 40, slots[9].y + 40)).toBe(9)
    expect(slotAt(slots, 99999, 99999)).toBe(9)
  })
  it('no slots → -1', () => {
    expect(slotAt([], 10, 10)).toBe(-1)
  })
})

describe('reduced motion: the insertion bar', () => {
  const slots = grid(10, 4)
  it('moving on → after the target card; moving back → before it; staying → none', () => {
    expect(insertSide(2, 5)).toBe('after')
    expect(insertSide(5, 2)).toBe('before')
    expect(insertSide(3, 3)).toBeNull()
  })
  it('sits in the middle of the gap beside the target', () => {
    expect(insertBar(slots, 2, 5)).toEqual({ x: slots[5].x + slots[5].w + 8, y: slots[5].y, h: slots[5].h })
    expect(insertBar(slots, 5, 0)).toEqual({ x: slots[0].x - 8, y: slots[0].y, h: slots[0].h })
    expect(insertBar(slots, 4, 4)).toBeNull()
    expect(insertBar(slots, 0, 42)).toBeNull()
  })
})

describe('gridStep: keyboard (arrows go to a card, Alt + arrows move it)', () => {
  it('←/→ one card, ↑/↓ one row, Home / End to the ends', () => {
    expect(gridStep(5, 'ArrowLeft', 10, 4)).toBe(4)
    expect(gridStep(5, 'ArrowRight', 10, 4)).toBe(6)
    expect(gridStep(5, 'ArrowUp', 10, 4)).toBe(1)
    expect(gridStep(5, 'ArrowDown', 10, 4)).toBe(9)
    expect(gridStep(5, 'Home', 10, 4)).toBe(0)
    expect(gridStep(5, 'End', 10, 4)).toBe(9)
  })
  it('clamps at the ends (the caller announces "already first / last")', () => {
    expect(gridStep(0, 'ArrowLeft', 10, 4)).toBe(0)
    expect(gridStep(9, 'ArrowRight', 10, 4)).toBe(9)
    expect(gridStep(2, 'ArrowUp', 10, 4)).toBe(0)
    expect(gridStep(6, 'ArrowDown', 10, 4)).toBe(9) // into the short last row → the end
  })
  it('one column: ↑/↓ behave like ←/→; bad column counts fall back to 1', () => {
    expect(gridStep(3, 'ArrowDown', 10, 1)).toBe(4)
    expect(gridStep(3, 'ArrowUp', 10, 0)).toBe(2)
    expect(gridStep(3, 'ArrowUp', 10, Number.NaN)).toBe(2)
  })
  it('other keys / empty list → null', () => {
    expect(gridStep(3, 'a', 10, 4)).toBeNull()
    expect(gridStep(3, 'Enter', 10, 4)).toBeNull()
    expect(gridStep(0, 'ArrowRight', 0, 4)).toBeNull()
  })
})

describe('autoScrollStep: scrolling near the edges while dragging', () => {
  const top = 100
  const bottom = 900
  it('nothing in the middle', () => {
    expect(autoScrollStep(500, top, bottom)).toBe(0)
    expect(autoScrollStep(top + AUTOSCROLL_EDGE, top, bottom)).toBe(0)
    expect(autoScrollStep(bottom - AUTOSCROLL_EDGE, top, bottom)).toBe(0)
  })
  it('faster the closer to the edge, full speed at / past it', () => {
    const half = autoScrollStep(top + AUTOSCROLL_EDGE / 2, top, bottom)
    expect(half).toBe(-Math.round(AUTOSCROLL_MAX * 0.25))
    expect(autoScrollStep(top, top, bottom)).toBe(-AUTOSCROLL_MAX)
    expect(autoScrollStep(top - 300, top, bottom)).toBe(-AUTOSCROLL_MAX)
    expect(autoScrollStep(bottom - AUTOSCROLL_EDGE / 2, top, bottom)).toBe(Math.round(AUTOSCROLL_MAX * 0.25))
    expect(autoScrollStep(bottom + 50, top, bottom)).toBe(AUTOSCROLL_MAX)
    expect(Math.abs(autoScrollStep(top + AUTOSCROLL_EDGE - 1, top, bottom))).toBeGreaterThanOrEqual(1)
  })
  it('short scrollers: the zones shrink so the middle third never scrolls', () => {
    expect(autoScrollStep(150, 100, 220)).toBe(0) // zone = 40px
    expect(autoScrollStep(110, 100, 220)).toBeLessThan(0)
    expect(autoScrollStep(150, 150, 150)).toBe(0)
  })
})

describe('movedPast: a press becomes a drag', () => {
  it('uses the slop of the pointer type (mouse when unknown)', () => {
    expect(movedPast(DRAG_SLOP.mouse, 0, 'mouse')).toBe(false)
    expect(movedPast(DRAG_SLOP.mouse + 1, 0, 'mouse')).toBe(true)
    expect(movedPast(4, 4, 'mouse')).toBe(true) // diagonal ≈ 5.7
    expect(movedPast(DRAG_SLOP.pen, 0, 'pen')).toBe(false)
    expect(movedPast(DRAG_SLOP.touch, 0, 'touch')).toBe(false)
    expect(movedPast(DRAG_SLOP.touch + 1, 0, 'touch')).toBe(true)
    expect(movedPast(DRAG_SLOP.mouse + 1, 0, '')).toBe(true)
  })
})

describe('flipOffsets: slides after an order change (Alt + arrow, undo / redo)', () => {
  const slots = grid(6, 3)
  it('only moved cards slide, from their old slot', () => {
    const prev = ['a', 'b', 'c', 'd', 'e', 'f']
    const next = moveItem(prev, 1, 4) // a c d e b f
    const off = flipOffsets(prev, next, slots)!
    expect([...off.keys()].sort()).toEqual(['b', 'c', 'd', 'e'])
    expect(off.get('b')).toEqual({ x: slots[1].x - slots[4].x, y: slots[1].y - slots[4].y })
    expect(off.get('c')).toEqual({ x: slots[2].x - slots[1].x, y: 0 })
    expect(off.has('a')).toBe(false)
  })
  it('no slide when cards were added / removed or slots are missing', () => {
    expect(flipOffsets(['a', 'b'], ['a', 'b', 'c'], grid(3, 3))).toBeNull()
    expect(flipOffsets(['a', 'b', 'c'], ['a', 'b', 'x'], grid(3, 3))).toBeNull()
    expect(flipOffsets(['a', 'b', 'c'], ['c', 'b', 'a'], grid(2, 3))).toBeNull()
    expect(flipOffsets(['a', 'a', 'b'], ['a', 'b', 'a'], grid(3, 3))).toBeNull()
  })
  it('same order → nothing slides', () => {
    expect(flipOffsets(['a', 'b'], ['a', 'b'], grid(2, 2))!.size).toBe(0)
  })
})

describe('words', () => {
  it('announces the old code, the new place and the new code', () => {
    expect(moveAnnouncement({ title: 'Bình minh', from: 2, to: 4, count: 12 })).toBe(
      'Đã chuyển S03 “Bình minh” tới vị trí 5/12, giờ là S05. Các mã cảnh đã đánh số lại.',
    )
    expect(moveAnnouncement({ title: '  ', from: 0, to: 1, count: 2 })).toBe('Đã chuyển S01 tới vị trí 2/2, giờ là S02. Các mã cảnh đã đánh số lại.')
    expect(edgeAnnouncement(0, 5, 'ArrowLeft')).toBe('S01 đã ở vị trí đầu.')
    expect(edgeAnnouncement(4, 5, 'ArrowDown')).toBe('S05 đã ở vị trí cuối (5/5).')
    expect(reorderToast(2, 0)).toBe('Đã chuyển S03 → S01 · mã cảnh đánh số lại theo thứ tự mới')
  })
})

// ---------------- the drop really moves the scene there (store), and what follows scene order ----------------

const scene = (i: number): Scene => ({
  id: 's' + (i + 1),
  order: i + 1,
  title: 'Cảnh ' + (i + 1),
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: i * 400 },
  note: '',
})
const project = (n: number): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes: Array.from({ length: n }, (_, i) => scene(i)),
})
const take = (id: string, sceneId: string, number: number, starred = false): Take => ({
  id,
  sceneId,
  number,
  status: 'completed',
  progress: 100,
  createdAt: number,
  startedAt: null,
  finishedAt: null,
  promptSnapshot: '',
  rawPromptSnapshot: '',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  cost: 1,
  starred,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
})

const order = () => sortedScenes(useProject.getState().project).map((s) => s.id)

describe('drop → moveScene(id, sceneOrderAt(to))', () => {
  beforeEach(() => {
    useProject.getState().loadProject(project(6))
    useProject.temporal.getState().clear()
    useRuns.setState({ takes: [] })
  })
  it('lands every card exactly where the marker showed it, codes renumbered 1…n', () => {
    const ids = order()
    for (let from = 0; from < ids.length; from++)
      for (let to = 0; to < ids.length; to++) {
        useProject.getState().loadProject(project(6))
        useProject.getState().moveScene(ids[from], sceneOrderAt(to))
        expect(order()).toEqual(moveItem(ids, from, to))
        expect(sortedScenes(useProject.getState().project).map((s) => sceneCode(s.order))).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06'])
      }
  })
  it('one move = one undo step', () => {
    const ids = order()
    useProject.getState().moveScene('s2', sceneOrderAt(4))
    expect(order()).toEqual(['s1', 's3', 's4', 's5', 's2', 's6'])
    undo()
    expect(order()).toEqual(ids)
  })
  it('"Phát liền" and the chosen-videos .zip follow the new scene order', () => {
    useRuns.setState({ takes: [take('t1', 's1', 1), take('t2', 's2', 1), take('t3a', 's3', 1, true), take('t3b', 's3', 2)] })
    expect(chosenTakeIds()).toEqual(['t1', 't2', 't3a'])
    useProject.getState().moveScene('s3', sceneOrderAt(0))
    expect(chosenTakeIds()).toEqual(['t3a', 't1', 't2'])
    expect(order().slice(0, 3)).toEqual(['s3', 's1', 's2'])
  })
})

import { describe, expect, it } from 'vitest'
import { arrange, bounds, LEGACY_ROWS, overlaps, placeBlock, resolveCols, spacingOf, type ArrangeInput, type ArrangeOptions, type ClusterIn } from '../arrange'
import { LAYOUT, ROW_H } from '../../store/project'

const cluster = (i: number, patch: Partial<ClusterIn> = {}): ClusterIn => ({ id: `s${i}`, order: i + 1, pos: { x: -i * 17, y: i * 3 }, cardW: LAYOUT.sceneW, cardH: LAYOUT.sceneH, rowW: 0, rowH: 0, inScope: true, ...patch })
const input = (n = 3): ArrangeInput => ({ clusters: Array.from({ length: n }, (_, i) => cluster(i)), assets: [], folders: [], takes: [], obstacles: [], stage: { w: 1440, h: 900 }, focusId: null, layout: LAYOUT })
const grid: ArrangeOptions = { ...LEGACY_ROWS, style: 'grid', video: 'chosen', gridCols: 2 }
const asset = (id: string, x = 0, y = 0) => ({ id, kind: 'character' as const, pos: { x, y }, w: LAYOUT.assetW, h: LAYOUT.assetH, libIndex: 0, firstUse: 0, inScope: true })
const folder = (id: string, x: number, y: number) => ({ id, pos: { x, y }, w: 240, h: 132, firstSceneOrder: null, inScope: true })
function apply(i: ArrangeInput, r: ReturnType<typeof arrange>): ArrangeInput {
  return { ...i, clusters: i.clusters.map((s) => ({ ...s, pos: r.positions[s.id] ?? s.pos })), assets: i.assets.map((s) => ({ ...s, pos: r.positions[s.id] ?? s.pos })), folders: i.folders.map((s) => ({ ...s, pos: r.positions[s.id] ?? s.pos })), takes: i.takes.map((t) => ({ ...t, pos: t.id in r.takes ? r.takes[t.id] : t.pos })) }
}

describe('pure arrange engine', () => {
  it('matches current rows and is idempotent, without mutating its snapshot', () => {
    const i = input(); i.assets = [asset('a'), { ...asset('b'), libIndex: 1 }]
    const saved = structuredClone(i), r = arrange(i, LEGACY_ROWS)
    i.clusters.forEach((s, n) => expect(r.positions[s.id]).toEqual({ x: LAYOUT.scenesX, y: LAYOUT.scenesY + n * ROW_H }))
    expect(r.positions.b).toEqual({ x: LAYOUT.assetX, y: LAYOUT.scenesY + LAYOUT.assetH + LAYOUT.assetGapY })
    expect(arrange(apply(i, r), LEGACY_ROWS).positions).toEqual({})
    expect(i).toEqual(saved)
    expect(spacingOf('normal', LAYOUT).asset).toBe(LAYOUT.assetGapY)
  })
  it('uses measured/resized card and row dimensions, wide assets cannot cover scenes', () => {
    const i = input(); i.clusters[0].cardH = 900; i.clusters[1].rowH = 560
    i.assets = [{ ...asset('a'), w: 520, h: 820 }]
    const r = arrange(i, LEGACY_ROWS)
    expect(r.positions.s0.x).toBeGreaterThanOrEqual(LAYOUT.assetX + 520 + 48)
    expect(r.positions.s1.y).toBe(LAYOUT.scenesY + 900 + LAYOUT.gapY)
    expect(r.positions.s2.y).toBe(r.positions.s1.y + 560 + LAYOUT.gapY)
  })
  it.each(['chosen', 'all'] as const)('grid reserves a new video slot in %s mode and aligns columns', (video) => {
    const i = input(4); i.clusters[0].rowW = LAYOUT.takeOffsetX + 600; i.clusters[2].cardW = 720
    const r = arrange(i, { ...grid, video })
    const spare = video === 'all' ? LAYOUT.takeW + LAYOUT.takeGapX : 0
    expect(r.positions.s1.x - r.positions.s0.x).toBeGreaterThanOrEqual(LAYOUT.sceneW + i.clusters[0].rowW + spare + 96)
    expect(r.positions.s1.x).toBe(r.positions.s3.x)
    expect(r.boxes.find((b) => b.id === 'slot:s1')?.w).toBe(LAYOUT.takeW)
    const groups = i.clusters.map((s) => bounds(r.boxes.filter((b) => b.id === s.id || b.id === `slot:${s.id}`)))
    groups.forEach((a, n) => groups.slice(n + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)))
    expect(arrange(apply(i, r), { ...grid, video }).positions).toEqual({})
  })
  it('wraps grid assets and puts strip references above the scenes', () => {
    const i = input(8); i.assets = Array.from({ length: 12 }, (_, n) => ({ ...asset(`a${n}`), libIndex: n }))
    const r = arrange(i, grid), refs = r.boxes.filter((b) => b.kind === 'asset')
    expect(new Set(refs.map((a) => a.x)).size).toBeGreaterThan(1)
    expect(bounds(refs).x + bounds(refs).w).toBeLessThan(r.positions.s0.x)
    const strip = arrange(i, { ...grid, style: 'strip' })
    expect(new Set(i.clusters.map((s) => strip.positions[s.id].y)).size).toBe(1)
    expect(bounds(strip.boxes.filter((b) => b.kind === 'asset')).y + bounds(strip.boxes.filter((b) => b.kind === 'asset')).h).toBeLessThan(strip.positions.s0.y)
  })
  it('keeps free folders, lifts collisions above the scene block and avoids other folders', () => {
    const i = input(); i.folders = [folder('hit', LAYOUT.scenesX, LAYOUT.scenesY), folder('stay', -1200, 0), folder('above', LAYOUT.scenesX, -140)]
    const r = arrange(i, grid)
    expect(r.positions.stay).toBeUndefined()
    expect(r.positions.above).toBeUndefined()
    const f = r.boxes.find((b) => b.id === 'hit')!
    expect(f.y + f.h).toBeLessThan(r.positions.s0.y)
    for (const other of r.boxes.filter((b) => b.id !== 'hit')) expect(overlaps(f, other)).toBe(false)
    expect(arrange(apply(i, r), grid).positions).toEqual({})
  })
  it('moves only colliding kept assets to the left', () => {
    const i = input(); i.assets = [asset('hit', LAYOUT.scenesX, LAYOUT.scenesY), asset('stay', -1000, 0)]
    const r = arrange(i, { ...grid, refs: 'keep' })
    expect(r.positions.stay).toBeUndefined()
    expect(r.positions.hit.x + LAYOUT.assetW).toBeLessThan(r.positions.s0.x)
    expect(r.stats.assetsMoved).toBe(1)
  })
  it('selection leaves other nodes alone and finds space around obstacles', () => {
    const i = input(3); i.clusters[2].inScope = false
    i.obstacles = [{ x: -100, y: -100, w: 2000, h: 1000 }]
    const r = arrange(i, { ...grid, scope: 'selection' })
    expect(r.positions.s2).toBeUndefined()
    expect(r.fitIds).toContain('s0')
    for (const b of r.boxes) expect(overlaps(b, i.obstacles[0])).toBe(false)
    const d = placeBlock([{ x: 0, y: 0, w: 500, h: 300 }], [{ x: -10, y: -10, w: 20000, h: 20000 }], { x: 0, y: 0 })
    expect(d).toEqual({ dx: 20150, dy: 0, movedAway: true })
  })
  it('resets nudges and hidden positions; explicit follows keep the relative offset, missing scenes are ignored', () => {
    const i = input(1)
    i.takes = ['off', 'nudge', 'hidden', 'gone'].map((id) => ({ id, sceneId: id === 'gone' ? 'missing' : 's0', pos: { x: 1000, y: 700 }, offRow: id !== 'nudge', shown: id !== 'hidden', w: 224, h: 230, slot: 0 }))
    expect(arrange(i, grid).takes).toEqual({ off: null, nudge: null, hidden: null })
    const r = arrange(i, { ...grid, placedTakes: 'follow' })
    expect(r.takes.nudge).toBeNull()
    expect(r.takes.off).toEqual({ x: 1000 + r.positions.s0.x, y: 700 + r.positions.s0.y })
    expect(r.takes.hidden).toEqual(r.takes.off)
    expect(r.takes.gone).toBeUndefined()
  })
  it('orders by kind then first use; returns an empty result for empty or absent selections', () => {
    const i = input(0)
    expect(arrange(i, grid)).toMatchObject({ positions: {}, takes: {}, cols: 0, fitZoom: 1, fitIds: [] })
    i.assets = [{ ...asset('style'), kind: 'style', libIndex: 0 }, { ...asset('late'), firstUse: 9, libIndex: 1 }, { ...asset('early'), firstUse: 1, libIndex: 2 }]
    const r = arrange(i, { ...LEGACY_ROWS, refs: 'byKind' })
    expect(r.positions.early.y).toBeLessThan(r.positions.late.y)
    expect(r.positions.late.y).toBeLessThan(r.positions.style.y)
  })
  it('chooses deterministic bounded columns and fits a local region for large projects', () => {
    expect(resolveCols(3, 640, 304, 1.6, 'auto', 96, 48)).toBe(3)
    expect(resolveCols(40, 640, 304, 1.6, 'auto', 96, 48)).toBe(6)
    expect(resolveCols(600, 640, 304, 1.6, 'auto', 96, 48)).toBe(10)
    const i = input(1000); i.focusId = 's500'
    const start = performance.now(), r = arrange(i, { ...grid, gridCols: 'auto' })
    const elapsed = performance.now() - start
    expect(r.fitZoom).toBeLessThan(0.1)
    expect(r.fitIds).toContain('s500')
    expect(r.fitIds.length).toBeLessThan(30)
    expect(elapsed).toBeLessThan(60)
    expect(arrange(i, { ...grid, gridCols: 'auto' })).toEqual(r)
  })
  it('handles XL geometry (1000 scenes, 3000 videos, 60 images, 20 folders) within the pure-engine budget', () => {
    const i = input(1000)
    i.clusters = i.clusters.map((s, n) => ({ ...s, rowW: LAYOUT.takeOffsetX + 3 * LAYOUT.takeW + 2 * LAYOUT.takeGapX, cardH: n % 7 ? LAYOUT.sceneH : 560 }))
    i.takes = i.clusters.flatMap((s) => Array.from({ length: 3 }, (_, n) => ({ id: `${s.id}:t${n}`, sceneId: s.id, pos: null, offRow: false, shown: true, w: LAYOUT.takeW, h: LAYOUT.takeH, slot: n * (LAYOUT.takeW + LAYOUT.takeGapX) })))
    i.assets = Array.from({ length: 60 }, (_, n) => ({ ...asset(`a${n}`), libIndex: n }))
    i.folders = Array.from({ length: 20 }, (_, n) => folder(`f${n}`, LAYOUT.scenesX, LAYOUT.scenesY))
    const start = performance.now(), r = arrange(i, { ...grid, gridCols: 'auto', video: 'all' })
    expect(performance.now() - start).toBeLessThan(60)
    expect(r.stats.foldersMoved).toBe(20)
    const fs = r.boxes.filter((b) => b.kind === 'folder')
    fs.forEach((f, n) => fs.slice(n + 1).forEach((b) => expect(overlaps(f, b)).toBe(false)))
    expect(arrange(apply(i, r), { ...grid, gridCols: 'auto', video: 'all' }).positions).toEqual({})
  })
})

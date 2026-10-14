import { describe, expect, it } from 'vitest'
import { arrange, bounds, LEGACY_ROWS, overlaps, placeBlock, resolveCols, spacingOf, type ArrangeInput, type ArrangeOptions, type ArrangeResult, type Box, type ClusterIn, type TakeIn } from '../arrange'
import { FOLDER_H, FOLDER_W } from '../folders'
import type { AssetKind } from '../types'
import { LAYOUT, NODE_SIZE, ROW_H } from '../../store/project'

const cluster = (i: number, patch: Partial<ClusterIn> = {}): ClusterIn => ({ id: `s${i}`, order: i + 1, pos: { x: -i * 17, y: i * 3 }, cardW: LAYOUT.sceneW, cardH: LAYOUT.sceneH, rowW: 0, rowH: 0, inScope: true, ...patch })
const input = (n = 3): ArrangeInput => ({ clusters: Array.from({ length: n }, (_, i) => cluster(i)), assets: [], folders: [], takes: [], obstacles: [], stage: { w: 1440, h: 900 }, focusId: null, layout: LAYOUT })
const grid: ArrangeOptions = { ...LEGACY_ROWS, style: 'grid', video: 'chosen', gridCols: 2 }
const asset = (id: string, x = 0, y = 0) => ({ id, kind: 'character' as const, pos: { x, y }, w: LAYOUT.assetW, h: LAYOUT.assetH, libIndex: 0, firstUse: 0, inScope: true })
const folder = (id: string, x: number, y: number) => ({ id, pos: { x, y }, w: 240, h: 132, firstSceneOrder: null, inScope: true })
function apply(i: ArrangeInput, r: ReturnType<typeof arrange>): ArrangeInput {
  return { ...i, clusters: i.clusters.map((s) => ({ ...s, pos: r.positions[s.id] ?? s.pos })), assets: i.assets.map((s) => ({ ...s, pos: r.positions[s.id] ?? s.pos })), folders: i.folders.map((s) => ({ ...s, pos: r.positions[s.id] ?? s.pos })), takes: i.takes.map((t) => ({ ...t, pos: t.id in r.takes ? r.takes[t.id] : t.pos })) }
}

/** mulberry32: a small seeded generator, so a failing sweep case replays. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/**
 * A random canvas: scenes of random card / take sizes and positions; images and folders on distinct 1000px cells (they
 * never overlap one another before the arrange), many of them inside the area the scenes are arranged into.
 */
function randomInput(seed: number): ArrangeInput {
  const r = seeded(seed), int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1))
  const takes: TakeIn[] = []
  const clusters = Array.from({ length: int(1, 14) }, (_, i): ClusterIn => {
    const cardW = r() < 0.3 ? int(NODE_SIZE.scene.minW, NODE_SIZE.scene.maxW) : LAYOUT.sceneW
    const cardH = r() < 0.3 ? int(NODE_SIZE.scene.minH, NODE_SIZE.scene.maxH) : LAYOUT.sceneH
    let slot = 0, rowH = 0
    for (let k = int(0, 4); k > 0; k--) {
      const w = r() < 0.3 ? int(NODE_SIZE.take.minW, NODE_SIZE.take.maxW) : LAYOUT.takeW
      const h = r() < 0.3 ? int(NODE_SIZE.take.minH, NODE_SIZE.take.maxH) : LAYOUT.takeH
      const pos = r() < 0.3 ? { x: int(-3000, 3000), y: int(-3000, 3000) } : null
      takes.push({ id: `s${i}:t${k}`, sceneId: `s${i}`, pos, offRow: !!pos && r() < 0.5, shown: true, w, h, slot })
      slot += w + LAYOUT.takeGapX
      rowH = Math.max(rowH, h)
    }
    return { ...cluster(i), order: int(1, 40), pos: { x: int(-3000, 3000), y: int(-3000, 3000) }, cardW, cardH, rowW: slot ? LAYOUT.takeOffsetX + slot - LAYOUT.takeGapX : 0, rowH }
  })
  const cells = new Set<string>()
  const cell = (): { x: number; y: number } => {
    for (;;) {
      const cx = int(-6, 8), cy = int(-6, 8), key = `${cx}:${cy}`
      if (!cells.has(key)) { cells.add(key); return { x: cx * 1000, y: cy * 1000 } }
    }
  }
  const kinds: AssetKind[] = ['character', 'location', 'prop', 'style']
  const assets = Array.from({ length: int(0, 8) }, (_, n) => ({
    id: `a${n}`, kind: kinds[int(0, 3)], pos: cell(), w: int(NODE_SIZE.asset.minW, NODE_SIZE.asset.maxW), h: int(NODE_SIZE.asset.minH, NODE_SIZE.asset.maxH),
    libIndex: n, firstUse: r() < 0.3 ? Infinity : int(1, 40), inScope: true,
  }))
  const folders = Array.from({ length: int(0, 4) }, (_, n) => ({ id: `f${n}`, pos: cell(), w: FOLDER_W, h: FOLDER_H, firstSceneOrder: r() < 0.5 ? null : int(1, 40), inScope: true }))
  return { clusters, assets, folders, takes, obstacles: [], stage: { w: 1256, h: 960 }, focusId: null, layout: LAYOUT }
}
/** What must never overlap after an arrange: each cluster (card + its take row / reserved slot), image and folder. */
function occupiedBoxes(i: ArrangeInput, r: ArrangeResult): { id: string; box: Box }[] {
  const byId = new Map(r.boxes.map((b) => [b.id, b]))
  return [
    ...i.clusters.map((s) => ({ id: s.id, box: bounds([byId.get(s.id)!, ...(byId.has(`slot:${s.id}`) ? [byId.get(`slot:${s.id}`)!] : [])]) })),
    ...r.boxes.filter((b) => b.kind === 'asset' || b.kind === 'folder').map((b) => ({ id: b.id, box: b as Box })),
  ]
}
const OPTION_SWEEP: ArrangeOptions[] = (['rows', 'grid', 'strip'] as const).flatMap((style) =>
  (['tight', 'normal', 'roomy'] as const).flatMap((spacing) => (['column', 'byKind', 'keep'] as const).flatMap((refs) => (['keep', 'top'] as const).flatMap((folders) =>
    (['all', 'chosen'] as const).flatMap((video) => (['reset', 'follow'] as const).map((placedTakes): ArrangeOptions =>
      ({ ...LEGACY_ROWS, style, spacing, refs, folders, video, placedTakes, gridCols: style === 'grid' && refs === 'byKind' ? 3 : 'auto' })))))))

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
  it('never overlaps clusters, images or folders and is idempotent, for every option on random canvases (seeded)', () => {
    expect(OPTION_SWEEP).toHaveLength(216)
    for (let seed = 1; seed <= 24; seed++) {
      const i = randomInput(seed)
      for (const opts of OPTION_SWEEP) {
        const r = arrange(i, opts), list = occupiedBoxes(i, r)
        for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
          if (overlaps(list[a].box, list[b].box)) expect.fail(`seed ${seed} ${JSON.stringify(opts)}: ${list[a].id} overlaps ${list[b].id}`)
        }
        const again = arrange(apply(i, r), opts)
        if (Object.keys(again.positions).length || Object.keys(again.takes).length) {
          expect.fail(`seed ${seed} ${JSON.stringify(opts)}: second run moved ${JSON.stringify(again.positions)} ${JSON.stringify(again.takes)}`)
        }
      }
    }
  })
  it('selection with images left in place: they neither anchor nor ride along with the block, which avoids them', () => {
    const i = input(2)
    i.clusters[0].pos = { x: 1000, y: 1000 }; i.clusters[1].pos = { x: 1000, y: 1500 }
    // The selected image sits above-left of the scenes (it would anchor the block on itself); an obstacle covers the anchor.
    i.assets = [asset('kept', 300, 400)]
    i.obstacles = [{ x: 900, y: 900, w: 2400, h: 900 }]
    const r = arrange(i, { ...grid, scope: 'selection', refs: 'keep' })
    expect(r.positions.kept).toBeUndefined()
    expect(r.stats.assetsMoved).toBe(0)
    const kept = { x: 300, y: 400, w: LAYOUT.assetW, h: LAYOUT.assetH }
    for (const b of r.boxes.filter((x) => x.id !== 'kept')) {
      expect(overlaps(b, kept)).toBe(false)
      expect(overlaps(b, i.obstacles[0])).toBe(false)
    }
    // Without the obstacle the block starts where the scenes were, not at the image.
    const free = arrange({ ...i, obstacles: [] }, { ...grid, scope: 'selection', refs: 'keep' })
    expect(free.positions.s0 ?? i.clusters[0].pos).toEqual({ x: 1000, y: 1000 })
    expect(free.positions.kept).toBeUndefined()
  })
  it('the folder band sits right above the block, whatever images are left far above it', () => {
    const i = input(); i.assets = [asset('high', -4000, -9000)]; i.folders = [folder('hit', LAYOUT.scenesX, LAYOUT.scenesY)]
    const r = arrange(i, { ...grid, refs: 'keep' })
    expect(r.positions.high).toBeUndefined()
    const f = r.boxes.find((b) => b.id === 'hit')!
    expect(f.y + f.h).toBe(r.positions.s0.y - spacingOf('normal', LAYOUT).top)
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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { adoptUserNodes, getNodesInside, type InternalNodeBase, type NodeBase } from '@xyflow/system'
import { DOT_TOP, estimatedGeometry, fallbackNodeSize, initialViewport, takeDotTop } from '../canvasModel'
import { LAYOUT } from '../../../store/project'

describe('initial canvas geometry', () => {
  it('uses current defaults and saved sizes without supplying measured state', () => {
    for (const type of ['scene', 'asset', 'take', 'folder']) {
      const g = estimatedGeometry(type)
      const size = fallbackNodeSize(type)
      expect([g.initialWidth, g.initialHeight]).toEqual([size.w, size.h])
      expect(g).not.toHaveProperty('measured')
      expect(g).not.toHaveProperty('width')
      expect(g).not.toHaveProperty('height')
    }
    expect(estimatedGeometry('scene', { w: 280, h: 200 }).initialWidth).toBe(LAYOUT.sceneW)
    expect(estimatedGeometry('scene', { w: 500, h: 600 }).initialHeight).toBe(600)
  })

  it('matches symbolic take anchors, transform handles and the CSS border offsets', () => {
    const scene = estimatedGeometry('scene', null, false, 'transform')
    expect(scene.handles.map((h) => [h.id, h.x, h.y])).toEqual([
      ['ref', 0.5, DOT_TOP + 1], ['take', LAYOUT.sceneW - 0.5, DOT_TOP + 1],
      ['first', 0.5, LAYOUT.sceneH - 53], ['last', 0.5, LAYOUT.sceneH - 29],
    ])
    for (const far of [false, true]) {
      const box = { w: 440, h: 320 }
      const take = estimatedGeometry('take', box, far)
      expect(take.handles.map((h) => h.y)).toEqual([takeDotTop(box, far) + 1, takeDotTop(box, far) + 1])
      expect(estimatedGeometry('folder', null, far).handles[0].y).toBe(far ? 41 : 26)
    }
    expect(estimatedGeometry('asset').handles[0].y).toBe(LAYOUT.assetH / 2)
  })

  it('culls offscreen nodes before measurement and keeps actual handles when estimates are removed', () => {
    const nodes: NodeBase[] = [0, 10000].map((x, i) => ({ id: String(i), position: { x, y: 0 }, data: {}, ...estimatedGeometry('scene') }))
    const lookup = new Map<string, InternalNodeBase>()
    const parents = new Map<string, Map<string, InternalNodeBase>>()
    adoptUserNodes(nodes, lookup, parents)
    expect(getNodesInside(lookup, { x: 0, y: 0, width: 1000, height: 800 }, [0, 0, 1], true).map((n) => n.id)).toEqual(['0'])
    const actual = { source: [{ id: 'take', type: 'source' as const, position: nodes[0].handles![1].position, nodeId: '0', x: 500, y: 70, width: 0, height: 0 }], target: [] }
    lookup.get('0')!.internals.handleBounds = actual
    const { handles: _handles, initialWidth: _w, initialHeight: _h, ...node } = nodes[0]
    adoptUserNodes([{ ...node, measured: { width: 501, height: 320 } }, nodes[1]], lookup, parents)
    expect(lookup.get('0')!.internals.handleBounds).toBe(actual)
    expect(lookup.get('0')!.measured).toEqual({ width: 501, height: 320 })
  })

  it('fits estimates with finite values, including negative positions; waits on empty/zero viewports', () => {
    const nodes = [{ id: 's', position: { x: -500, y: -400 }, data: {}, ...estimatedGeometry('scene') }]
    expect(initialViewport([], 1000, 800)).toBeNull()
    expect(initialViewport(nodes, 0, 800)).toBeNull()
    expect(initialViewport(nodes, 1000, 0)).toBeNull()
    const vp = initialViewport(nodes, 1000, 800)!
    expect(Object.values(vp).every(Number.isFinite)).toBe(true)
    expect(vp.zoom).toBe(1)
    expect(-500 * vp.zoom + vp.x).toBeGreaterThanOrEqual(0)
    expect(-400 * vp.zoom + vp.y).toBeGreaterThanOrEqual(0)
  })

  it('wires initialization once and removes estimates on measurement without an automatic fit pass', () => {
    const src = readFileSync(new URL('../CanvasView.tsx', import.meta.url), 'utf8')
    expect(src).toContain('onInit={onInit}')
    expect(src).toContain('done: !!savedViewport')
    expect(src).toContain('initialFit.current.done = true')
    expect(src).toContain('!measured ? estimatedGeometry(')
    expect(src).not.toMatch(/^\s+fitView(?:Options)?=/m)
  })
})

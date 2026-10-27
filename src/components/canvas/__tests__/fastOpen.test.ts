import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { adoptUserNodes, getNodesInside, type InternalNodeBase, type NodeBase } from '@xyflow/system'
import { DOT_TOP, ESTIMATED_DOTS, estimatedGeometry, estimateDependsOnZoom, fallbackNodeSize, initialViewport, LOD_ZOOM, openingViewport, takeDotTop } from '../canvasModel'
import { LAYOUT, ROW_H } from '../../../store/project'

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

  it('wires the opening viewport before React Flow mounts, onInit only as the zero-size fallback', () => {
    const src = readFileSync(new URL('../CanvasView.tsx', import.meta.url), 'utf8')
    // CanvasView mounts the board once its size is known; CanvasInner fits from the estimates in its first render.
    expect(src).toContain('useLayoutEffect(() => setReady(true), [])')
    expect(src).toMatch(/\{ready && \(\s*<ReactFlowProvider key=\{projectId\}>/)
    expect(src).toContain('startViewport.current = root ? openingViewport(nodes, root.clientWidth, root.clientHeight) : null')
    expect(src).toContain('defaultViewport={startViewport.current ?? undefined}')
    expect(src).toContain('done: !!startViewport.current')
    expect(src).toContain('onInit={onInit}')
    expect(src).toContain('initialFit.current.done = true')
    expect(src).toContain('!measured ? estimatedGeometry(')
    expect(src).not.toMatch(/^\s+fitView(?:Options)?=/m)
  })
})

describe('fit everything with nodes never measured', () => {
  const ROWS = 18
  // Rows 0–1 were on screen (measured, the first one taller than its estimate); the others never were.
  const nodes: NodeBase[] = Array.from({ length: ROWS }, (_, i) => ({
    id: `s${i}`, type: 'scene', position: { x: 0, y: i * ROW_H }, data: {},
    ...(i < 2 ? { measured: { width: LAYOUT.sceneW, height: i === 0 ? 400 : LAYOUT.sceneH } } : estimatedGeometry('scene')),
  }))

  it('React Flow would wait for every measurement and fit the measured nodes only', () => {
    const lookup = new Map<string, InternalNodeBase>()
    const { nodesInitialized } = adoptUserNodes(nodes, lookup, new Map())
    // rf.fitView() is queued until nodesInitialized, which never comes for nodes that are never rendered…
    expect(nodesInitialized).toBe(false)
    // …because estimated nodes are not force-rendered once any more (they have handle bounds).
    expect(getNodesInside(lookup, { x: 0, y: 0, width: 1440, height: 900 }, [0, 0, 1], true).map((n) => n.id)).toEqual(['s0', 's1', 's2'])
  })

  it('fits every node — measured size, else stored size, else estimate — and does not wait for measurement', () => {
    const vp = initialViewport(nodes, 1440, 900)!
    expect(vp.zoom).toBeLessThan(LOD_ZOOM)
    expect(vp.zoom).toBeGreaterThanOrEqual(0.1)
    for (const n of nodes) {
      const h = n.measured?.height ?? n.initialHeight!
      expect(n.position.y * vp.zoom + vp.y, n.id).toBeGreaterThanOrEqual(0)
      expect((n.position.y + h) * vp.zoom + vp.y, n.id).toBeLessThanOrEqual(900)
      expect((n.position.x + LAYOUT.sceneW) * vp.zoom + vp.x, n.id).toBeLessThanOrEqual(1440)
    }
    // A stored size wins over the estimate (React Flow's own order: measured → width → initialWidth).
    const sized = [{ id: 'big', position: { x: 0, y: 0 }, data: {}, width: 3000, height: 304, ...estimatedGeometry('scene') }]
    expect(initialViewport(sized, 1440, 900)!.zoom).toBeLessThan(0.5)
    expect(initialViewport([{ ...sized[0], width: undefined }], 1440, 900)!.zoom).toBe(1)
  })

  it('opens a board too tall to read when fitted at its top, as wide as the stage; a readable fit stays as it is', () => {
    const fit = initialViewport(nodes, 600, 630)!
    const vp = openingViewport(nodes, 600, 630)!
    expect(fit.zoom).toBeLessThan(0.2)
    expect(vp.zoom).toBeGreaterThan(1.5 * fit.zoom)
    // the first row's top is on screen near the top, the whole width fits
    expect(nodes[0].position.y * vp.zoom + vp.y).toBeGreaterThanOrEqual(0)
    expect(nodes[0].position.y * vp.zoom + vp.y).toBeLessThan(100)
    expect(vp.x).toBeGreaterThanOrEqual(0)
    expect(LAYOUT.sceneW * vp.zoom + vp.x).toBeLessThanOrEqual(600)
    const few = nodes.slice(0, 2)
    expect(openingViewport(few, 1440, 900)).toEqual(initialViewport(few, 1440, 900))
    expect(openingViewport([], 600, 630)).toBeNull()
  })

  it('F / "Vừa màn hình" / "Sắp xếp" with nothing selected use it, never rf.fitView', () => {
    const src = readFileSync(new URL('../CanvasView.tsx', import.meta.url), 'utf8')
    expect(src).not.toContain('rf.fitView(')
    expect(src).toContain('const next = initialViewport(rf.getNodes(), width, height)')
  })
})

describe('estimates follow the CSS and the rendered handles', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const rule = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }

  it('dot offsets and card borders match canvas.css / saving.css', () => {
    const canvas = read('../canvas.css'), saving = read('../saving.css'), take = read('../takeNode.css')
    const d = ESTIMATED_DOTS
    expect(rule(canvas, '.cv-stage .cv-h-first')).toContain(`top: calc(100% - ${d.firstFromBottom}px);`)
    expect(rule(canvas, '.cv-stage .cv-h-last')).toContain(`top: calc(100% - ${d.lastFromBottom}px);`)
    expect(rule(saving, '.cv-stage .cv-h.cv-h-folder')).toContain(`top: ${d.folderTop}px;`)
    expect(rule(saving, '.cv-stage .is-far .cv-h.cv-h-folder')).toContain(`top: ${d.folderTopFar}px;`)
    expect(rule(canvas, '.cv-stage .react-flow__handle-left.cv-h')).toContain(`left: -${d.sideOverhang}px;`)
    expect(rule(canvas, '.cv-stage .react-flow__handle-right.cv-h')).toContain(`right: -${d.sideOverhang}px;`)
    // Zero-sized handles, and the 1px card border every estimate adds to a CSS `top`.
    expect(rule(canvas, '.cv-stage .cv-h')).toMatch(/width: 0;\s+height: 0;/)
    for (const [css, card] of [[canvas, '.cv-scene'], [saving, '.cv-folder'], [take, '.cv-take']]) {
      expect(rule(css, card), card).toContain('border: 1px solid')
    }
  })

  it('every rendered <Handle> id has an estimate, and nothing else', () => {
    const handleIds = (file: string) => {
      const src = read(`../${file}`)
      const starts = [...src.matchAll(/<Handle\s/g)].map((m) => m.index)
      return starts.map((at, i) => {
        const id = /\bid="([\w-]+)"/.exec(src.slice(at, starts[i + 1] ?? at + 600))
        expect(id, `${file}: a <Handle> without a literal id`).not.toBeNull()
        return id![1]
      }).sort()
    }
    const estimated = (type: string) => [...new Set(['t2v', 'i2v', 'transform']
      .flatMap((mode) => estimatedGeometry(type, null, false, mode).handles.map((h) => h.id!)))].sort()
    for (const [type, file] of [['scene', 'SceneNode.tsx'], ['take', 'TakeNode.tsx'], ['asset', 'AssetNode.tsx'], ['folder', 'FolderNode.tsx']]) {
      expect(handleIds(file), file).toEqual(estimated(type))
    }
  })

  it('every handle a wire uses (buildRawEdges) exists on the estimates with the right direction', () => {
    const src = read('../CanvasView.tsx')
    const body = src.slice(src.indexOf('function buildRawEdges('), src.indexOf('\n}\n', src.indexOf('function buildRawEdges(')))
    const literals = (key: string) => [...body.matchAll(new RegExp(`${key}: '([\\w-]+)'`, 'g'))].map((m) => m[1])
    const all = ['scene', 'take', 'asset', 'folder'].flatMap((type) => estimatedGeometry(type, null, false, 'transform').handles)
    const ids = (kind: 'source' | 'target') => new Set(all.filter((h) => h.type === kind).map((h) => h.id))
    expect(literals('sourceHandle').length).toBeGreaterThan(0)
    for (const id of literals('sourceHandle')) expect(ids('source').has(id), id).toBe(true)
    const targets = literals('targetHandle')
    // The frame wires name their dot through `which` ('first' | 'last').
    expect(body).toContain("for (const which of ['first', 'last'] as const)")
    expect(body).toContain('targetHandle: which')
    for (const id of [...targets, 'first', 'last']) expect(ids('target').has(id), id).toBe(true)
  })
})

describe('estimates across the far / near zoom level (LOD_ZOOM)', () => {
  it('only the folder and a resized take depend on it; the others keep the same estimate', () => {
    const cases: [string, { w: number; h: number } | null, boolean][] = [
      ['scene', null, false], ['scene', { w: 500, h: 600 }, false], ['asset', null, false], ['asset', { w: 300, h: 360 }, false],
      ['take', null, false], ['take', { w: 440, h: 320 }, true], ['folder', null, true],
    ]
    for (const [type, size, depends] of cases) {
      expect(estimateDependsOnZoom(type, size), `${type} ${JSON.stringify(size)}`).toBe(depends)
      const near = estimatedGeometry(type, size, false, 'transform'), far = estimatedGeometry(type, size, true, 'transform')
      if (depends) expect(far, type).not.toEqual(near)
      else expect(far, type).toEqual(near)
    }
  })

  it('CanvasView keeps an unmeasured node object across LOD_ZOOM unless its estimate depends on it', () => {
    const src = readFileSync(new URL('../CanvasView.tsx', import.meta.url), 'utf8')
    expect(src).toContain('(far === estimateState.current.far || !estimateDependsOnZoom(base.type, box))')
  })
})

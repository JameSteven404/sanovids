// Headless only: SANOVIDS_TIMING=1 npx vitest run --pool threads src/perf/__tests__/fastOpen.timing.test.ts
// Measures geometry preparation/culling, not React rendering, DOM layout or full project-open latency.
import { expect, it } from 'vitest'
import { adoptUserNodes, getNodesInside, type InternalNodeBase, type NodeBase } from '@xyflow/system'
import { estimatedGeometry, initialViewport } from '../../components/canvas/canvasModel'
import { generateProject } from '../../devtools/stress/synth'
import { createRng } from '../../devtools/stress/rng'
import { defaultTakePosition, drawnSceneSize, LAYOUT } from '../../store/project'

it.skipIf(!process.env.SANOVIDS_TIMING)('compares cold geometry at 300 / 1000 / 3000 scenes', () => {
  const generated = generateProject(createRng('5a17c0de', 'fast-open'), '5a17c0de', 'OVER')
  const rows: object[] = []
  for (const count of [300, 1000, 3000]) {
    const scenes = generated.project.scenes.slice(0, count)
    const sceneById = new Map(scenes.map((s) => [s.id, s]))
    const takes = generated.takes.filter((t) => sceneById.has(t.sceneId))
    const base: NodeBase[] = [
      ...scenes.map((s) => ({ id: s.id, type: 'scene', data: { mode: s.settings.mode }, position: s.position, width: drawnSceneSize(s.size)?.w, height: drawnSceneSize(s.size)?.h })),
      ...generated.project.assets.filter((a) => a.position).map((a) => ({ id: a.id, type: 'asset', data: {}, position: a.position!, width: a.size?.w, height: a.size?.h })),
      ...takes.map((t) => ({ id: t.id, type: 'take', data: {}, position: t.position ?? defaultTakePosition(sceneById.get(t.sceneId)!.position, t.number - 1, drawnSceneSize(sceneById.get(t.sceneId)!.size)?.w ?? LAYOUT.sceneW), width: t.size?.w, height: t.size?.h })),
    ]
    const estimated = () => base.map((n) => ({ ...n, ...estimatedGeometry(n.type, n.width && n.height ? { w: n.width, h: n.height } : null, true, n.data.mode as string | undefined) }))
    const vp = initialViewport(estimated(), 1440, 900)!
    const transform: [number, number, number] = [vp.x, vp.y, vp.zoom]
    const run = (after: boolean) => {
      const start = performance.now()
      const nodes = after ? estimated() : base
      const lookup = new Map<string, InternalNodeBase>()
      adoptUserNodes(nodes, lookup, new Map())
      const visible = getNodesInside(lookup, { x: 0, y: 0, width: 1440, height: 900 }, transform, true).length
      return { ms: performance.now() - start, visible }
    }
    for (let i = 0; i < 5; i++) { run(false); run(true) }
    const before: ReturnType<typeof run>[] = [], after: ReturnType<typeof run>[] = []
    for (let i = 0; i < 21; i++) {
      // Alternate order to avoid consistently giving one case the warmer CPU/cache.
      if (i % 2) { after.push(run(true)); before.push(run(false)) }
      else { before.push(run(false)); after.push(run(true)) }
    }
    const median = (samples: typeof before) => samples.map((s) => s.ms).sort((a, b) => a - b)[10].toFixed(3)
    expect(before[0].visible).toBe(base.length)
    expect(after[0].visible).toBeLessThan(base.length)
    rows.push({ scenes: count, nodes: base.length, beforeMs: median(before), afterMs: median(after), beforeMountCandidates: before[0].visible, afterMountCandidates: after[0].visible })
  }
  console.table(rows)
}, 30000)

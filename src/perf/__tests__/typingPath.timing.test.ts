// Headless timing of the typing path (opt-in: SANOVIDS_TIMING=1 npx vitest run src/perf/__tests__/typingPath.timing.test.ts).
// Skipped in the normal suite: timings depend on the machine. It answers "what does one keystroke cost in store work and
// selector work at 300 / 1000 scenes?" — the part of the in-app stress metric `scene.type` that is the app's own (that
// metric also counted the action's deliberate 40 ms pauses: stress runner, `waited`).
//
// The project is the stress tester's synth (tier M = 300 scenes / 60 characters / 300 takes, XL = 1000 / 200 / 3000), in
// the real stores. What mounted components compute on every project change is emulated with the SAME selector
// functions they use (canvas nodes, take / image tiles, top bar, library, inspector), so the selector cost is real; React
// reconciliation / DOM work is not measured (no DOM here). Two cases:
//  - stress: a random scene is typed into (not selected, not on screen) — store + every selector, no re-render;
//  - node: the selected scene is typed into on its node — plus the field's highlight per key and, per commit, the
//    node's compile / excerpt and the inspector's compiles (the components whose selected values change).
import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import { compileScene } from '../../core/compile'
import { MODELS } from '../../core/models'
import { placeholderGroups } from '../../core/placeholders'
import { runBlock, sceneRunBlockReason } from '../../core/runRules'
import type { Project, Scene } from '../../core/types'
import { generateProject } from '../../devtools/stress/synth'
import { createRng } from '../../devtools/stress/rng'
import { providerLimits } from '../../providers'
import { settingsRunBlock } from '../../providers/limits'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import '../../store/sceneEditor'
import { assetGraphOf, sceneAssetsOf, sceneCountsOf, sceneGraphOf, sceneMapOf, usageOf } from '../../components/canvas/canvasModel'
import { legacyTagsOf } from '../../components/canvas/SceneNodeEditor'
import { promptLinesFor, promptBoxHeight, promptTextWidth, staticExcerpt } from '../../components/canvas/sceneNodeModel'
import { segmentForScene } from '../../components/inspector/tokens'
import { tokenLabelsOf } from '../../components/sidebar/AssetLibrary'
import { appliedPresetId } from '../../components/sidebar/shared'
import { sceneFieldOf } from '../../components/inspector/shared'
import { sceneOptionKeys } from '../../components/inspector/SceneInspector'
import { sceneKeyOf } from '../../components/topbar/TopBar'

const RUN = !!process.env.SANOVIDS_TIMING
const VISIBLE_SCENES = 40
const VISIBLE_TAKES = 40
const VISIBLE_TILES = 12
const INSPECTOR_FIELDS = 14

/** Subscribe `fn` the way zustand runs a component's selector: on every store change, compared with the last value. */
function mount(selectors: (() => unknown)[], eq: (a: unknown, b: unknown) => boolean = Object.is): () => void {
  const last = selectors.map((f) => f())
  return useProject.subscribe(() => {
    for (let i = 0; i < selectors.length; i++) {
      const v = selectors[i]()
      if (!eq(v, last[i])) last[i] = v
    }
  })
}

function load(tier: 'M' | 'XL'): { project: Project; selected: Scene } {
  const g = generateProject(createRng('5a17c0de', 'typing'), '5a17c0de', tier)
  useProject.getState().loadProject(g.project)
  useProject.temporal.getState().clear()
  useRuns.setState({ takes: g.takes })
  return { project: g.project, selected: g.project.scenes[3] }
}

const GROUPS = ['canvas', 'sceneNodes', 'takeNodes', 'tiles', 'topBar', 'library', 'inspector'] as const
type Group = (typeof GROUPS)[number]

/** The selectors of the mounted UI with one scene selected (canvas shown, inspector and library open); `only`: one group. */
function mountUi(selectedId: string, only?: Group): () => void {
  const st = () => useProject.getState().project
  const offs: (() => void)[] = []
  const on = (g: Group) => !only || only === g
  const visible = st().scenes.slice(0, VISIBLE_SCENES)
  // canvas: CanvasView + CanvasToolbar
  if (on('canvas')) offs.push(mount([() => sceneGraphOf(st().scenes), () => sceneGraphOf(st().scenes), () => assetGraphOf(st().assets)]))
  // scene nodes on screen: their scene, their compile inputs (useShallow), their preset name
  if (on('sceneNodes')) {
    for (const s of visible) {
      offs.push(mount([() => sceneMapOf(st().scenes).get(s.id)]))
      offs.push(mount([() => sceneAssetsOf(st().assets, s)], shallow))
      offs.push(mount([() => {
        const id = appliedPresetId(s.presetId, s.settings, st().presets)
        return id ? (st().presets.find((p) => p.id === id)?.name ?? null) : null
      }]))
    }
  }
  // take nodes and image tiles on screen
  const takes = useRuns.getState().takes.slice(0, VISIBLE_TAKES)
  if (on('takeNodes')) for (const t of takes) offs.push(mount([() => sceneMapOf(st().scenes).get(t.sceneId)?.order]))
  if (on('tiles')) for (const a of st().assets.slice(0, VISIBLE_TILES)) offs.push(mount([() => usageOf(st().scenes).get(a.id) ?? 0]))
  // top bar ("Phát liền" + .zip count)
  if (on('topBar')) offs.push(mount([() => sceneKeyOf(st().scenes), () => sceneKeyOf(st().scenes)]))
  // library: usage badges (useShallow), @image labels of the single selected scene
  if (on('library')) {
    offs.push(mount([() => sceneCountsOf(st().scenes)], shallow))
    offs.push(mount([() => {
      const sc = sceneMapOf(st().scenes).get(selectedId)
      return sc ? tokenLabelsOf(st().assets, sc.refs) : {}
    }], shallow))
  }
  // inspector: scene options (useShallow), the per-field subscriptions, the run gate (one string)
  if (on('inspector')) {
    offs.push(mount([() => sceneOptionKeys(st().scenes)], shallow))
    for (let i = 0; i < INSPECTOR_FIELDS; i++) offs.push(mount([() => sceneFieldOf(st().scenes, selectedId, (x) => x.prompt)]))
    const limits = providerLimits('dev')
    offs.push(mount([() => {
      const sc = sceneFieldOf(st().scenes, selectedId, (x) => x)
      return sc ? sceneRunBlockReason(st().assets, sc, settingsRunBlock(limits, sc.settings)) : null
    }]))
  }
  return () => offs.forEach((off) => off())
}

/** The node's render work for its scene (SceneFull): compile inputs, compile, run rule, strip check, excerpt marks. */
function nodeRender(scene: Scene): void {
  const assets = sceneAssetsOf(useProject.getState().project.assets, scene)
  const compiled = compileScene({ ...useProject.getState().project, assets, scenes: [scene] }, scene)
  runBlock({ scene, assets, compiled, settingsBlock: null, spec: MODELS[scene.settings.model] })
  if (compiled.unsentTokens.some((t) => t.includes('?') || t.endsWith(')'))) placeholderGroups(scene.prompt, assets, scene.refs)
  const lines = promptLinesFor(promptBoxHeight(304, {}))
  segmentForScene(staticExcerpt(scene.prompt, lines, promptTextWidth(352)), assets, scene.refs, { sentImages: compiled.images.length, legacyTags: legacyTagsOf(assets) })
}

/** The inspector's render work for the selected scene's prompt: the final prompt preview and the placeholder bar. */
function inspectorRender(scene: Scene): void {
  const p = useProject.getState().project
  compileScene({ ...p, scenes: [scene] }, scene)
  if (scene.prompt.includes('@')) placeholderGroups(scene.prompt, p.assets, scene.refs)
}

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) }
}

const KEYS = 400
const pick = (i: number, n: number) => (i * 7919) % n

/** setScenePrompt on spread-out scenes, `KEYS` times: ms per call. */
function typeRandom(): number[] {
  const out: number[] = []
  const n = useProject.getState().project.scenes.length
  for (let i = 0; i < KEYS; i++) {
    const s = useProject.getState().project.scenes[pick(i, n)]
    const t0 = performance.now()
    useProject.getState().setScenePrompt(s.id, s.prompt + (i % 9 === 8 ? ' ' : 'a'))
    out.push(performance.now() - t0)
  }
  return out
}

/** The selected scene typed on its node (a prompt of `chars` characters): field highlight per key, commit, re-renders. */
function typeOnNode(id: string, chars: number): { field: number[]; commit: number[] } {
  const scene = sceneMapOf(useProject.getState().project.scenes).get(id)!
  const head = scene.refs.length ? '@image_1 ' : ''
  const body = 'Ánh nắng xuyên qua rừng, nhân vật bước chậm về phía máy quay. Góc rộng điện ảnh. '
  useProject.getState().setScenePrompt(id, (head + body.repeat(Math.ceil(chars / body.length))).slice(0, chars))
  const field: number[] = []
  const commit: number[] = []
  for (let i = 0; i < KEYS / 2; i++) {
    const cur = sceneMapOf(useProject.getState().project.scenes).get(id)!
    const text = cur.prompt + (i % 9 === 8 ? ' ' : 'b')
    const assets = sceneAssetsOf(useProject.getState().project.assets, cur)
    const t0 = performance.now()
    segmentForScene(text, assets, cur.refs, { sentImages: Math.min(cur.refs.length, 9), legacyTags: legacyTagsOf(assets) })
    const t1 = performance.now()
    useProject.getState().setScenePrompt(id, text)
    const next = sceneMapOf(useProject.getState().project.scenes).get(id)!
    nodeRender(next)
    inspectorRender(next)
    const t2 = performance.now()
    field.push(t1 - t0)
    commit.push(t2 - t1)
  }
  return { field, commit }
}

describe.skipIf(!RUN)('typing path timing (opt-in)', () => {
  for (const tier of ['M', 'XL'] as const) {
    it(`tier ${tier}: one keystroke`, () => {
      const { selected } = load(tier)
      typeRandom() // warm-up (JIT, caches)
      const storeOnly = typeRandom()
      // what each mounted group adds per keystroke (mean ms over the store alone)
      const base = stats(storeOnly).mean
      const groups: Record<string, number> = {}
      for (const g of GROUPS) {
        const offG = mountUi(selected.id, g)
        groups[g] = +(stats(typeRandom()).mean - base).toFixed(3)
        offG()
      }
      const off = mountUi(selected.id)
      const withUi = typeRandom()
      const long = typeOnNode(selected.id, 6000)
      const huge = typeOnNode(selected.id, 20000)
      off()
      const out = {
        tier,
        scenes: useProject.getState().project.scenes.length,
        storeOnly: stats(storeOnly),
        selectorsByGroup: groups,
        storeAndSelectors: stats(withUi),
        node6k: { fieldKey: stats(long.field), commit: stats(long.commit) },
        node20k: { fieldKey: stats(huge.field), commit: stats(huge.commit) },
      }
      console.log(JSON.stringify(out))
      expect(out.storeOnly.n).toBe(KEYS)
    }, 120_000)
  }
})

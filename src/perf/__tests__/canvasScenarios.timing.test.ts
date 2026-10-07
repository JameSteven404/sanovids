// Always-on CI ceilings for pure/store work. No React mount, DOM, paint, browser, gateway or persistence.
import { afterEach, describe, expect, it } from 'vitest'
import { lodOf, sceneAssetsOf, sceneGraphOf, sceneMapOf } from '../../components/canvas/canvasModel'
import { farExcerpt, promptBoxHeight, promptLinesFor, promptTextWidth, settingsSummary, staticExcerpt } from '../../components/canvas/sceneNodeModel'
import { segmentForScene } from '../../components/inspector/tokens'
import { libraryClick } from '../../components/sidebar/librarySelection'
import { compileScene } from '../../core/compile'
import { planLibraryDelete } from '../../core/libraryDelete'
import { MODELS } from '../../core/models'
import { parsePlaceholders } from '../../core/placeholders'
import { useCanvasPrefs } from '../../lib/canvasPrefs'
import { register } from '../../lib/promptDrafts'
import { clearHistory, undo, useProject } from '../../store/project'
import { useSceneEditor } from '../../store/sceneEditor'
import { useUI } from '../../store/ui'
import { HEADLESS_BUDGETS } from '../budgets'
import { stats } from '../report'
import { libraryFixture, SIZES, synthProject } from '../synth'

const originalProject = useProject.getState().project
const originalUI = useUI.getState(), originalPrefs = useCanvasPrefs.getState()
afterEach(() => {
  const editor = useSceneEditor.getState()
  editor.close(); editor.closePanel(); editor.closeSettings()
  useProject.setState({ project: originalProject }); clearHistory()
  useUI.setState(originalUI); useCanvasPrefs.setState(originalPrefs)
})

describe('canvas scenario pure/store timing (CI, no GUI)', () => {
  for (const tier of ['M', 'XL', 'XXL'] as const) {
    it(`${SIZES[tier].scenes} scenes: typing, editor, settings, LOD, library and wire undo`, () => {
      const { project } = synthProject(SIZES[tier])
      useProject.getState().loadProject(project); clearHistory()
      useCanvasPrefs.setState({ nodeEditor: 'click' })
      useUI.setState({ view: 'canvas', selectedIds: [] })
      // Last scene also exercises the store's linear id lookup at each project size.
      const target = project.scenes.at(-1)!
      const current = () => sceneMapOf(useProject.getState().project.scenes).get(target.id)!
      const results: Record<string, ReturnType<typeof stats>> = {}
      const timed = (id: keyof typeof HEADLESS_BUDGETS, action: () => void, prepare = () => {}, verify = () => {}) => {
        const samples: number[] = []
        for (let i = -3; i < 25; i++) {
          prepare()
          const start = performance.now()
          action()
          const elapsed = performance.now() - start
          verify() // Assertions and setup are outside the measured slice.
          if (i >= 0) samples.push(elapsed)
        }
        results[id] = stats(samples)
        expect(results[id]!.p95, `${tier}/${id}: pure/store p95 ms`).toBeLessThanOrEqual(HEADLESS_BUDGETS[id])
      }

      let graph = sceneGraphOf(project.scenes)
      let draft = target.prompt
      timed('typeNode', () => {
        draft += 'a'
        const scene = current(), assets = sceneAssetsOf(project.assets, scene)
        segmentForScene(draft, assets, scene.refs, { sentImages: scene.refs.length })
        useProject.getState().setScenePrompt(target.id, draft)
        graph = sceneGraphOf(useProject.getState().project.scenes)
        compileScene({ ...project, scenes: [current()] }, current())
      }, undefined, () => {
        expect(current().prompt).toBe(draft)
        expect(graph).toBe(sceneGraphOf(project.scenes))
      })

      let opened = false
      timed('editor', () => {
        useSceneEditor.getState().open(target.id, null)
        opened = useSceneEditor.getState().sceneId === target.id
        useSceneEditor.getState().close()
      }, undefined, () => {
        expect(opened).toBe(true)
        expect(useSceneEditor.getState().sceneId).toBeNull()
        expect(useUI.getState().selectedIds).toEqual([target.id])
      })
      // Closing a live editor must flush its pending draft, even without a DOM in this test.
      useSceneEditor.getState().open(target.id, null)
      const unregister = register(target.id, () => useProject.getState().setScenePrompt(target.id, draft + ' bản nháp'))
      try { useSceneEditor.getState().close(); expect(current().prompt).toBe(draft + ' bản nháp') }
      finally { unregister() }

      let summary = '', height = 0
      timed('expandSettings', () => {
        useSceneEditor.getState().openSettings(target.id)
        const settings = current().settings, model = MODELS[settings.model]
        summary = settingsSummary(settings, model.short, model.modes.length, null)
        height = promptBoxHeight(304, { settingsOpen: true })
      }, () => useSceneEditor.getState().closeSettings(), () => {
        expect(useSceneEditor.getState().settingsSceneId).toBe(target.id)
        expect(summary).toContain(MODELS[target.settings.model].short)
        expect(height).toBeLessThan(promptBoxHeight(304))
      })
      useSceneEditor.getState().closeSettings()

      const visible = project.scenes.slice(0, 40)
      expect([0.54, 0.55, 0.56].map(lodOf)).toEqual(['far', 'near', 'near'])
      let excerpts: string[] = []
      timed('lodSwitch', () => {
        excerpts = [0.54, 0.55, 0.56].flatMap((zoom) => visible.map((scene) => {
          const text = lodOf(zoom) === 'far' ? farExcerpt(scene.prompt, 352)
            : staticExcerpt(scene.prompt, promptLinesFor(promptBoxHeight(304)), promptTextWidth(352))
          if (lodOf(zoom) === 'near') segmentForScene(text, sceneAssetsOf(project.assets, scene), scene.refs)
          return text
        }))
      }, undefined, () => { expect(excerpts).toHaveLength(120); expect(excerpts.every((s) => s.length > 0 && s.length < 2000)).toBe(true) })

      const fixture = libraryFixture(useProject.getState().project)
      const ids = fixture.assets.slice(-200).map((a) => a.id), visibleIds = fixture.assets.map((a) => a.id)
      let selection: string[] = []
      timed('librarySelect200', () => {
        const first = libraryClick([], visibleIds, null, ids[0], { ctrlKey: false, metaKey: false, shiftKey: false })
        selection = libraryClick(first.selection, visibleIds, first.anchor, ids[199], { ctrlKey: false, metaKey: false, shiftKey: true }).selection
      }, undefined, () => expect(selection).toEqual(ids))
      timed('libraryDelete200', () => {
        const plan = planLibraryDelete(useProject.getState().project, selection, visibleIds)
        useProject.getState().removeAssets(plan.ids)
      }, () => { useProject.setState({ project: fixture }); clearHistory() }, () => {
        expect(useProject.getState().project.assets).toEqual(project.assets)
        expect(useProject.getState().project.scenes).toEqual(fixture.scenes)
        expect(useProject.temporal.getState().pastStates).toHaveLength(1)
        undo(); expect(useProject.getState().project.assets).toEqual(fixture.assets)
      })

      const before = current(), label = project.assets.find((a) => a.id === before.refs[0])!.name
      const cut = () => useProject.getState().removeRef(target.id, before.refs[0])
      const restored = () => { expect(current().prompt).toBe(before.prompt); expect(current().refs).toEqual(before.refs) }
      timed('cutWire', cut, clearHistory, () => {
        expect(parsePlaceholders(current().prompt)).toEqual(expect.arrayContaining([expect.objectContaining({ label })]))
        expect(current().refs).not.toContain(before.refs[0])
        expect(useProject.temporal.getState().pastStates).toHaveLength(1)
        undo(); restored()
      })
      timed('undoWire', () => { undo() }, () => { clearHistory(); cut() }, restored)
      console.log(JSON.stringify({ tier, scenes: SIZES[tier].scenes, scope: 'pure/store only', results }))
    }, 30000)
  }
})

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const canvas = new URL('../', import.meta.url)
const broadSelector = /use(?:Project|Runs)\(\s*(?:useShallow\(\s*)?(?:\(\s*(\w+)\s*\)|(\w+))\s*=>\s*(?:\{\s*return\s+)?(?:\1|\2)\.(?:project\.(?:scenes|assets|settings)|takes)\s*[;})]/g
describe('canvas subscription boundaries', () => {
  it('rejects raw scene/asset/take array subscriptions in every node component', () => {
    for (const file of readdirSync(canvas).filter((f) => /Node.*\.tsx$/.test(f))) {
      const source = readFileSync(new URL(file, canvas), 'utf8')
      expect(source.match(broadSelector), file).toBeNull()
    }
    expect('useProject((s) => s.project.scenes)'.match(broadSelector)).toHaveLength(1)
    expect('useRuns(s => s.takes)'.match(broadSelector)).toHaveLength(1)
    expect('useProject((s) => { return s.project.assets })'.match(broadSelector)).toHaveLength(1)
    expect('useProject(useShallow((s) => s.project.scenes))'.match(broadSelector)).toHaveLength(1)
    expect('useProject((s) => sceneMapOf(s.project.scenes).get(id))'.match(broadSelector)).toBeNull()
  })

  it('keeps the heavy editor out of scene cards and graph/hover work separate', () => {
    const scene = readFileSync(new URL('SceneNode.tsx', canvas), 'utf8')
    expect(scene).not.toMatch(/import[^\n]*(?:PromptEditor|SettingsFields)/)
    expect(scene).toContain('useProject(useShallow((s) => sceneAssetsOf(s.project.assets, scene)))')
    const view = readFileSync(new URL('CanvasView.tsx', canvas), 'utf8')
    expect(view).toContain('sceneGraphOf(s.project.scenes)')
    expect(view).toContain('assetGraphOf(s.project.assets)')
    const edgesMemo = view.slice(view.indexOf('const edges = useMemo'), view.indexOf('// Wire selection must'))
    expect(edgesMemo).not.toMatch(/hoveredId|hoveredEdgeId/)
    const baseMemo = view.slice(view.indexOf('const baseNodes = useMemo'), view.indexOf('const liveCache'))
    expect(baseMemo).not.toMatch(/dragPos|measuredVersion|selectedIds|resizing\[/)
  })
})

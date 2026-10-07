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

  it('the node is the editor: static text everywhere, ONE live field (the editing node), never the old .cv-m marks', () => {
    const scene = readFileSync(new URL('SceneNode.tsx', canvas), 'utf8')
    // the live field is mounted only behind `live` (= this node is the one being edited, not open in the panel)
    expect(scene).toMatch(/const live = editing && !inPanel/)
    expect(scene).toMatch(/\{live \? \(\s*<NodePromptField /)
    expect(scene.match(/<NodePromptField /g)).toHaveLength(1)
    // static text and the field's backdrop render tokens ONLY through the shared helper (tokens.ts segmentForScene:
    // red placeholders, labels that do not fit, missing / unsent numbers, retired @video text) and .in-tk marks
    expect(scene).toMatch(/segmentForScene\(excerpt, assets, scene\.refs, \{ sentImages/)
    expect(scene).not.toMatch(/segmentPrompt\(/)
    expect(scene).not.toMatch(/cv-m\b/)
    expect(scene).not.toMatch(/new RegExp|\/@\(\?:image/)
    const field = readFileSync(new URL('SceneNodeEditor.tsx', canvas), 'utf8')
    expect(field).toMatch(/className="cv-sn-ta nodrag nowheel nokey/)
    expect(field).toMatch(/className=\{`in-tk is-\$\{s\.kind\}/)
    expect(field).toMatch(/segmentForScene\(text, assets, scene\.refs, \{ sentImages/)
    expect(field).not.toMatch(/segmentPrompt\(/)
    expect(field).not.toMatch(/import[^\n]*\bPromptEditor\b/)
  })

  it('the shortcuts help names the node-editor keys and never offers a video as a reference', () => {
    const help = readFileSync(new URL('../dialogs/ShortcutsDialog.tsx', canvas), 'utf8')
    expect(help).toContain("['Enter', 'Gõ prompt ngay trên node của cảnh đang chọn (khi chỉ chọn một cảnh)']")
    expect(help).toContain("['Esc', 'Đang gõ trên node: thôi gõ, cảnh vẫn được chọn']")
    expect(help).toContain('đang gõ trên node: chỉ cảnh đó')
    expect(help).not.toContain('nhân vật / video đang chọn')
  })

  it('the red placeholder strip is the panel\'s PlaceholderBar (variant node), mounted only when the compile found such a token', () => {
    const scene = readFileSync(new URL('SceneNode.tsx', canvas), 'utf8')
    expect(scene).toContain('<PlaceholderBar sceneId={scene.id} variant="node" />')
    expect(scene).toMatch(/compiled\.unsentTokens\.some\(\(t\) => t\.includes\('\?'\) \|\| t\.endsWith\('\)'\)\) && placeholderGroups\(/)
    expect(scene).not.toContain('cv-sn-hole')
    // no video-reference UI on the node (reference videos were retired in 0.6.0)
    expect(scene).not.toMatch(/làm @video|videoRefs|refDot|useGatewayRefVideoCap|refStatusLookup|takeStatus/)
  })

  it('the far view lays out a bounded excerpt (never a whole paragraph per far node)', () => {
    const scene = readFileSync(new URL('SceneNode.tsx', canvas), 'utf8')
    const far = scene.slice(scene.indexOf('function SceneFar('), scene.indexOf('function SceneFull('))
    expect(far).toMatch(/farExcerpt\(scene\.prompt, w\)/)
    expect(far).not.toMatch(/scene\.prompt\.trim\(\)\.split/)
  })

  it('a click that jittered within the drag threshold is still a click (React Flow nodeClickDistance = nodeDragThreshold)', () => {
    const view = readFileSync(new URL('CanvasView.tsx', canvas), 'utf8')
    const drag = /nodeDragThreshold=\{(\d+)\}/.exec(view)?.[1]
    expect(drag).toBeDefined()
    expect(view).toContain(`nodeClickDistance={${drag}}`)
  })

  it('"Gõ trên node" brings the node near first (typeOnNode), never opens a field that cannot mount', () => {
    const inspector = readFileSync(new URL('../inspector/SceneInspector.tsx', canvas), 'utf8')
    expect(inspector).toContain('onClick={() => typeOnNode(sceneId)}')
    expect(inspector).not.toContain('useSceneEditor.getState().open(sceneId)')
    const view = readFileSync(new URL('CanvasView.tsx', canvas), 'utf8')
    expect(view).toContain("listen(TYPE_EVENT, 'type'")
  })
})

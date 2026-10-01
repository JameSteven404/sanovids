import { beforeEach, describe, expect, it } from 'vitest'
import type { Project, Scene } from '../../../core/types'
import { useProject } from '../../../store/project'
import { checkTag, countMentions, matchesQuery, nextAssetPosition, norm, renameAssetTag, undoToastAction } from '../shared'

const scene = (id: string, prompt: string): Scene => ({
  id, order: 1, title: '', prompt, refs: [], blockOverrides: {}, presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  continueFrom: null, firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '',
})

const project = (): Project => ({
  id: 'p', name: 'P', schemaVersion: 1, createdAt: 0, updatedAt: 0, presets: [],
  settings: { referencesTemplate: '{list}', autoReferences: true, autoContinuity: true },
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: [], color: '#fff', position: { x: 40, y: 60 } },
    { id: 'b', kind: 'character', name: 'Bé An', tag: 'BeAn', description: '', imageIds: [], color: '#fff', position: null },
  ],
  blocks: [{ id: 'k', title: 'Cont', text: 'one @elara only, @Elaraa is someone else', placement: 'after', defaultOn: true, color: '#fff' }],
  scenes: [scene('s1', '@Elara meets @BeAn. @Elara smiles.'), scene('s2', 'no mention'), scene('s3', "@Elara's cloak")],
})

describe('sidebar search', () => {
  it('ignores Vietnamese diacritics and case', () => {
    expect(norm('Làng Núi Đá')).toBe('lang nui da')
    expect(matchesQuery('lang nui', 'Làng núi', 'LangNui')).toBe(true)
    expect(matchesQuery('@elara', 'Elara')).toBe(true)
    expect(matchesQuery('cave blue', 'Hang động', 'narrow cave with blue crystal light')).toBe(true)
    expect(matchesQuery('dragon', 'Elara')).toBe(false)
    expect(matchesQuery('  ', 'x')).toBe(true)
  })
})

describe('tag validation + rename', () => {
  beforeEach(() => {
    useProject.getState().loadProject(project())
    useProject.temporal.getState().clear()
  })

  it('rejects tags used by another asset (case-insensitive) and slugifies', () => {
    const p = useProject.getState().project
    expect(checkTag(p, 'a', 'bean').error).toBeTruthy()
    expect(checkTag(p, 'a', '').error).toBeTruthy()
    expect(checkTag(p, 'a', 'image_3').error).toBeTruthy()
    expect(checkTag(p, 'a', '@Elara')).toMatchObject({ error: null, changed: false })
    expect(checkTag(p, 'a', 'Ê la ra')).toMatchObject({ tag: 'ELaRa', error: null, changed: true })
  })

  it('renames the tag and rewrites mentions in prompts and blocks as one undo step', () => {
    expect(countMentions(useProject.getState().project, 'Elara')).toBe(3)
    const res = renameAssetTag('a', 'Lyra')
    expect(res).toMatchObject({ ok: true, tag: 'Lyra', rewritten: 3 })
    const p = useProject.getState().project
    expect(p.assets[0].tag).toBe('Lyra')
    expect(p.scenes[0].prompt).toBe('@Lyra meets @BeAn. @Lyra smiles.')
    expect(p.scenes[2].prompt).toBe("@Lyra's cloak")
    expect(p.blocks[0].text).toBe('one @Lyra only, @Elaraa is someone else')
    expect(useProject.temporal.getState().pastStates.length).toBe(1)
    useProject.temporal.getState().undo()
    expect(useProject.getState().project.assets[0].tag).toBe('Elara')
    expect(useProject.getState().project.scenes[0].prompt).toBe('@Elara meets @BeAn. @Elara smiles.')
  })

  it('refuses a conflicting rename without touching the project', () => {
    const before = useProject.getState().project
    const res = renameAssetTag('a', 'BeAn')
    expect(res.ok).toBe(false)
    expect(useProject.getState().project).toBe(before)
  })

  it('places new canvas assets under the existing asset column', () => {
    expect(nextAssetPosition(useProject.getState().project)).toEqual({ x: 40, y: 60 + 210 + 28 })
  })
})

describe('undo toast action', () => {
  beforeEach(() => {
    useProject.getState().loadProject(project())
    useProject.temporal.getState().clear()
  })
  const refsOf = (id: string) => useProject.getState().project.scenes.find((s) => s.id === id)!.refs

  it('undoes its own edit while it is the latest change', () => {
    useProject.getState().updateScene('s2', { refs: ['a', 'b'] })
    useProject.getState().removeRef('s2', 'a')
    const action = undoToastAction()
    action.run()
    expect(refsOf('s2')).toEqual(['a', 'b'])
  })

  it('does not revert a newer edit made after the toast', () => {
    useProject.getState().updateScene('s2', { refs: ['a', 'b'] })
    useProject.getState().removeRef('s2', 'a')
    const action = undoToastAction()
    useProject.getState().updateScene('s1', { refs: ['b'] })
    action.run()
    expect(refsOf('s1')).toEqual(['b'])
    expect(refsOf('s2')).toEqual(['b'])
  })

  it('still works after undo + redo of that edit', () => {
    useProject.getState().removeRef('s1', 'a')
    const action = undoToastAction()
    useProject.temporal.getState().undo()
    useProject.temporal.getState().redo()
    action.run()
    expect(useProject.temporal.getState().pastStates.length).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { dropFolderLinks, folderBaseName, folderMapOf, foldersForCopy, folderTargetsFor, isLinked, normalizeFolders, shortPath, withLink } from '../folders'
import { migrateProject, migrateTake } from '../migrate'
import type { SaveFolder } from '../types'

const folder = (over: Partial<SaveFolder> = {}): SaveFolder => ({ id: 'f1', name: 'Phim', path: 'C:\\Videos\\Phim', position: { x: 0, y: 0 }, mode: 'copy', ...over })

describe('folder nodes in saved / imported projects', () => {
  it('repairs what other sources may leave out', () => {
    const out = normalizeFolders([
      { id: 'f1', name: '  Phim A ', path: 'C:\\Videos\\Phim A', position: { x: 10, y: 20 }, autoScenes: ['s1', 's1', 7, 'gone'], takes: ['t1', 't1', ''] },
      { path: '/home/me/Out/' },
      null,
      'nope',
      { id: 'f1', name: 'dup' },
    ], new Set(), new Set(['s1']))
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ id: 'f1', name: 'Phim A', path: 'C:\\Videos\\Phim A', position: { x: 10, y: 20 }, mode: 'copy', autoScenes: ['s1'], takes: ['t1'] })
    // name from the path; a default position; no empty link lists
    expect(out[1]).toMatchObject({ name: 'Out', path: '/home/me/Out/', mode: 'copy' })
    expect(out[1].position).toEqual({ x: expect.any(Number), y: expect.any(Number) })
    expect(out[1]).not.toHaveProperty('autoScenes')
    expect(out[1]).not.toHaveProperty('takes')
    // duplicate id → a fresh one
    expect(out[2].id).not.toBe('f1')
    expect(out[2].path).toBeNull()
  })

  it('never reuses the id of another node (React Flow ids must be unique)', () => {
    const [f] = normalizeFolders([{ id: 'scn_1', name: 'x' }], new Set(['scn_1']))
    expect(f.id).not.toBe('scn_1')
  })

  it('refuses odd paths and invalid input', () => {
    expect(normalizeFolders('x')).toEqual([])
    const [f] = normalizeFolders([{ name: 'x', path: 'a\u0000b' }])
    expect(f.path).toBeNull()
    expect(normalizeFolders([{ name: 'x', path: 'C:\\' + 'a'.repeat(2000) }])[0].path).toBeNull()
  })

  it('migrateProject keeps folders, drops links to deleted scenes, and adds nothing to projects without folders', () => {
    const p = migrateProject({
      schemaVersion: 2,
      name: 'P',
      assets: [],
      presets: [],
      scenes: [{ id: 's1', order: 1, title: '', prompt: '', refs: [], videoRefs: [], settings: {}, position: { x: 0, y: 0 } }],
      folders: [{ id: 'f1', name: 'Out', path: '/out', position: { x: 1, y: 2 }, autoScenes: ['s1', 's9'] }],
    })
    expect(p.folders).toEqual([{ id: 'f1', name: 'Out', path: '/out', position: { x: 1, y: 2 }, mode: 'copy', autoScenes: ['s1'] }])
    expect(migrateProject(p)).toEqual(p)
    const plain = migrateProject({ schemaVersion: 2, name: 'P', assets: [], presets: [], scenes: [] })
    expect(plain).not.toHaveProperty('folders')
    expect(migrateProject({ ...plain, folders: [] })).not.toHaveProperty('folders')
  })
})

describe('take file names in saved data', () => {
  it('keeps a valid name, sanitizes a bad one, drops an empty one', () => {
    const base = { id: 't', sceneId: 's', number: 1, status: 'completed' }
    expect(migrateTake({ ...base, fileName: 'Cảnh mở đầu' }).fileName).toBe('Cảnh mở đầu')
    expect(migrateTake({ ...base, fileName: '../x/y.mp4' }).fileName).toBe('-x-y')
    expect(migrateTake({ ...base, fileName: '   ' })).not.toHaveProperty('fileName')
    expect(migrateTake({ ...base, fileName: 5 })).not.toHaveProperty('fileName')
    expect(migrateTake(base)).not.toHaveProperty('fileName')
  })
})

describe('wires into a folder', () => {
  it('adds / removes a link without duplicates; unchanged object when nothing changes', () => {
    const f = folder()
    const a = withLink(f, 'autosave', 's1', true)
    expect(a.autoScenes).toEqual(['s1'])
    expect(withLink(a, 'autosave', 's1', true)).toBe(a)
    expect(isLinked(a, 'autosave', 's1')).toBe(true)
    expect(isLinked(a, 'save', 's1')).toBe(false)
    const b = withLink(a, 'save', 't1', true)
    expect(b.takes).toEqual(['t1'])
    const c = withLink(withLink(b, 'save', 't1', false), 'autosave', 's1', false)
    expect(c).not.toHaveProperty('takes')
    expect(c).not.toHaveProperty('autoScenes')
    expect(withLink(f, 'save', 'tX', false)).toBe(f)
  })

  it('a finished take goes to the folders its scene or itself is wired into, each once', () => {
    const fs = [folder({ id: 'a', autoScenes: ['s1'] }), folder({ id: 'b', takes: ['t1'] }), folder({ id: 'c', autoScenes: ['s1'], takes: ['t1'] }), folder({ id: 'd' })]
    expect(folderTargetsFor(fs, { id: 't1', sceneId: 's1' }).map((f) => f.id)).toEqual(['a', 'b', 'c'])
    expect(folderTargetsFor(fs, { id: 't2', sceneId: 's1' }).map((f) => f.id)).toEqual(['a', 'c'])
    expect(folderTargetsFor(fs, { id: 't3', sceneId: 's2' })).toEqual([])
    expect(folderTargetsFor(undefined, { id: 't1', sceneId: 's1' })).toEqual([])
  })

  it('forgets links to deleted takes / scenes (same array when nothing changes)', () => {
    const fs = [folder({ id: 'a', takes: ['t1', 't2'], autoScenes: ['s1'] }), folder({ id: 'b', takes: ['t1'] }), folder({ id: 'c', autoScenes: ['s2'] })]
    const out = dropFolderLinks(fs, { takes: new Set(['t1']) })!
    expect(out[0].takes).toEqual(['t2'])
    expect(out[0].autoScenes).toEqual(['s1'])
    expect(out[1]).not.toHaveProperty('takes')
    expect(out[2]).toBe(fs[2])
    const noScenes = dropFolderLinks(fs, { scenes: new Set(['s1', 's2']) })!
    expect(noScenes[0]).not.toHaveProperty('autoScenes')
    expect(noScenes[2]).not.toHaveProperty('autoScenes')
    expect(dropFolderLinks(fs, { takes: new Set(['t9']), scenes: new Set(['s9']) })).toBe(fs)
    expect(dropFolderLinks(fs, {})).toBe(fs)
    expect(dropFolderLinks(undefined, { takes: new Set(['t1']) })).toBeUndefined()
  })

  it('a copied project gets new folder ids and no take links; a file from elsewhere also no path', () => {
    const fs = [folder({ id: 'f1', takes: ['t1'], autoScenes: ['s1'] }), folder({ id: 'f2', path: null })]
    const dup = foldersForCopy(fs, { keepPath: true, taken: new Set(['s1']) })
    expect(dup.folders).toHaveLength(2)
    expect(dup.folders![0].id).not.toBe('f1')
    expect(dup.folders![0]).toMatchObject({ name: 'Phim', path: 'C:\\Videos\\Phim', autoScenes: ['s1'] })
    expect(dup.folders![0]).not.toHaveProperty('takes')
    expect(new Set(dup.folders!.map((f) => f.id)).size).toBe(2)
    expect([...dup.ids]).toEqual([
      ['f1', dup.folders![0].id],
      ['f2', dup.folders![1].id],
    ])
    const imported = foldersForCopy(fs, { keepPath: false })
    expect(imported.folders!.every((f) => f.path === null)).toBe(true)
    expect(fs[0].path).toBe('C:\\Videos\\Phim') // the original is not touched
    expect(foldersForCopy(undefined, { keepPath: true })).toEqual({ folders: undefined, ids: new Map() })
  })

  it('a long link list keeps its most recent links', () => {
    const takes = Array.from({ length: 1005 }, (_, i) => `t${i}`)
    const [f] = normalizeFolders([{ id: 'f1', name: 'x', takes }])
    expect(f.takes).toHaveLength(1000)
    expect(f.takes![0]).toBe('t5')
    expect(f.takes![999]).toBe('t1004')
  })

  it('looks folders up by id (cached per array)', () => {
    const fs = [folder({ id: 'a' })]
    expect(folderMapOf(fs).get('a')?.name).toBe('Phim')
    expect(folderMapOf(fs)).toBe(folderMapOf(fs))
    expect(folderMapOf(undefined).size).toBe(0)
  })
})

describe('folder labels', () => {
  it('shows the folder name and a short path', () => {
    expect(folderBaseName('C:\\Users\\me\\Videos\\Phim A')).toBe('Phim A')
    expect(folderBaseName('/home/me/out/')).toBe('out')
    expect(shortPath('C:\\Users\\me\\Videos\\Phim A')).toBe('…\\Videos\\Phim A')
    expect(shortPath('/home/me/videos/out')).toBe('…/videos/out')
    expect(shortPath('/home/me/out')).toBe('/home/me/out')
    expect(shortPath('D:\\Phim')).toBe('D:\\Phim')
  })
})

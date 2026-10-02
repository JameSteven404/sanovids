// A .sanovids.json shared with someone else: folder nodes never carry where a folder is on this computer, and a file
// from elsewhere never chooses where this computer writes.
import { describe, expect, it } from 'vitest'
import type { Project, Scene } from '../../core/types'
import { importedProject, projectForExport } from '../persist'

const scene = (id: string, order: number): Scene => ({
  id,
  order,
  title: '',
  prompt: 'x',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
})

const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 1,
  updatedAt: 1,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes: [scene('s1', 1)],
  folders: [
    { id: 'f1', name: 'Phim A', path: 'C:\\Users\\minh\\Videos\\Phim A', position: { x: 0, y: 0 }, mode: 'copy', autoScenes: ['s1'], takes: ['t1'] },
  ],
})

describe('export / import of a project file', () => {
  it('the exported project has no folder path (no account name, no folder layout) and no take links', () => {
    const p = project()
    const out = projectForExport(p)
    expect(out.folders).toEqual([{ id: 'f1', name: 'Phim A', path: null, position: { x: 0, y: 0 }, mode: 'copy', autoScenes: ['s1'] }])
    expect(JSON.stringify(out)).not.toContain('Users')
    // the open project is not changed
    expect(p.folders![0].path).toBe('C:\\Users\\minh\\Videos\\Phim A')
    const plain = { ...p, folders: undefined }
    expect(projectForExport(plain)).toBe(plain)
  })

  it('an imported folder node has a new id and no path, even when the file names one', () => {
    const imported = importedProject(project(), {})
    expect(imported.id).not.toBe('p')
    expect(imported.folders).toHaveLength(1)
    const [f] = imported.folders!
    expect(f.id).not.toBe('f1')
    expect(f.path).toBeNull()
    expect(f.name).toBe('Phim A')
    expect(f.autoScenes).toEqual(['s1'])
    expect(f).not.toHaveProperty('takes')
    // a project without folder nodes stays without the key
    expect(importedProject({ ...project(), folders: undefined }, {})).not.toHaveProperty('folders')
  })
})

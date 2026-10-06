// A .sanovids.json shared with someone else: folder nodes never carry where a folder is on this computer, and a file
// from elsewhere never chooses where this computer writes.
import { describe, expect, it } from 'vitest'
import type { Project, Scene } from '../../core/types'
import { importedProject, importWarning, NEWER_FILE_WARNING, projectForExport } from '../persist'

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

describe('importing a file of a newer SanoVids build', () => {
  const VEO = { model: 'seedvis/veo_3.1', mode: 'r2v', duration: 8, resolution: '1080p', ratio: '9:16' }

  it('warns (never refuses) for a file version above 2', () => {
    const raw = project()
    expect(importWarning({ version: 3, project: raw }, importedProject(raw, {}))).toBe(NEWER_FILE_WARNING)
    expect(NEWER_FILE_WARNING).toBe('File này tạo bằng SanoVids mới hơn: cảnh dùng model lạ sẽ bị chặn chạy cho tới khi bạn cập nhật.')
  })

  it('also for a project schemaVersion above 2, or a scene / preset on a model this build does not know', () => {
    const v3 = { ...project(), schemaVersion: 3 }
    expect(importWarning({ version: 2, project: v3 }, importedProject(v3, {}))).toBe(NEWER_FILE_WARNING)
    const withScene = { ...project(), scenes: [{ ...scene('s1', 1), settings: VEO }] }
    const imported = importedProject(withScene, {})
    // the marker survives the import (the scene stays blocked)
    expect(imported.scenes[0]).toMatchObject({ foreignModel: 'seedvis/veo_3.1', foreignSettings: VEO })
    expect(importWarning({ version: 2, project: withScene }, imported)).toBe(NEWER_FILE_WARNING)
    const withPreset = { ...project(), presets: [{ id: 'pv', name: 'Veo', ...VEO }] }
    expect(importWarning({ version: 2, project: withPreset }, importedProject(withPreset, {}))).toBe(NEWER_FILE_WARNING)
  })

  it('says nothing for files of this build or older ones', () => {
    for (const version of [1, 2, undefined, '3']) {
      const raw = project()
      expect(importWarning({ version, project: raw }, importedProject(raw, {}))).toBeNull()
    }
    const v1 = { ...project(), schemaVersion: 1 }
    expect(importWarning({ version: 1, project: v1 }, importedProject(v1, {}))).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { migrateProject, migrateTake } from '../migrate'

const v1 = {
  id: 'p',
  name: 'Old',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { referencesTemplate: '{list}', autoReferences: true, autoContinuity: true },
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1'], color: '#fff', position: null },
    { id: 'b', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i2'], color: '#fff', position: null },
  ],
  blocks: [
    { id: 'k1', title: 'Style', text: 'STYLE', placement: 'before', defaultOn: true, color: '#fff' },
    { id: 'k2', title: 'Audio', text: 'AUDIO', placement: 'after', defaultOn: true, color: '#fff' },
    { id: 'k3', title: 'Off', text: 'OFF', placement: 'after', defaultOn: false, color: '#fff' },
  ],
  scenes: [
    {
      id: 's1',
      order: 1,
      title: '',
      prompt: '@Elara walks into @Cave',
      refs: ['b', 'a'],
      blockOverrides: { k2: false, k3: true },
      presetId: null,
      settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
      continueFrom: null,
      firstFrame: null,
      lastFrame: null,
      color: null,
      position: { x: 0, y: 0 },
      note: '',
    },
  ],
}

describe('migrateProject v1 → v2', () => {
  it('inlines enabled blocks, converts @Tags to @image_N and drops v1 fields', () => {
    const p = migrateProject(v1)
    expect(p.schemaVersion).toBe(2)
    expect('blocks' in p).toBe(false)
    expect(p.settings).toEqual({ autoRenumber: true })
    const s = p.scenes[0]
    expect(s.prompt).toBe('STYLE\n\n@image_2 walks into @image_1\n\nOFF')
    expect(s.videoRefs).toEqual([])
    expect('blockOverrides' in s).toBe(false)
    expect('continueFrom' in s).toBe(false)
  })
  it('is idempotent on v2 projects', () => {
    const once = migrateProject(v1)
    expect(migrateProject(once)).toEqual(once)
  })
  it('fills take defaults', () => {
    const t = migrateTake({ id: 't', sceneId: 's', number: 1, status: 'completed' })
    expect(t.position).toBeNull()
    expect(t.videoRefsSnapshot).toEqual([])
  })
})

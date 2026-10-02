import { describe, expect, it } from 'vitest'
import { dropVideoRefs, migrateProject, migrateTake } from '../migrate'

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

describe('migrateProject repairs files from other sources', () => {
  it('gives every scene an id, a dense order, a title and a position (never "Sundefined")', () => {
    const p = migrateProject({
      schemaVersion: 2,
      name: '',
      scenes: [
        { id: 'x', order: 5, prompt: 'b' },
        { prompt: 'c' },
        { id: 'x', order: 2, prompt: 'a', position: { x: 1, y: 2 } },
      ],
      assets: [{ name: 'Elara', imageIds: ['i1', 3] }, { name: 'Elara' }],
    })
    // file order is kept, numbers follow the saved order
    expect(p.scenes.map((s) => [s.order, s.prompt])).toEqual([
      [2, 'b'],
      [3, 'c'],
      [1, 'a'],
    ])
    expect(new Set(p.scenes.map((s) => s.id)).size).toBe(3)
    expect(p.scenes.every((s) => s.title === '' && Number.isFinite(s.position.x) && Number.isFinite(s.position.y))).toBe(true)
    expect(p.scenes[2].position).toEqual({ x: 1, y: 2 })
    expect(p.name).toBe('Dự án')
    expect(p.assets[0].imageIds).toEqual(['i1'])
    expect(p.assets[0].tag).not.toBe(p.assets[1].tag)
    expect(p.assets[1].position).toBeNull()
  })
})

describe('dropVideoRefs (copy / import without the takes)', () => {
  it('clears video refs and turns their tokens into text, image tokens unchanged', () => {
    const p = migrateProject(v1)
    const scene = { ...p.scenes[0], refs: ['a'], videoRefs: ['t1', 't2'], prompt: '@image_1 after @video_2 and @video_1, @video_3' }
    const out = dropVideoRefs({ ...p, scenes: [scene] }, (t) => (t === 't1' ? 'video S01·T1' : 'video'))
    expect(out.scenes[0].videoRefs).toEqual([])
    // @video_3 was already invalid: left as is (and still reported by the compile warnings)
    expect(out.scenes[0].prompt).toBe('@image_1 after video and video S01·T1, @video_3')
  })
  it('returns the same project when there is nothing to drop', () => {
    const p = migrateProject(v1)
    expect(dropVideoRefs(p)).toBe(p)
  })
})

describe('migrateTake provider fields', () => {
  it('defaults old takes to the demo provider (not submitted, paid with demo credits)', () => {
    const t = migrateTake({ id: 't', sceneId: 's', number: 1, status: 'completed' })
    expect(t).toMatchObject({ provider: 'mock', remoteId: null, charged: true })
    expect('framesSnapshot' in t).toBe(false)
    expect('imageKeysSnapshot' in t).toBe(false)
  })
  it('keeps the fields of newer takes', () => {
    const t = migrateTake({
      id: 't',
      status: 'processing',
      provider: 'canvasapp',
      remoteId: 'prj:job',
      charged: false,
      framesSnapshot: { first: 'a' },
      imageKeysSnapshot: ['a:i1', 'b:i2'],
    })
    expect(t).toMatchObject({ provider: 'canvasapp', remoteId: 'prj:job', charged: false, framesSnapshot: { first: 'a', last: null } })
    expect(t.imageKeysSnapshot).toEqual(['a:i1', 'b:i2'])
  })
  it('drops a malformed image key list', () => {
    expect('imageKeysSnapshot' in migrateTake({ id: 't', imageKeysSnapshot: [1, 2] })).toBe(false)
  })
})

describe('migrateProject presets', () => {
  it('gives presets an id, a name and valid settings; drops links to missing presets', () => {
    const p = migrateProject({
      schemaVersion: 2,
      presets: [{ id: 'k', name: '  ', model: 'minimax_h3', duration: 99 }, null, { name: 'B' }],
      scenes: [
        { id: 's1', presetId: 'k' },
        { id: 's2', presetId: 'gone' },
      ],
    })
    expect(p.presets).toHaveLength(2)
    expect(p.presets[0]).toMatchObject({ id: 'k', name: 'Preset', model: 'minimax_h3', mode: 't2v', duration: 15, resolution: '768p', ratio: '16:9' })
    expect(p.presets[1].id).toBeTruthy()
    expect(p.presets[1].name).toBe('B')
    expect(p.scenes.map((s) => s.presetId)).toEqual(['k', null])
  })
})

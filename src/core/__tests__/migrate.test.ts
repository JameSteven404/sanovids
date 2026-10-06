import { describe, expect, it } from 'vitest'
import {
  cleanForeignSettings,
  dropVideoRefs,
  FOREIGN_ID_MAX,
  FOREIGN_RUNNING_ERROR,
  FOREIGN_SETTINGS_MAX_BYTES,
  FOREIGN_SETTINGS_MAX_KEYS,
  migrateProject,
  migrateTake,
  parkForeignTake,
} from '../migrate'
import { costOf, isModelId, normalizeSettings, settingsLabel } from '../models'
import { foreignConfigReason } from '../runRules'

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
    // @video_3 was already invalid: it becomes a visible placeholder (blocked from running by the compile check)
    expect(out.scenes[0].prompt).toBe('@image_1 after video and video S01·T1, @video_?3')
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
  it('keeps development-mode takes as dev; an unknown provider is a newer build’s (never paid here: charged false)', () => {
    expect(migrateTake({ id: 't', provider: 'dev', remoteId: 'p:j', charged: false })).toMatchObject({ provider: 'dev', remoteId: 'p:j', charged: false })
    expect(migrateTake({ id: 't', provider: 'other' })).toMatchObject({ provider: 'mock', foreignProvider: 'other', charged: false })
    expect(migrateTake({ id: 't', provider: 'other', charged: true })).toMatchObject({ provider: 'mock', foreignProvider: 'other', charged: false })
  })
})

describe('takes of a newer build (foreignProvider / foreignStatus)', () => {
  const running = (status: string, over: Record<string, unknown> = {}) =>
    migrateTake({ id: 't', sceneId: 's', number: 1, status, provider: 'seedvis', remoteId: 'job-42', charged: true, error: null, ...over })

  it('only a non-blank unknown provider id is foreign; canvasapp / dev / mock / the old demo keep their charged flag', () => {
    expect(migrateTake({ id: 't', provider: 'canvasapp', charged: true })).toMatchObject({ provider: 'canvasapp', charged: true })
    expect(migrateTake({ id: 't', provider: 'dev' })).toMatchObject({ provider: 'dev', charged: true })
    expect(migrateTake({ id: 't', provider: 'mock' })).toMatchObject({ provider: 'mock', charged: true })
    expect(migrateTake({ id: 't', provider: 'mock', charged: false })).toMatchObject({ provider: 'mock', charged: false })
    for (const provider of [undefined, null, '', '   ', 42, { id: 'seedvis' }]) {
      const t = migrateTake({ id: 't', provider })
      expect(t).toMatchObject({ provider: 'mock', charged: true })
      expect('foreignProvider' in t).toBe(false)
    }
    // a known provider is never "foreign", whatever a file says
    for (const provider of ['canvasapp', 'dev'] as const) {
      const t = migrateTake({ id: 't', provider, foreignProvider: 'seedvis', foreignStatus: 'processing', status: 'failed' })
      expect(t.provider).toBe(provider)
      expect('foreignProvider' in t || 'foreignStatus' in t).toBe(false)
    }
    const odd = migrateTake({ id: 't', provider: 'mock', foreignProvider: 'canvasapp' })
    expect('foreignProvider' in odd).toBe(false)
    expect(odd.charged).toBe(true)
  })

  it('a take the newer build was still running is parked as failed: status kept in foreignStatus, remoteId kept', () => {
    for (const status of ['queued', 'processing'] as const) {
      const t = running(status)
      expect(t).toMatchObject({
        provider: 'mock',
        foreignProvider: 'seedvis',
        foreignStatus: status,
        status: 'failed',
        error: FOREIGN_RUNNING_ERROR,
        remoteId: 'job-42',
        charged: false,
      })
    }
    expect(FOREIGN_RUNNING_ERROR).toBe('Video này đang tạo bằng SanoVids bản mới hơn — mở bằng bản đó để theo dõi.')
    // finished ones keep their status and their error
    expect(running('completed')).toMatchObject({ status: 'completed', error: null, foreignProvider: 'seedvis' })
    expect('foreignStatus' in running('completed')).toBe(false)
    expect(running('failed', { error: 'boom' })).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('is idempotent: a parked take saved and loaded again stays the same', () => {
    const once = running('processing')
    const again = migrateTake(JSON.parse(JSON.stringify(once)))
    expect(again).toEqual(once)
    // a foreignStatus is only kept next to the failed it was parked as, and only a running status
    expect('foreignStatus' in migrateTake({ ...once, status: 'completed' })).toBe(false)
    expect('foreignStatus' in migrateTake({ ...once, foreignStatus: 'completed' })).toBe(false)
  })

  it('cuts a very long provider id (it still marks the take)', () => {
    const t = migrateTake({ id: 't', provider: 'x'.repeat(500) })
    expect(t.foreignProvider).toBe('x'.repeat(FOREIGN_ID_MAX))
    expect(t.charged).toBe(false)
  })

  it('parkForeignTake leaves every other take as it is (same object)', () => {
    const plain = migrateTake({ id: 't', provider: 'dev', status: 'processing' })
    expect(parkForeignTake(plain)).toBe(plain)
    const done = running('completed')
    expect(parkForeignTake(done)).toBe(done)
  })
})

describe('projects of a newer build', () => {
  const VEO = { model: 'seedvis/veo_3.1', mode: 'r2v', duration: 8, resolution: '1080p', ratio: '9:16', audio: true, seed: 7 }
  const newer = (over: Record<string, unknown> = {}) => ({
    id: 'p',
    name: 'Mới',
    schemaVersion: 3,
    createdAt: 1,
    updatedAt: 1,
    settings: { autoRenumber: true },
    assets: [{ id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1'], color: '#fff', position: null }],
    presets: [{ id: 'pv', name: 'Veo dọc', ...VEO }],
    scenes: [
      {
        id: 's1',
        order: 1,
        title: 'Mở đầu',
        prompt: '@image_1 nhìn @Elara',
        refs: ['a'],
        videoRefs: [],
        presetId: 'pv',
        settings: VEO,
        firstFrame: null,
        lastFrame: null,
        color: null,
        position: { x: 0, y: 0 },
        note: '',
      },
    ],
    ...over,
  })

  it('schemaVersion 3 is not read as v1 (prompts are not rewritten); its number is kept (never relabelled 2)', () => {
    const p = migrateProject(newer())
    expect(p.schemaVersion).toBe(3)
    // saved and loaded again: still 3 (a build that relies on the number never migrates its v3 data twice)
    expect(migrateProject(JSON.parse(JSON.stringify(p))).schemaVersion).toBe(3)
    // only a sane integer above 2 is kept; anything else comes out as 2
    for (const schemaVersion of [2, 2.5, 1e9, -3, '3', NaN, undefined]) expect(migrateProject({ ...newer(), schemaVersion }).schemaVersion, String(schemaVersion)).toBe(2)
    expect(p.scenes[0].prompt).toBe('@image_1 nhìn @Elara')
    // v1 is only what came before 2 (or carries no number)
    for (const schemaVersion of [1, 0, undefined, '2', NaN]) {
      expect(migrateProject({ ...newer(), schemaVersion }).scenes[0].prompt).toBe('@image_1 nhìn @image_1')
    }
  })

  it('keeps an unknown model as a marker with the original settings; settings get valid stand-in values', () => {
    const p = migrateProject(newer())
    const s = p.scenes[0]
    expect(s.foreignModel).toBe('seedvis/veo_3.1')
    expect(s.foreignSettings).toEqual(VEO)
    // valid for the stand-in model (what normalizeSettings keeps of the saved values: 1080p, 9:16)
    expect(s.settings).toEqual({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '9:16' })
    expect(s.settings).toEqual(normalizeSettings(VEO as never))
    expect(s.presetId).toBe('pv')
    // the preset too (its id / name are not settings)
    expect(p.presets[0]).toEqual({ id: 'pv', name: 'Veo dọc', ...normalizeSettings(VEO as never), foreignModel: 'seedvis/veo_3.1', foreignSettings: VEO })
  })

  it('is idempotent: a saved and reloaded project keeps the marker exactly', () => {
    const once = migrateProject(newer())
    const again = migrateProject(JSON.parse(JSON.stringify(once)))
    expect(again).toEqual(once)
    expect(again.scenes[0].foreignSettings).toEqual(VEO)
  })

  it('known models, a missing / blank model and old projects get no marker (no new keys)', () => {
    const p = migrateProject({
      schemaVersion: 2,
      presets: [
        { id: 'k', name: 'H3', model: 'minimax_h3' },
        { id: 'z', name: 'Trống' },
      ],
      scenes: [
        { id: 's1', settings: { model: 'minimax_h3', mode: 'i2v' } },
        { id: 's2', settings: { model: '' } },
        { id: 's3', settings: { model: '   ' } },
        { id: 's4' },
        { id: 's5', settings: { model: 7 } },
      ],
    })
    for (const x of [...p.scenes, ...p.presets]) {
      expect('foreignModel' in x || 'foreignSettings' in x).toBe(false)
    }
    expect(p.scenes[0].settings.model).toBe('minimax_h3')
    const old = migrateProject(v1)
    expect('foreignModel' in old.scenes[0]).toBe(false)
  })

  it('never takes a marker from the file as it is', () => {
    const p = migrateProject({
      schemaVersion: 2,
      scenes: [
        // a kept marker on stand-in settings (saved by this build): validated and kept
        { id: 's1', settings: normalizeSettings({}), foreignModel: 'seedvis/veo_3.1', foreignSettings: { ...VEO, nested: { a: 1 }, list: [1], none: null, inf: Infinity } },
        // settings without a model id are meaningless: dropped
        { id: 's2', settings: normalizeSettings({}), foreignSettings: VEO },
        // blank / non-string model ids are no marker
        { id: 's3', settings: normalizeSettings({}), foreignModel: '  ', foreignSettings: VEO },
        { id: 's4', settings: normalizeSettings({}), foreignModel: 12 },
        // a marker without its settings still blocks
        { id: 's5', settings: normalizeSettings({}), foreignModel: 'x-model', foreignSettings: 'oops' },
      ],
    })
    const [s1, s2, s3, s4, s5] = p.scenes
    expect(s1.foreignModel).toBe('seedvis/veo_3.1')
    expect(s1.foreignSettings).toEqual(VEO)
    for (const s of [s2, s3, s4]) expect('foreignModel' in s || 'foreignSettings' in s).toBe(false)
    expect(s5.foreignModel).toBe('x-model')
    expect('foreignSettings' in s5).toBe(false)
  })

  it('a marker naming a model this build knows gives the settings back and goes (what a newer build does)', () => {
    const p = migrateProject({
      schemaVersion: 2,
      scenes: [{ id: 's1', settings: normalizeSettings({}), foreignModel: 'minimax_h3', foreignSettings: { model: 'other', mode: 'transform', duration: 10, resolution: '2k' } }],
      presets: [{ id: 'k', name: 'K', ...normalizeSettings({}), foreignModel: 'minimax_h3', foreignSettings: { duration: 5 } }],
    })
    expect(p.scenes[0].settings).toEqual({ model: 'minimax_h3', mode: 'transform', duration: 10, resolution: '2k', ratio: '16:9' })
    expect('foreignModel' in p.scenes[0] || 'foreignSettings' in p.scenes[0]).toBe(false)
    expect(p.presets[0]).toEqual({ id: 'k', name: 'K', model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' })
  })

  it('a current unknown model wins over a marker saved with it', () => {
    const p = migrateProject({ schemaVersion: 3, scenes: [{ id: 's1', settings: VEO, foreignModel: 'older-x', foreignSettings: { a: 1 } }] })
    expect(p.scenes[0]).toMatchObject({ foreignModel: 'seedvis/veo_3.1', foreignSettings: VEO })
  })

  it('inherited object names are unknown models, never a crash', () => {
    for (const model of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isModelId(model)).toBe(false)
      const p = migrateProject({ schemaVersion: 2, scenes: [{ id: 's1', settings: { model, duration: 5 } }], presets: [{ id: 'k', name: 'K', model }] })
      expect(p.scenes[0].foreignModel).toBe(model)
      expect(p.scenes[0].settings.model).toBe('seedance_2_5')
      expect(p.presets[0].foreignModel).toBe(model)
      expect(costOf({ ...p.scenes[0].settings, model: model as never })).toBe(0)
    }
    expect(isModelId('seedance_2_5') && isModelId('minimax_h3')).toBe(true)
  })

  it('cuts a very long model id (it still blocks)', () => {
    const id = 'm'.repeat(300)
    expect(migrateProject({ schemaVersion: 2, scenes: [{ id: 's1', settings: { model: id } }] }).scenes[0].foreignModel).toBe('m'.repeat(FOREIGN_ID_MAX))
  })
})

describe('cleanForeignSettings', () => {
  it('keeps flat primitive values only', () => {
    expect(cleanForeignSettings({ a: 'x', b: 2, c: false, d: null, e: { f: 1 }, g: [1], h: NaN, i: undefined })).toEqual({ a: 'x', b: 2, c: false })
    for (const raw of [null, undefined, 'x', 3, [1, 2], {}, { a: null }]) expect(cleanForeignSettings(raw)).toBeNull()
  })
  it('caps the number of keys and the size; an entry that does not fit is skipped', () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
    const out = cleanForeignSettings(many)!
    expect(Object.keys(out)).toHaveLength(FOREIGN_SETTINGS_MAX_KEYS)
    expect(out.k0).toBe(0)
    const big = cleanForeignSettings({ model: 'veo', huge: 'x'.repeat(5000), duration: 8 })!
    expect(big).toEqual({ model: 'veo', duration: 8 })
    const wide = cleanForeignSettings(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'é'.repeat(60)])))!
    expect(new TextEncoder().encode(JSON.stringify(wide)).length).toBeLessThanOrEqual(FOREIGN_SETTINGS_MAX_BYTES)
    expect(Object.keys(wide).length).toBeLessThan(30)
  })
  it('never writes __proto__ and skips the omitted keys', () => {
    const raw = JSON.parse('{"__proto__": "x", "model": "veo", "id": "p1", "name": "N"}')
    const out = cleanForeignSettings(raw, ['id', 'name'])!
    expect(out).toEqual({ model: 'veo' })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
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

describe('takes of a newer build’s model on a provider this build knows (foreignModel)', () => {
  const take = (over: Record<string, unknown> = {}) => ({
    id: 't',
    sceneId: 's',
    number: 1,
    status: 'queued',
    provider: 'canvasapp',
    remoteId: null,
    charged: true,
    error: null,
    settings: { model: 'kling_3', mode: 't2v', duration: 10, resolution: '1080p', ratio: '16:9', audio: true },
    ...over,
  })

  it('a queued / running canvasapp take on an unknown model is parked: never sent, polled or looked up here', () => {
    for (const status of ['queued', 'processing'] as const) {
      const t = migrateTake(take({ status, remoteId: status === 'processing' ? 'prj:job-9' : null }))
      expect(t).toMatchObject({
        provider: 'canvasapp',
        foreignModel: 'kling_3',
        status: 'failed',
        foreignStatus: status,
        error: FOREIGN_RUNNING_ERROR,
        charged: true, // a known provider keeps its own billing state
        remoteId: status === 'processing' ? 'prj:job-9' : null,
      })
      expect('foreignProvider' in t).toBe(false)
      // the model id stays as saved (badges show it; the engine refuses it)
      expect(t.settings.model).toBe('kling_3')
    }
    // a finished one keeps its status (only the marker)
    expect(migrateTake(take({ status: 'completed' }))).toMatchObject({ status: 'completed', foreignModel: 'kling_3' })
    expect(parkForeignTake(migrateTake(take({ status: 'completed' })))).toMatchObject({ status: 'completed' })
  })

  it('known models, and blank / missing ones, are no marker (a missing model is never "a newer build")', () => {
    for (const model of ['seedance_2_5', 'minimax_h3', '', '  ', undefined, 7, 'constructor']) {
      const t = migrateTake(take({ settings: { model, mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' } }))
      if (model === 'constructor') expect(t.foreignModel).toBe('constructor')
      else expect('foreignModel' in t, String(model)).toBe(false)
    }
  })

  it('is idempotent; a later build that knows the model gets the status and error back', () => {
    const once = migrateTake(take({ status: 'processing', remoteId: 'prj:job-9', error: 'old error' }))
    expect(once.foreignError).toBe('old error')
    expect(migrateTake(JSON.parse(JSON.stringify(once)))).toEqual(once)
    // what a build that knows the model does with the parked take (simulated: the saved model id is one it knows)
    const known = { ...JSON.parse(JSON.stringify(once)), settings: { ...once.settings, model: 'minimax_h3' }, foreignModel: 'minimax_h3' }
    const back = migrateTake(known)
    expect(back).toMatchObject({ status: 'processing', error: 'old error', remoteId: 'prj:job-9', provider: 'canvasapp' })
    for (const k of ['foreignModel', 'foreignStatus', 'foreignError', 'foreignSettings']) expect(k in back, k).toBe(false)
    // a parked take whose error was changed meanwhile is not resumed (only the park's own text)
    expect(migrateTake({ ...known, error: 'Bị huỷ' })).toMatchObject({ status: 'failed', error: 'Bị huỷ' })
  })
})

describe('originals of a newer build are kept for the build that knows them', () => {
  it('a foreign provider take keeps its own charged (foreignCharged) and its error when parked (foreignError)', () => {
    const t = migrateTake({ id: 't', provider: 'seedvis', charged: true, status: 'processing', remoteId: 'j', error: 'tạm dừng' })
    expect(t).toMatchObject({ provider: 'mock', charged: false, foreignCharged: true, foreignError: 'tạm dừng', error: FOREIGN_RUNNING_ERROR })
    expect(migrateTake(JSON.parse(JSON.stringify(t)))).toEqual(t)
    // nothing saved → nothing invented
    const none = migrateTake({ id: 't', provider: 'seedvis', status: 'completed' })
    expect('foreignCharged' in none || 'foreignError' in none).toBe(false)
    expect(migrateTake({ id: 't', provider: 'seedvis', charged: false }).foreignCharged).toBe(false)
    // a known provider never gets them (a file's markers are not trusted)
    const odd = migrateTake({ id: 't', provider: 'dev', foreignCharged: true, foreignError: 'x', foreignSettings: { a: 1 } })
    expect('foreignCharged' in odd || 'foreignError' in odd || 'foreignSettings' in odd).toBe(false)
  })

  it('take settings: safe primitives for every reader (settingsLabel never throws), the saved values kept', () => {
    const odd = migrateTake({ id: 't', provider: 'seedvis', status: 'completed', settings: { model: 'veo', duration: '8', resolution: 1080, extra: 'x' } })
    expect(odd.settings).toEqual({ model: 'veo', mode: '', duration: 0, resolution: '', ratio: '', extra: 'x' })
    expect(odd.foreignSettings).toEqual({ model: 'veo', duration: '8', resolution: 1080, extra: 'x' })
    expect(() => settingsLabel(odd.settings)).not.toThrow()
    expect(migrateTake(JSON.parse(JSON.stringify(odd)))).toEqual(odd)
    const bare = migrateTake({ id: 't', provider: 'dev', status: 'completed' })
    expect(settingsLabel(bare.settings)).toBe('0s ·  · ')
    expect(settingsLabel({} as never)).toBe('?s ·  · ')
    // a normal take is unchanged (its extra keys too)
    const normal = { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' }
    expect(migrateTake({ id: 't', provider: 'dev', settings: normal }).settings).toEqual(normal)
  })
})

describe('values of a newer build for a model this build knows (config marker)', () => {
  const scene = (settings: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    id: 's1',
    order: 1,
    title: '',
    prompt: 'x',
    refs: [],
    videoRefs: [],
    presetId: null,
    settings,
    firstFrame: null,
    lastFrame: null,
    color: null,
    position: { x: 0, y: 0 },
    note: '',
    ...over,
  })
  const project = (schemaVersion: number, settings: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    id: 'p',
    name: 'P',
    schemaVersion,
    createdAt: 1,
    updatedAt: 1,
    settings: { autoRenumber: true },
    assets: [],
    presets: [{ id: 'p4k', name: '4K', ...settings }],
    scenes: [scene(settings, over)],
  })
  const FOURK = { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '4k', ratio: '21:9' }

  it('kept as foreignSettings alone (stand-in settings), it blocks running, survives a save, also on presets', () => {
    const p = migrateProject(project(3, FOURK))
    const s = p.scenes[0]
    expect(s.foreignSettings).toEqual(FOURK)
    expect('foreignModel' in s).toBe(false)
    expect(s.settings).toEqual({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '480p', ratio: '16:9' })
    expect(p.presets[0].foreignSettings).toEqual(FOURK)
    const again = migrateProject(JSON.parse(JSON.stringify(p)))
    expect(again.scenes[0].foreignSettings).toEqual(FOURK)
    expect(again.scenes[0].settings).toEqual(s.settings)
    expect(foreignConfigReason(FOURK)).toBe(
      'Cảnh dùng cấu hình của bản SanoVids mới hơn (độ phân giải 4k, tỉ lệ 21:9) — cập nhật SanoVids để chạy (hoặc chọn lại cấu hình để chạy bằng cấu hình này).',
    )
  })

  it('a v2 file: only values no model here ever offered (an old Seedance scene left on an H3 mode is quietly fixed as before)', () => {
    const oldMix = migrateProject(project(2, { model: 'seedance_2_5', mode: 'i2v', duration: 10, resolution: '2k', ratio: '16:9' }))
    expect('foreignSettings' in oldMix.scenes[0]).toBe(false)
    expect(oldMix.scenes[0].settings).toMatchObject({ mode: 't2v', resolution: '480p' })
    const v2new = migrateProject(project(2, FOURK))
    expect(v2new.scenes[0].foreignSettings).toEqual(FOURK)
    // the same mix in a newer schema: kept (a newer build may have added 2k to Seedance)
    expect(migrateProject(project(3, { model: 'seedance_2_5', mode: 't2v', duration: 10, resolution: '2k', ratio: '16:9' })).scenes[0].foreignSettings).toMatchObject({ resolution: '2k' })
  })

  it('a build that offers those values restores them and drops the marker', () => {
    // simulated: a marker whose values this build offers (as the build that adds 4k would see its own marker)
    const offered = { model: 'seedance_2_5', mode: 't2v', duration: 10, resolution: '720p', ratio: '9:16' }
    const p = migrateProject({ ...project(2, offered), scenes: [scene({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '480p', ratio: '16:9' }, { foreignSettings: offered })] })
    expect(p.scenes[0].settings).toEqual(offered)
    expect('foreignSettings' in p.scenes[0]).toBe(false)
  })
})

// Migration of seedvis data between the build that ships seedvis (core/seedvisFlag on) and a build without it (off —
// what this build is until wave C, and what 0.6.0 without seedvis does): plan §4, M18. Two module instances of
// core/migrate are loaded, one per flag value, so a file can travel on → off → on like a project opened in both.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type * as MigrateModule from '../migrate'
import type { Take, VideoSettings } from '../types'

type Migrate = typeof MigrateModule

async function migrateWith(enabled: boolean): Promise<Migrate> {
  vi.resetModules()
  vi.doMock('../seedvisFlag', () => ({ SEEDVIS_ENABLED: enabled }))
  try {
    return await import('../migrate')
  } finally {
    vi.doUnmock('../seedvisFlag')
  }
}

let on: Migrate
let off: Migrate
beforeAll(async () => {
  off = await migrateWith(false)
  on = await migrateWith(true)
})

/** Saved and loaded: what a file holds. */
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const VEO: VideoSettings = { model: 'seedvis/veo_3.1', mode: 'first', duration: 8, resolution: '1080p', ratio: '9:16' }
const SD_SV: VideoSettings = { model: 'seedvis/seedance_2.5', mode: 't2v', duration: 20, resolution: 'auto', ratio: '21:9' }

const take = (over: Partial<Take> & Record<string, unknown> = {}): Take =>
  ({
    id: 't1',
    sceneId: 's1',
    number: 1,
    status: 'processing',
    progress: 40,
    createdAt: 1000,
    startedAt: 2000,
    finishedAt: null,
    promptSnapshot: 'Mưa rơi',
    rawPromptSnapshot: 'Mưa rơi',
    refsSnapshot: [],
    videoRefsSnapshot: [],
    settings: VEO,
    cost: 0,
    costUnknown: true,
    starred: false,
    posterId: null,
    videoId: null,
    error: null,
    position: null,
    provider: 'seedvis',
    remoteId: 'gen_42',
    charged: false,
    remotePhase: 'processing',
    keyHint: 'AB12',
    keyTag: 'a1b2c3d4e5f6',
    ...over,
  }) as Take

describe('a build without seedvis (flag off) parks seedvis takes, as 0.6.0 always did', () => {
  it('provider and model are a newer build’s: never sent, polled or refunded here; the job and key facts kept', () => {
    const parked = off.migrateTake(take())
    expect(parked).toMatchObject({
      provider: 'mock',
      foreignProvider: 'seedvis',
      foreignModel: 'seedvis/veo_3.1',
      status: 'failed',
      foreignStatus: 'processing',
      error: off.FOREIGN_RUNNING_ERROR,
      remoteId: 'gen_42',
      charged: false,
      foreignCharged: false,
      keyHint: 'AB12',
      keyTag: 'a1b2c3d4e5f6',
      settings: VEO,
    })
    expect(off.migrateTake(json(parked))).toEqual(parked)
  })
})

describe('the build that ships seedvis (flag on)', () => {
  it('keeps a seedvis / seedvis-dev take as it is, byte for byte on a second load', () => {
    for (const provider of ['seedvis', 'seedvis-dev'] as const) {
      const once = on.migrateTake(take({ provider }))
      expect(once).toEqual(take({ provider }))
      expect(JSON.stringify(on.migrateTake(json(once)))).toBe(JSON.stringify(once))
    }
  })

  describe('restores what a build without seedvis parked (decision 12, M18)', () => {
    /** on → saved → opened by a build without seedvis → saved → opened here again. */
    const roundTrip = (t: Take): { first: Take; parked: Take; back: Take } => {
      const first = on.migrateTake(json(t))
      const parked = off.migrateTake(json(first))
      return { first, parked, back: on.migrateTake(json(parked)) }
    }

    it('unchanged: finished, running with a job, uncertain, fetchable — field for field', () => {
      const cases: Take[] = [
        take({ status: 'completed', progress: 100, finishedAt: 9000, videoId: 'v1', posterId: 'p1', cost: 30, costUnknown: undefined, costEstimated: true, remotePhase: undefined, starred: true }),
        take(),
        take({ status: 'processing', remotePhase: 'queued', remoteNote: 'Trong hàng chờ seedvis (vị trí 2, ~60 giây)', cancelRequested: true }),
        take({ status: 'processing', cancelBlocked: true }),
        take({ status: 'failed', remoteId: null, submitUnknown: true, error: on.SEEDVIS_UNVERIFIABLE_SUBMIT_ERROR.seedvis, remotePhase: undefined }),
        take({ status: 'failed', fetchable: true, remoteDetail: 'mất mạng lúc tải', error: 'Video đã tạo xong trên seedvis (đã trừ credit) nhưng SanoVids chưa tải về được.' }),
        take({ status: 'failed', remoteCode: 'not_started', error: 'seedvis chưa bắt đầu job (chờ quá lâu) — không bị trừ credit.', remotePhase: undefined }),
        take({ provider: 'seedvis-dev', status: 'cancelled', remoteCode: 'cancelled', settings: SD_SV, charged: true }),
      ]
      for (const t of cases) {
        const { first, parked, back } = roundTrip(t)
        expect(parked.provider, t.status).toBe('mock')
        expect(back, `${t.status} ${t.provider}`).toEqual(first)
      }
    })

    it('a running take resumes as processing (its own error back); a queued one with a job id too — never a POST', () => {
      const { back } = roundTrip(take({ error: 'tạm dừng' }))
      expect(back).toMatchObject({ status: 'processing', error: 'tạm dừng', provider: 'seedvis', remoteId: 'gen_42' })
      // a submit in flight when it was saved (no job id yet): resumes too — the engine looks it up in the ledger only
      expect(roundTrip(take({ remoteId: null })).back).toMatchObject({ status: 'processing', remoteId: null, error: null })
      expect(roundTrip(take({ status: 'queued', remoteId: 'gen_7' })).back).toMatchObject({ status: 'processing', remoteId: 'gen_7' })
    })

    it('plain queued → cancelled, "chưa gửi, không bị trừ credit" — never sent by itself days later', () => {
      const { first, back } = roundTrip(take({ status: 'queued', progress: 0, startedAt: null, remoteId: null, remotePhase: undefined }))
      expect(back).toEqual({ ...first, status: 'cancelled', error: on.PARKED_QUEUED_ERROR })
      expect(on.PARKED_QUEUED_ERROR).toBe('Đã dừng vì dự án được mở bằng bản SanoVids cũ hơn — chưa gửi, không bị trừ credit. Bấm Chạy lại nếu vẫn cần.')
    })

    it('queued again after an uncertain submit → failed, unverifiable (maybe billed), submitUnknown kept', () => {
      for (const provider of ['seedvis', 'seedvis-dev'] as const) {
        const queued = take({ provider, status: 'queued', progress: 0, remoteId: null, submitUnknown: true, remotePhase: undefined })
        const { first, back } = roundTrip(queued)
        expect(back).toEqual({ ...first, status: 'failed', error: on.SEEDVIS_UNVERIFIABLE_SUBMIT_ERROR[provider] })
        expect(back.submitUnknown).toBe(true)
        // recognised as unverifiable by the engine (store/runs UNVERIFIABLE_PREFIX): "Chạy lại" only offers "Tạo lại"
        expect(back.error!.startsWith('Không kiểm tra được lần gửi trước')).toBe(true)
        expect(back.error).not.toMatch(/chưa gửi|không bị trừ/)
      }
    })

    it('charged comes back from foreignCharged (default false)', () => {
      expect(roundTrip(take({ status: 'completed', charged: true })).back.charged).toBe(true)
      const parked = off.migrateTake(take())
      const { foreignCharged: _c, ...without } = json(parked)
      expect(on.migrateTake(without as Take).charged).toBe(false)
    })

    it('a parked take whose seedvis route this build does not know stays parked (provider back, still blocked)', () => {
      const parked = off.migrateTake(take({ settings: { ...VEO, model: 'seedvis/omni_flash' } as unknown as VideoSettings }))
      const back = on.migrateTake(json(parked))
      expect(back).toMatchObject({ provider: 'seedvis', foreignModel: 'seedvis/omni_flash', status: 'failed', foreignStatus: 'processing', error: on.FOREIGN_RUNNING_ERROR })
      expect(on.migrateTake(json(back))).toEqual(back)
    })

    it('only seedvis executors are restored; a newer build’s other provider stays parked', () => {
      const other = off.migrateTake(take({ provider: 'futurevendor' as Take['provider'], settings: { ...VEO, model: 'future/model_x' } as unknown as VideoSettings }))
      expect(on.migrateTake(json(other))).toEqual(other)
    })
  })

  describe('scenes and presets travel through a build without seedvis unchanged', () => {
    const project = () => ({
      id: 'p',
      name: 'P',
      schemaVersion: 2,
      createdAt: 0,
      updatedAt: 0,
      assets: [{ id: 'a', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i1'], color: '#fff', position: null }],
      presets: [{ id: 'pv', name: 'Dọc 21:9', ...SD_SV }],
      settings: { autoRenumber: true },
      scenes: [
        { id: 's1', order: 1, title: 'Mở đầu', prompt: 'Mưa rơi', refs: [], videoRefs: [], presetId: null, settings: VEO, firstFrame: 'a', lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '' },
        { id: 's2', order: 2, title: '', prompt: '@image_1', refs: ['a'], videoRefs: [], presetId: 'pv', settings: SD_SV, firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 352 }, note: '' },
      ],
    })

    it('on → off (marked, blocked) → on: the same scenes and presets', () => {
      const first = on.migrateProject(project())
      expect(first.scenes.map((s) => s.settings)).toEqual([VEO, SD_SV])
      expect(first.scenes.some((s) => s.foreignModel || s.foreignSettings)).toBe(false)
      const parked = off.migrateProject(json(first))
      expect(parked.scenes.map((s) => s.foreignModel)).toEqual(['seedvis/veo_3.1', 'seedvis/seedance_2.5'])
      expect(parked.scenes.map((s) => s.foreignSettings)).toEqual([VEO, SD_SV])
      expect(parked.presets[0]).toMatchObject({ foreignModel: 'seedvis/seedance_2.5', foreignSettings: SD_SV })
      const back = on.migrateProject(json(parked))
      expect(back.scenes).toEqual(first.scenes)
      expect(back.presets).toEqual(first.presets)
      expect(JSON.stringify(on.migrateProject(json(back)))).toBe(JSON.stringify(back))
    })

    it('a value no seedvis route offers is a newer build’s (config marker); another route’s value is an own mix', () => {
      const withSettings = (settings: Record<string, unknown>, schemaVersion = 2) => on.migrateProject({ ...project(), schemaVersion, presets: [], scenes: [{ ...project().scenes[0], settings }] }).scenes[0]
      const r2v = withSettings({ ...VEO, mode: 'r2v' })
      expect(r2v.foreignModel).toBeUndefined()
      expect(r2v.foreignSettings).toEqual({ ...VEO, mode: 'r2v' })
      expect(r2v.settings.model).toBe('seedvis/veo_3.1')
      // 1:1 is Seedance · seedvis's: an older build's own mix, quietly fixed — but strict in a newer schema
      expect(withSettings({ ...VEO, ratio: '1:1' })).toMatchObject({ settings: { ...VEO, ratio: '16:9' } })
      expect(withSettings({ ...VEO, ratio: '1:1' }).foreignSettings).toBeUndefined()
      expect(withSettings({ ...VEO, ratio: '1:1' }, 3).foreignSettings).toEqual({ ...VEO, ratio: '1:1' })
    })
  })

  it('the optional seedvis fields are validated: wrong types / shapes dropped, each omitted at its default', () => {
    const junk = on.migrateTake(
      take({
        remoteId: null,
        costEstimated: 'yes',
        costUnknown: false,
        remotePhase: 'paused',
        remoteNote: 'x'.repeat(501),
        remoteDetail: 42,
        remoteCode: 'bad code',
        cancelRequested: true, // only next to a job id
        cancelBlocked: 1,
        keyHint: 'sv_live_0123456789abcdef', // never more than a hint
        keyTag: 'zz-not-hex',
        fetchable: true, // only next to a job id
      } as unknown as Partial<Take>),
    )
    for (const k of ['costEstimated', 'costUnknown', 'remotePhase', 'remoteNote', 'remoteDetail', 'remoteCode', 'cancelRequested', 'cancelBlocked', 'keyHint', 'keyTag', 'fetchable']) {
      expect(k in junk, k).toBe(false)
    }
    const kept = on.migrateTake(take({ status: 'failed', fetchable: true, cancelRequested: true, remoteCode: 'content_policy', remoteDetail: 'chi tiết' }))
    expect(kept).toMatchObject({ fetchable: true, cancelRequested: true, remoteCode: 'content_policy', remoteDetail: 'chi tiết', keyHint: 'AB12', keyTag: 'a1b2c3d4e5f6' })
    // a canvasapp take without them stays without them (no key added)
    const plain = off.migrateTake({ id: 't', provider: 'canvasapp', status: 'completed' })
    for (const k of ['costEstimated', 'remotePhase', 'keyHint', 'fetchable']) expect(k in plain, k).toBe(false)
  })
})

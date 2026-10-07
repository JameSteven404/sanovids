// "Nhập job" (reverse sync): the pure rules of providers/canvasapp/siteJobs.ts — which jobs of the bridge session may
// become takes of the open project, and what such a take records (known / inferred / unknown).
import { describe, expect, it } from 'vitest'
import type { CanvasJob } from '../canvasapp/api'
import { bridgeCanvas, canvasNodeId, clientRequestIdFor, encodeRemoteId, sceneNodeId, sceneNodeKey, type BridgeEntry } from '../canvasapp/mapping'
import {
  canvasHintFor,
  classifySiteJobs,
  CREATED_SKEW_MS,
  entryHint,
  hintMatches,
  hintsFor,
  MAX_IMPORT_PROMPT,
  NO_DOWNLOAD_AFTER_MS,
  normalizeImportPrompt,
  POST_WINDOW_MS,
  reconstructSiteJob,
  sentMayOwn,
  type SiteJobCandidate,
  type SiteJobContext,
  type SiteJobHint,
} from '../canvasapp/siteJobs'

const T = Date.parse('2026-10-06T10:00:00Z')
const P = 'proj1'
const node = (sceneId: string) => sceneNodeId('prjA', sceneId)

const job = (over: Partial<CanvasJob> = {}): CanvasJob => ({
  job_id: 'job1',
  job_name: 'Video 1',
  canvas_node_id: node('s2'),
  model_profile: 'seedance_2_5',
  status: 'processing',
  progress: 40,
  download_available: false,
  duration: 15,
  aspect_ratio: '16:9',
  created_at: new Date(T).toISOString(),
  creation_mode: 'canvas',
  ...over,
})

const ctx = (over: Partial<SiteJobContext> = {}): SiteJobContext => ({
  projectId: P,
  sceneByNode: new Map([
    [node('s1'), 's1'],
    [node('s2'), 's2'],
    [canvasNodeId('s3'), 's3'], // an old node (scene id alone)
  ]),
  sceneOrder: new Map([
    ['s1', 1],
    ['s2', 2],
    ['s3', 3],
  ]),
  takeJobIds: new Set(),
  takeIds: new Set(['take_a', 'take_b']),
  ledger: { jobs: {}, sent: {}, imported: {} },
  now: T + 60_000,
  ...over,
})

const codes = (jobs: CanvasJob[], c = ctx()) => {
  const r = classifySiteJobs(jobs, c)
  return { ok: r.candidates.map((x) => x.jobId), skipped: Object.fromEntries(r.skipped.map((s) => [s.jobId, s.code])), r }
}

describe('classifySiteJobs: what may be imported', () => {
  it('a job on a scene node of the open project, unknown to SanoVids, is a candidate of that scene (old nodes too)', () => {
    const { r } = codes([job(), job({ job_id: 'job2', canvas_node_id: canvasNodeId('s3'), status: 'queued', progress: null })])
    expect(r.candidates.map((c) => [c.jobId, c.sceneId, c.state, c.remoteId])).toEqual([
      ['job1', 's2', 'processing', encodeRemoteId(P, 'job1')],
      ['job2', 's3', 'queued', encodeRemoteId(P, 'job2')],
    ])
    expect(r.candidates[0]).toMatchObject({ model: 'seedance_2_5', duration: 15, ratio: '16:9', jobName: 'Video 1', reimport: false, createdAt: T })
    expect(r.listHasKeys).toBe(false)
  })

  it('skips with a reason: foreign node, a take of the project, SanoVids’ own, ended, not canvas, unknown model, bad id', () => {
    const { ok, skipped } = codes(
      [
        job({ job_id: 'other', canvas_node_id: sceneNodeId('another-project', 's2') }),
        job({ job_id: 'nonode', canvas_node_id: undefined }),
        job({ job_id: 'mine' }),
        job({ job_id: 'made' }),
        job({ job_id: 'f', status: 'failed' }),
        job({ job_id: 'c', status: 'cancelled' }),
        job({ job_id: 'e', status: 'expired' }),
        job({ job_id: 'simple', creation_mode: 'simple' }),
        job({ job_id: 'nocm', creation_mode: undefined }),
        job({ job_id: 'veo', model_profile: 'veo_3' }),
        job({ job_id: 'a:b' }),
        job({ job_id: 'x'.repeat(81) }),
        { status: 'processing' } as CanvasJob,
      ],
      ctx({ takeJobIds: new Set(['mine']), ledger: { jobs: { take_old: { remoteId: encodeRemoteId(P, 'made') } }, sent: {}, imported: {} } }),
    )
    expect(ok).toEqual(['nocm'])
    expect(skipped).toMatchObject({
      other: 'no-scene',
      nonode: 'no-scene',
      mine: 'in-project',
      made: 'sanovids',
      f: 'ended',
      c: 'ended',
      e: 'ended',
      simple: 'not-canvas',
      veo: 'unsupported-model',
      'a:b': 'bad-id',
      ['x'.repeat(81)]: 'bad-id',
      '': 'bad-id',
    })
  })

  it('a finished job canvasapp does not let download: offered for an hour after it finished, then not', () => {
    const fresh = job({ job_id: 'fresh', status: 'completed', download_available: false, finished_at: new Date(T).toISOString() })
    const old = job({ job_id: 'old', status: 'completed', download_available: false, finished_at: new Date(T - NO_DOWNLOAD_AFTER_MS).toISOString() })
    const none = job({ job_id: 'none', status: 'completed', download_available: false, finished_at: null })
    const ready = job({ job_id: 'ready', status: 'completed', download_available: true })
    const { ok, skipped } = codes([fresh, old, none, ready])
    expect(ok).toEqual(['fresh', 'ready'])
    expect(skipped).toEqual({ old: 'no-download', none: 'no-download' })
  })

  it('a job claimed before (take deleted / another project) is offered again as a re-import', () => {
    const { r } = codes([job()], ctx({ ledger: { jobs: {}, sent: {}, imported: { take_x: { remoteId: encodeRemoteId(P, 'job1') } } } }))
    expect(r.candidates[0].reimport).toBe(true)
  })

  it('sorted by scene order, then creation time', () => {
    const { ok } = codes([
      job({ job_id: 'b2', created_at: new Date(T + 2000).toISOString() }),
      job({ job_id: 'c', canvas_node_id: canvasNodeId('s3') }),
      job({ job_id: 'a', canvas_node_id: node('s1'), created_at: new Date(T + 9000).toISOString() }),
      job({ job_id: 'b1', created_at: new Date(T + 1000).toISOString() }),
    ])
    expect(ok).toEqual(['a', 'b1', 'b2', 'c'])
  })

  it('with client_request_id in the list: a take’s key → SanoVids’ job; an unanswered POST’s key → maybe-pending; a random UUID → candidate', () => {
    const ledger = {
      jobs: { take_done: { remoteId: encodeRemoteId(P, 'other') } },
      sent: { take_lost: { projectId: P, nodeId: node('s2'), at: T } },
      imported: {},
    }
    const { ok, skipped, r } = codes(
      [
        job({ job_id: 'j_take', client_request_id: clientRequestIdFor('take_a') }),
        job({ job_id: 'j_done', client_request_id: clientRequestIdFor('take_done') }),
        job({ job_id: 'j_v020', client_request_id: 'take_b' }), // v0.2.0 sent the take id itself
        job({ job_id: 'j_lost', client_request_id: clientRequestIdFor('take_lost') }),
        job({ job_id: 'j_site', client_request_id: '0b9d3c55-1d2a-4a6e-9f7e-2a1c4b5d6e7f' }),
      ],
      ctx({ ledger }),
    )
    expect(r.listHasKeys).toBe(true)
    expect(ok).toEqual(['j_site']) // exact keys: a site job next to an unanswered POST is NOT held back
    expect(skipped).toEqual({ j_take: 'sanovids', j_done: 'sanovids', j_v020: 'sanovids', j_lost: 'maybe-pending' })
    expect(r.skipped.find((s) => s.jobId === 'j_lost')?.pendingTakeId).toBe('take_lost')
  })
})

describe('sentMayOwn: a job an unanswered POST may have made is never offered (no client_request_id in the list)', () => {
  const rec = { projectId: P, nodeId: node('s2'), at: T }
  const may = (over: Partial<CanvasJob>, r: typeof rec & { before?: string[] } = rec) => sentMayOwn(job(over), 'take_lost', r, P, false)

  it('same node, around the POST → reserved; far before / after, another node, listed before, another project → not', () => {
    expect(may({ created_at: new Date(T + 5000).toISOString() })).toBe(true)
    expect(may({ created_at: new Date(T - CREATED_SKEW_MS + 1000).toISOString() })).toBe(true)
    expect(may({ created_at: new Date(T + CREATED_SKEW_MS + POST_WINDOW_MS - 1000).toISOString() })).toBe(true)
    expect(may({ created_at: new Date(T - 20 * 3600_000).toISOString() })).toBe(false)
    expect(may({ created_at: new Date(T + 20 * 3600_000).toISOString() })).toBe(false)
    expect(may({ canvas_node_id: node('s1') })).toBe(false)
    expect(may({}, { ...rec, before: ['job1'] })).toBe(false)
    expect(sentMayOwn(job(), 'take_lost', rec, 'proj2', false)).toBe(false)
  })

  it('an unknown creation time → reserved (it could be)', () => {
    expect(may({ created_at: undefined })).toBe(true)
    expect(may({ created_at: 'not a date' })).toBe(true)
  })

  it('the scan holds such a job back as maybe-pending, naming the take; a POST whose job is known reserves nothing', () => {
    const { skipped, r } = codes([job()], ctx({ ledger: { jobs: {}, sent: { take_lost: rec }, imported: {} } }))
    expect(skipped).toEqual({ job1: 'maybe-pending' })
    expect(r.skipped[0].pendingTakeId).toBe('take_lost')
    const settled = codes([job()], ctx({ ledger: { jobs: { take_lost: { remoteId: encodeRemoteId(P, 'other') } }, sent: { take_lost: rec }, imported: {} } }))
    expect(settled.ok).toEqual(['job1'])
  })
})

// ---------------------------------------------------------------------------------------------

const entry = (over: Partial<BridgeEntry> = {}): BridgeEntry => ({
  sceneId: sceneNodeKey('prjA', 's2'),
  model: 'seedance_2_5',
  mode: 't2v',
  duration: 15,
  resolution: '1080p',
  ratio: '16:9',
  prompt: '@image_1 đi dạo',
  uploadIds: ['up_e', 'up_l'],
  firstFrameUploadId: null,
  lastFrameUploadId: null,
  usedAt: 1,
  ...over,
})
const IMAGES: Record<string, string> = { up_e: 'img_e1', up_l: 'img_l2', up_v: 'img_v1' }
const imageOfUpload = (u: string) => IMAGES[u] ?? null
const ASSETS: Record<string, string> = { img_e1: 'elara', img_l2: 'lumi', img_v1: 'village' }
const assetOf = (imageId: string) => ASSETS[imageId] ?? null

describe('hints: the node the job was likely made from', () => {
  it('canvasHintFor reads a bridge canvas exactly as canvasPayload() writes it (references in order → image ids)', () => {
    const canvas = bridgeCanvas([entry()])
    const h = canvasHintFor(canvas, node('s2'), imageOfUpload)
    expect(h).toEqual({
      source: 'canvas',
      model: 'seedance_2_5',
      mode: 't2v',
      duration: 15,
      resolution: '1080p',
      ratio: '16:9',
      prompt: '@image_1 đi dạo',
      refImages: ['img_e1', 'img_l2'],
      frames: null,
    })
    // H3 transform: frames by their handle
    const t = bridgeCanvas([entry({ model: 'minimax_h3', mode: 'transform', resolution: '768p', ratio: '', duration: 5, uploadIds: [], firstFrameUploadId: 'up_e', lastFrameUploadId: 'up_v' })])
    expect(canvasHintFor(t, node('s2'), imageOfUpload)).toMatchObject({ mode: 'transform', ratio: null, refImages: [], frames: { first: 'img_e1', last: 'img_v1' } })
  })

  it('junk, an image node, a node without its data keys, an unknown model or mode → null (never throws)', () => {
    const canvas = bridgeCanvas([entry()]) as unknown as { nodes: { id: string; type: string; data: Record<string, unknown> }[] }
    expect(canvasHintFor(null, node('s2'), imageOfUpload)).toBeNull()
    expect(canvasHintFor({ nodes: 'x' }, node('s2'), imageOfUpload)).toBeNull()
    const image = canvas.nodes.find((n) => n.type === 'images')!
    expect(canvasHintFor(canvas, image.id, imageOfUpload)).toBeNull()
    const broken = JSON.parse(JSON.stringify(canvas)) as typeof canvas
    delete broken.nodes.find((n) => n.type === 'video')!.data.prompt
    expect(canvasHintFor(broken, node('s2'), imageOfUpload)).toBeNull()
    const veo = JSON.parse(JSON.stringify(canvas)) as typeof canvas
    veo.nodes.find((n) => n.type === 'video')!.data.model_profile = 'veo_3'
    expect(canvasHintFor(veo, node('s2'), imageOfUpload)).toBeNull()
    const i2v = JSON.parse(JSON.stringify(canvas)) as typeof canvas
    i2v.nodes.find((n) => n.type === 'video')!.data.mode = 'i2v' // Seedance has no i2v
    expect(canvasHintFor(i2v, node('s2'), imageOfUpload)).toBeNull()
  })

  it('hintsFor: the canvas first, then SanoVids’ own entry of that node; an unknown upload maps to null', () => {
    const hints = hintsFor(node('s2'), bridgeCanvas([entry()]), { [sceneNodeKey('prjA', 's2')]: entry({ uploadIds: ['up_e', 'up_x'] }) }, imageOfUpload)
    expect(hints.map((h) => h.source)).toEqual(['canvas', 'entry'])
    expect(hints[1].refImages).toEqual(['img_e1', null])
    expect(hintsFor(node('s1'), null, {}, imageOfUpload)).toEqual([])
    expect(entryHint(entry({ resolution: '1080P' }), imageOfUpload).resolution).toBe('1080p')
  })

  it('hintMatches: the trimmed prompt, model, duration and ratio must agree (mode / resolution too when listed)', () => {
    const h = canvasHintFor(bridgeCanvas([entry()]), node('s2'), imageOfUpload)!
    expect(hintMatches(h, job(), '  @image_1 đi dạo ')).toBe(true)
    expect(hintMatches(h, job(), null)).toBe(false)
    expect(hintMatches(h, job(), '@image_1 chạy')).toBe(false)
    expect(hintMatches(h, job({ duration: 5 }), '@image_1 đi dạo')).toBe(false)
    expect(hintMatches(h, job({ aspect_ratio: '9:16' }), '@image_1 đi dạo')).toBe(false)
    expect(hintMatches(h, job({ aspect_ratio: undefined }), '@image_1 đi dạo')).toBe(true)
    expect(hintMatches(h, job({ aspect_ratio: null as unknown as string }), '@image_1 đi dạo')).toBe(false) // only a transform has none
    expect(hintMatches(h, job({ model_profile: 'minimax_h3' }), '@image_1 đi dạo')).toBe(false)
    expect(hintMatches(h, job({ resolution: '720p' }), '@image_1 đi dạo')).toBe(false)
    expect(hintMatches(h, job({ resolution: '1080P' }), '@image_1 đi dạo')).toBe(true)
  })
})

describe('reconstructSiteJob: what the imported take records', () => {
  const cand = (over: Partial<SiteJobCandidate> = {}, hints: SiteJobHint[] = []): SiteJobCandidate => {
    const j = over.job ?? job()
    return {
      jobId: j.job_id,
      remoteId: encodeRemoteId(P, j.job_id),
      nodeId: node('s2'),
      sceneId: 's2',
      job: j,
      jobName: 'Video 1',
      state: 'processing',
      progress: 40,
      createdAt: T,
      model: 'seedance_2_5',
      duration: 15,
      ratio: '16:9',
      reimport: false,
      hints,
      ...over,
    }
  }
  const canvasHint = (e: Partial<BridgeEntry> = {}) => canvasHintFor(bridgeCanvas([entry(e)]), node('s2'), imageOfUpload)!

  it('a matching canvas hint: resolution and references inferred (image keys in @image order), Seedance’s one mode known', () => {
    const d = reconstructSiteJob(cand({}, [canvasHint()]), '@image_1 đi dạo', assetOf)
    expect(d.settings).toEqual({ model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' })
    expect(d.unknown).toEqual([])
    expect(d.inferred).toEqual(['resolution', 'refs'])
    expect(d.refs).toEqual(['elara', 'lumi'])
    expect(d.imageKeys).toEqual(['elara:img_e1', 'lumi:img_l2'])
    expect(d).toMatchObject({ prompt: '@image_1 đi dạo', cost: 20, hint: 'canvas', progress: 40 })
  })

  it('the prompt matches neither hint: resolution and references unknown (placeholder, cost 0)', () => {
    const d = reconstructSiteJob(cand({}, [canvasHint(), entryHint(entry(), imageOfUpload)]), 'một prompt khác', assetOf)
    expect(d.unknown).toEqual(['resolution', 'refs'])
    expect(d.inferred).toEqual([])
    expect(d.settings.resolution).toBe('480p')
    expect(d).toMatchObject({ cost: 0, hint: null, refs: [], imageKeys: [], prompt: 'một prompt khác' })
  })

  it('the canvas changed since, SanoVids’ entry still matches → inferred from the entry', () => {
    const d = reconstructSiteJob(cand({}, [canvasHint({ prompt: 'đã sửa' }), entryHint(entry({ resolution: '720p' }), imageOfUpload)]), '@image_1 đi dạo', assetOf)
    expect(d).toMatchObject({ hint: 'entry', cost: 15 })
    expect(d.settings.resolution).toBe('720p')
  })

  it('no prompt (unreadable): prompt unknown, no hint can match', () => {
    const d = reconstructSiteJob(cand({}, [canvasHint()]), null, assetOf)
    expect(d.unknown).toEqual(['resolution', 'prompt', 'refs'])
    expect(d.prompt).toBe('')
  })

  it('one picture SanoVids cannot map (upload or asset unknown) → references unknown, the rest still inferred', () => {
    const d = reconstructSiteJob(cand({}, [canvasHint({ uploadIds: ['up_e', 'up_x'] })]), '@image_1 đi dạo', assetOf)
    expect(d.unknown).toEqual(['refs'])
    expect(d.inferred).toEqual(['resolution'])
    const gone = reconstructSiteJob(cand({}, [canvasHint()]), '@image_1 đi dạo', (img) => (img === 'img_l2' ? null : assetOf(img)))
    expect(gone.unknown).toEqual(['refs'])
  })

  it('MiniMax-H3: no ratio and no hint → transform inferred; a ratio and no hint → mode unknown; the list may tell mode / resolution', () => {
    const h3 = (over: Partial<CanvasJob>) => cand({ model: 'minimax_h3', duration: 5, ratio: typeof over.aspect_ratio === 'string' ? over.aspect_ratio : null, job: job({ model_profile: 'minimax_h3', duration: 5, ...over }) })
    const t = reconstructSiteJob(h3({ aspect_ratio: null as unknown as string }), 'biến hình', assetOf)
    expect(t.settings.mode).toBe('transform')
    expect(t.inferred).toEqual(['mode'])
    expect(t.unknown).toEqual(['resolution', 'ratio', 'refs'])
    const u = reconstructSiteJob(h3({ aspect_ratio: '16:9' }), 'đi dạo', assetOf)
    expect(u.unknown).toEqual(['mode', 'resolution', 'refs'])
    const listed = reconstructSiteJob(h3({ aspect_ratio: '16:9', mode: 't2v', resolution: '2K' }), 'đi dạo', assetOf)
    expect(listed.settings).toMatchObject({ mode: 't2v', resolution: '2k' })
    expect(listed.unknown).toEqual([]) // H3 t2v sends no picture: no references, for sure
    expect(listed.refs).toEqual([])
    expect(listed.cost).toBe(6)
  })

  it('H3 transform hint: the frames become the frames snapshot (inferred), no references', () => {
    const h = canvasHintFor(
      bridgeCanvas([entry({ model: 'minimax_h3', mode: 'transform', resolution: '2k', ratio: '', duration: 5, uploadIds: [], firstFrameUploadId: 'up_e', lastFrameUploadId: 'up_v', prompt: 'biến hình' })]),
      node('s2'),
      imageOfUpload,
    )!
    const d = reconstructSiteJob(cand({ model: 'minimax_h3', duration: 5, ratio: null, job: job({ model_profile: 'minimax_h3', duration: 5, aspect_ratio: null as unknown as string }) }, [h]), 'biến hình', assetOf)
    expect(d.settings).toMatchObject({ mode: 'transform', resolution: '2k' })
    expect(d.frames).toEqual({ first: 'elara:img_e1', last: 'village:img_v1' })
    expect(d.refs).toEqual([])
    expect(d.inferred).toEqual(['mode', 'resolution', 'refs'])
    expect(d.unknown).toEqual(['ratio'])
  })

  it('a finished job shows 99 % until downloaded; a queued one at least 1 %', () => {
    expect(reconstructSiteJob(cand({ state: 'completed', progress: 100 }), null, assetOf).progress).toBe(99)
    expect(reconstructSiteJob(cand({ state: 'queued', progress: null }), null, assetOf).progress).toBe(1)
  })

  it('a duration SanoVids does not offer → unknown (cost unknown too)', () => {
    const d = reconstructSiteJob(cand({ duration: 20, job: job({ duration: 20 }) }), 'x', assetOf)
    expect(d.unknown).toContain('duration')
    expect(d.cost).toBe(0)
  })
})

describe('normalizeImportPrompt', () => {
  it('empty, blank, not text or longer than canvasapp allows → unknown (null)', () => {
    expect(normalizeImportPrompt('@image_1 đi')).toBe('@image_1 đi')
    expect(normalizeImportPrompt('')).toBeNull()
    expect(normalizeImportPrompt('   ')).toBeNull()
    expect(normalizeImportPrompt(undefined)).toBeNull()
    expect(normalizeImportPrompt(42)).toBeNull()
    expect(normalizeImportPrompt('x'.repeat(MAX_IMPORT_PROMPT + 1))).toBeNull()
  })
})

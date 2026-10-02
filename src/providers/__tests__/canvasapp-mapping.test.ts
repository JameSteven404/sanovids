import { describe, expect, it } from 'vitest'
import {
  bridgeCanvas,
  canvasNodeId,
  decodeRemoteId,
  encodeRemoteId,
  entryFromRequest,
  imagesToUpload,
  jobIdFromCreateResponse,
  mapJobStatus,
  MAX_BRIDGE_NODES,
  ORDER_BASE,
  promptLimitOf,
  toVideoJobBody,
  validateRequest,
  type BridgeEntry,
} from '../canvasapp/mapping'
import type { JobRequest } from '../types'

const req = (over: Partial<JobRequest> = {}): JobRequest => ({
  key: 'take_1',
  takeId: 'take_1',
  sceneId: 'scene_a',
  sceneCode: 'S01',
  takeNumber: 1,
  title: 'Mở đầu',
  color: '#fff',
  model: 'seedance_2_5',
  mode: 't2v',
  duration: 15,
  resolution: '1080p',
  ratio: '16:9',
  prompt: '@image_1 walks to @image_2',
  rawPrompt: '@image_1 walks to @image_2',
  images: [
    { n: 2, assetId: 'b', imageId: 'img_b' },
    { n: 1, assetId: 'a', imageId: 'img_a' },
  ],
  videos: [],
  firstFrame: null,
  lastFrame: null,
  startedAt: 0,
  ...over,
})

const uploads: Record<string, string> = { img_a: 'up_a', img_b: 'up_b', img_f: 'up_f', img_l: 'up_l' }
const uploadIdFor = (id: string) => uploads[id]

describe('canvasapp mapping: job body', () => {
  it('maps a Seedance request with upload_ids in @image_N order and the take id as client_request_id', () => {
    const body = toVideoJobBody(req(), { projectId: 'proj1', uploadIdFor })
    expect(body).toEqual({
      project_id: 'proj1',
      model_profile: 'seedance_2_5',
      canvas_node_id: canvasNodeId('scene_a'),
      prompt: '@image_1 walks to @image_2',
      mode: 't2v',
      duration: 15,
      resolution: '1080p',
      generate_audio: true,
      upload_ids: ['up_a', 'up_b'],
      aspect_ratio: '16:9',
      client_request_id: 'take_1',
    })
  })

  it('maps H3 transform frames and sends no reference uploads', () => {
    const r = req({
      model: 'minimax_h3',
      mode: 'transform',
      resolution: '768p',
      duration: 10,
      images: [],
      firstFrame: { assetId: 'f', imageId: 'img_f' },
      lastFrame: { assetId: 'l', imageId: 'img_l' },
    })
    const body = toVideoJobBody(r, { projectId: 'p', uploadIdFor, generateAudio: false })
    expect(body.upload_ids).toEqual([])
    expect(body.first_frame_upload_id).toBe('up_f')
    expect(body.last_frame_upload_id).toBe('up_l')
    expect(body.generate_audio).toBe(false)
    expect(body.model_profile).toBe('minimax_h3')
    expect(imagesToUpload(r)).toEqual(['img_f', 'img_l'])
  })

  it('lists images to upload in order without duplicates', () => {
    const r = req({ images: [{ n: 1, assetId: 'a', imageId: 'x' }, { n: 2, assetId: 'a', imageId: 'x' }, { n: 3, assetId: 'b', imageId: 'y' }] })
    expect(imagesToUpload(r)).toEqual(['x', 'y'])
  })

  it('builds safe canvas node ids', () => {
    expect(canvasNodeId('scene_a')).toBe('sv_scene_a')
    expect(canvasNodeId('a b/c')).toMatch(/^sv_[A-Za-z0-9_-]+$/)
  })
})

describe('canvasapp mapping: validation', () => {
  it('rejects reference videos, empty prompts and missing frames', () => {
    expect(validateRequest(req())).toEqual([])
    expect(validateRequest(req({ videos: [{ n: 1, takeId: 't', videoId: 'v', posterId: null }] })).join(' ')).toMatch(/video tham chiếu/)
    expect(validateRequest(req({ prompt: '  ' })).join(' ')).toMatch(/Prompt trống/)
    expect(validateRequest(req({ model: 'minimax_h3', mode: 'transform', images: [] })).join(' ')).toMatch(/khung đầu/)
    expect(validateRequest(req({ model: 'minimax_h3', mode: 'i2v', images: [] })).join(' ')).toMatch(/ít nhất 1 ảnh/)
  })

  it('applies canvasapp prompt limits (H3 t2v/i2v 7.000)', () => {
    expect(promptLimitOf('minimax_h3', 't2v')).toBe(7000)
    expect(promptLimitOf('minimax_h3', 'transform')).toBe(20000)
    expect(validateRequest(req({ model: 'minimax_h3', prompt: 'x'.repeat(7001), images: [] })).join(' ')).toMatch(/7\.000/)
  })

  it('checks options from /api/video-profiles when known', () => {
    const profiles = [{ model_profile: 'seedance_2_5', display_name: 'Seedance 2.5', options: { durations: [5, 10], resolutions: ['720p'], aspect_ratios: ['16:9'] } }]
    const problems = validateRequest(req(), profiles)
    expect(problems.some((p) => p.includes('15s'))).toBe(true)
    expect(problems.some((p) => p.includes('1080p'))).toBe(true)
    expect(validateRequest(req({ model: 'minimax_h3', images: [] }), profiles).join(' ')).toMatch(/không có model/)
  })
})

describe('canvasapp mapping: status + ids', () => {
  it('maps job statuses', () => {
    expect(mapJobStatus('r', { job_id: 'j', status: 'queued' })).toEqual({ remoteId: 'r', state: 'queued', progress: undefined })
    expect(mapJobStatus('r', { job_id: 'j', status: 'processing', progress: 42.4 })).toEqual({ remoteId: 'r', state: 'processing', progress: 42 })
    expect(mapJobStatus('r', { job_id: 'j', status: 'completed', download_available: true }).state).toBe('completed')
    expect(mapJobStatus('r', { job_id: 'j', status: 'completed', download_available: false })).toEqual({ remoteId: 'r', state: 'processing', progress: 99 })
    const failed = mapJobStatus('r', { job_id: 'j', status: 'failed', error_message: 'NSFW' })
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('NSFW')
    expect(mapJobStatus('r', { job_id: 'j', status: 'expired' }).state).toBe('failed')
    expect(mapJobStatus('r', { job_id: 'j', status: 'cancelled' }).state).toBe('cancelled')
    expect(mapJobStatus('r', { job_id: 'j', status: 'weird' }).state).toBe('processing')
  })

  it('encodes and decodes remote ids', () => {
    expect(decodeRemoteId(encodeRemoteId('p1', 'j1'))).toEqual({ projectId: 'p1', jobId: 'j1' })
    expect(decodeRemoteId('nocolon')).toBeNull()
    expect(decodeRemoteId(':j')).toBeNull()
  })

  it('reads the job id from several create-response shapes', () => {
    expect(jobIdFromCreateResponse({ job_id: 'a' })).toBe('a')
    expect(jobIdFromCreateResponse({ job: { job_id: 'b' } })).toBe('b')
    expect(jobIdFromCreateResponse({ id: 'c' })).toBe('c')
    expect(jobIdFromCreateResponse({})).toBeNull()
    expect(jobIdFromCreateResponse(null)).toBeNull()
  })
})

describe('canvasapp mapping: bridge canvas', () => {
  it('creates one video node per scene with image nodes wired in @image order', () => {
    const entry = entryFromRequest(req(), uploadIdFor, 10)
    const canvas = bridgeCanvas([entry])
    const vid = canvasNodeId('scene_a')
    expect(canvas.nodes.filter((n) => n.type === 'video').map((n) => n.id)).toEqual([vid])
    const video = canvas.nodes.find((n) => n.id === vid)!
    expect(video.data).toMatchObject({ model_profile: 'seedance_2_5', duration: 15, resolution: '1080p', aspect_ratio: '16:9', mode: 't2v' })
    const imgs = canvas.nodes.filter((n) => n.type === 'images')
    expect(imgs.map((n) => n.data.upload_ids)).toEqual([['up_a'], ['up_b']])
    expect(canvas.connections).toEqual([
      { from: imgs[0].id, to: vid, target_handle: 'reference', order: ORDER_BASE },
      { from: imgs[1].id, to: vid, target_handle: 'reference', order: ORDER_BASE + 1 },
    ])
    // every connection points at existing nodes, ids are unique
    const ids = new Set(canvas.nodes.map((n) => n.id))
    expect(ids.size).toBe(canvas.nodes.length)
    for (const c of canvas.connections) expect(ids.has(c.from) && ids.has(c.to)).toBe(true)
  })

  it('wires transform frames to first_frame / last_frame', () => {
    const r = req({ model: 'minimax_h3', mode: 'transform', images: [], firstFrame: { assetId: 'f', imageId: 'img_f' }, lastFrame: { assetId: 'l', imageId: 'img_l' } })
    const canvas = bridgeCanvas([entryFromRequest(r, uploadIdFor, 1)])
    expect(canvas.connections.map((c) => c.target_handle)).toEqual(['first_frame', 'last_frame'])
  })

  it('keeps the newest scenes within the 40-node limit', () => {
    const entry = (i: number): BridgeEntry => ({
      ...entryFromRequest(req({ sceneId: 's' + i }), uploadIdFor, i),
      uploadIds: Array.from({ length: 9 }, (_, k) => `u${i}_${k}`),
    })
    const canvas = bridgeCanvas([entry(1), entry(2), entry(3), entry(4), entry(5)])
    expect(canvas.nodes.length).toBeLessThanOrEqual(MAX_BRIDGE_NODES)
    const videos = canvas.nodes.filter((n) => n.type === 'video').map((n) => n.id)
    expect(videos).toEqual(['sv_s5', 'sv_s4', 'sv_s3', 'sv_s2'])
  })
})

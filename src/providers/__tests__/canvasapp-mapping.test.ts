import { describe, expect, it } from 'vitest'
import type { CanvasImageNode, CanvasVideoNode } from '../canvasapp/api'
import {
  bridgeCanvas,
  bridgeEntriesFrom,
  canvasNodeId,
  clientRequestIdFor,
  decodeRemoteId,
  encodeRemoteId,
  entryFromRequest,
  FIRST_FRAME_ORDER,
  imageNodeId,
  imagesToUpload,
  inputShapeOf,
  isUuid,
  jobIdFromCreateResponse,
  LAST_FRAME_ORDER,
  mapJobStatus,
  MAX_BRIDGE_IMAGES,
  MAX_BRIDGE_NODES,
  MAX_BRIDGE_PROMPT_CHARS,
  ORDER_BASE,
  PROFILE_FALLBACKS,
  profileSpecOf,
  promptLimitOf,
  ratioFromDimensions,
  toVideoJobBody,
  transformFrameRatio,
  uuidFromKey,
  validateRequest,
  VIDEO_NODE_H,
  VIDEO_NODE_W,
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

const h3Transform = (over: Partial<JobRequest> = {}) =>
  req({
    model: 'minimax_h3',
    mode: 'transform',
    resolution: '768p',
    duration: 10,
    images: [],
    firstFrame: { assetId: 'f', imageId: 'img_f' },
    lastFrame: { assetId: 'l', imageId: 'img_l' },
    ...over,
  })

const uploads: Record<string, string> = { img_a: 'up_a', img_b: 'up_b', img_f: 'up_f', img_l: 'up_l' }
const uploadIdFor = (id: string) => uploads[id]

// Key sets of canvasapp's own client (/static/canvas.js), in its order.
const JOB_BASE_KEYS = ['project_id', 'model_profile', 'canvas_node_id', 'prompt', 'mode', 'duration', 'resolution', 'generate_audio']
const JOB_REFS_KEYS = [...JOB_BASE_KEYS, 'upload_ids', 'aspect_ratio', 'client_request_id']
const JOB_FRAMES_KEYS = [...JOB_BASE_KEYS, 'first_frame_upload_id', 'last_frame_upload_id', 'client_request_id']
const CANVAS_KEYS = ['nodes', 'connections', 'viewport']
const VIEWPORT_KEYS = ['zoom', 'scrollLeft', 'scrollTop']
const VIDEO_NODE_KEYS = ['id', 'type', 'x', 'y', 'w', 'h', 'data']
const VIDEO_DATA_KEYS = ['model_profile', 'duration', 'resolution', 'aspect_ratio', 'mode', 'prompt']
const IMAGE_NODE_KEYS = ['id', 'type', 'x', 'y', 'data']
const IMAGE_DATA_KEYS = ['upload_ids']
const CONNECTION_KEYS = ['from', 'to', 'target_handle', 'order']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Every key of a canvas payload is one the client's canvasPayload() writes; ids UUIDs; coordinates integers. */
function expectClientCanvasShape(canvas: ReturnType<typeof bridgeCanvas>) {
  expect(Object.keys(canvas)).toEqual(CANVAS_KEYS)
  expect(Object.keys(canvas.viewport)).toEqual(VIEWPORT_KEYS)
  expect(canvas.viewport).toEqual({ zoom: 1, scrollLeft: 0, scrollTop: 0 })
  for (const n of canvas.nodes) {
    expect(n.id).toMatch(UUID_RE)
    expect(Number.isInteger(n.x) && Number.isInteger(n.y) && n.x >= 0 && n.y >= 0).toBe(true)
    if (n.type === 'video') {
      expect(Object.keys(n)).toEqual(VIDEO_NODE_KEYS)
      expect(Object.keys(n.data)).toEqual(VIDEO_DATA_KEYS)
      expect([n.w, n.h]).toEqual([VIDEO_NODE_W, VIDEO_NODE_H])
      expect(typeof n.data.duration).toBe('number')
      expect(n.data.resolution).toBe(n.data.resolution.toLowerCase())
      expect(n.data.aspect_ratio === null ? n.data.mode : 'ok').toMatch(/^(transform|ok)$/)
    } else {
      expect(n.type).toBe('images')
      expect(Object.keys(n)).toEqual(IMAGE_NODE_KEYS)
      expect(Object.keys(n.data)).toEqual(IMAGE_DATA_KEYS)
      expect(n.data.upload_ids).toHaveLength(1)
    }
  }
  const ids = new Set(canvas.nodes.map((n) => n.id))
  expect(ids.size).toBe(canvas.nodes.length)
  for (const c of canvas.connections) {
    expect(Object.keys(c)).toEqual(CONNECTION_KEYS)
    expect(ids.has(c.from) && ids.has(c.to)).toBe(true)
    expect(Number.isInteger(c.order) && c.order >= 1).toBe(true)
  }
}

const videoNodes = (c: ReturnType<typeof bridgeCanvas>) => c.nodes.filter((n): n is CanvasVideoNode => n.type === 'video')
const imageNodes = (c: ReturnType<typeof bridgeCanvas>) => c.nodes.filter((n): n is CanvasImageNode => n.type === 'images')

describe('canvasapp mapping: ids', () => {
  it('uuidFromKey: RFC 4122 v4 format, deterministic, pinned (a changed hash would change every take’s client_request_id)', () => {
    expect(uuidFromKey('')).toBe('027ae52e-cfc7-4621-9593-990d4b41437c')
    expect(uuidFromKey('sanovids')).toBe('407822d1-ff74-44a5-b939-9e563102e770')
    expect(uuidFromKey('Tiếng Việt 🎬')).toBe('3f98c97f-5460-4a69-8cd8-a53160121e88')
    expect(uuidFromKey('sanovids')).toBe(uuidFromKey('sanovids'))
    const many = Array.from({ length: 2000 }, (_, i) => uuidFromKey('k' + i))
    expect(many.every((u) => UUID_RE.test(u) && isUuid(u))).toBe(true)
    expect(new Set(many).size).toBe(many.length)
  })

  it('canvas node ids: a UUID per scene, stable; image node ids per (upload, occurrence); request ids per take', () => {
    expect(canvasNodeId('scene_a')).toBe('9a920dad-11ec-4ca1-a90e-f2aa21a28ab5')
    expect(canvasNodeId('scene_a')).toBe(canvasNodeId('scene_a'))
    expect(canvasNodeId('scene_b')).not.toBe(canvasNodeId('scene_a'))
    expect(canvasNodeId('a b/c')).toMatch(UUID_RE)
    expect(imageNodeId('up_a')).toMatch(UUID_RE)
    expect(imageNodeId('up_a')).toBe(imageNodeId('up_a', 0))
    expect(new Set([imageNodeId('up_a'), imageNodeId('up_a', 1), imageNodeId('up_b'), canvasNodeId('up_a'), clientRequestIdFor('up_a')]).size).toBe(5)
    expect(clientRequestIdFor('take_1')).toBe('e37a8e85-3e31-47ab-8e31-54b798302a3f')
    expect(clientRequestIdFor('take_1')).toBe(clientRequestIdFor('take_1'))
    expect(clientRequestIdFor('take_2')).not.toBe(clientRequestIdFor('take_1'))
    // separate namespaces: a scene and a take with the same id never share a UUID
    expect(clientRequestIdFor('x')).not.toBe(canvasNodeId('x'))
  })
})

describe('canvasapp mapping: job body (runVideoNode shape)', () => {
  it('Seedance: upload_ids in @image_N order + aspect_ratio, client_request_id = UUID of the take id, exactly the client’s keys', () => {
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
      client_request_id: clientRequestIdFor('take_1'),
    })
    expect(Object.keys(body)).toEqual(JOB_REFS_KEYS)
    expect(body.client_request_id).toMatch(UUID_RE)
    expect(body.canvas_node_id).toMatch(UUID_RE)
    // same take → same key (a retry never looks like a new request)
    expect(toVideoJobBody(req(), { projectId: 'proj1', uploadIdFor })).toEqual(body)
    expect(toVideoJobBody(req({ key: 'take_2', takeId: 'take_2' }), { projectId: 'proj1', uploadIdFor }).client_request_id).not.toBe(body.client_request_id)
  })

  it('the first real test (Seedance 2.5 · t2v · 30 s · 480p · 16:9 · one reference): body and canvas in the client’s shape', () => {
    const r = req({ duration: 30, resolution: '480p', prompt: '@image_1 đi dạo', images: [{ n: 1, assetId: 'a', imageId: 'img_a' }] })
    const body = toVideoJobBody(r, { projectId: 'p', uploadIdFor })
    expect(Object.keys(body)).toEqual(JOB_REFS_KEYS)
    expect(body).toMatchObject({ mode: 't2v', duration: 30, resolution: '480p', upload_ids: ['up_a'], aspect_ratio: '16:9' })
    const canvas = bridgeCanvas([entryFromRequest(r, uploadIdFor, 1)])
    expectClientCanvasShape(canvas)
    const [video] = videoNodes(canvas)
    expect(video.data).toEqual({ model_profile: 'seedance_2_5', duration: 30, resolution: '480p', aspect_ratio: '16:9', mode: 't2v', prompt: '@image_1 đi dạo' })
    const [img] = imageNodes(canvas)
    expect(img.data).toEqual({ upload_ids: ['up_a'] })
    expect(canvas.connections).toEqual([{ from: img.id, to: video.id, target_handle: 'reference', order: 1 }])
    expect(video.id).toBe(body.canvas_node_id)
  })

  it('H3 transform: first/last frame uploads only — no upload_ids, no aspect_ratio', () => {
    const r = h3Transform()
    const body = toVideoJobBody(r, { projectId: 'p', uploadIdFor, generateAudio: false })
    expect(Object.keys(body)).toEqual(JOB_FRAMES_KEYS)
    expect(body).not.toHaveProperty('upload_ids')
    expect(body).not.toHaveProperty('aspect_ratio')
    expect(body.first_frame_upload_id).toBe('up_f')
    expect(body.last_frame_upload_id).toBe('up_l')
    expect(body.generate_audio).toBe(false)
    expect(body.model_profile).toBe('minimax_h3')
    expect(imagesToUpload(r)).toEqual(['img_f', 'img_l'])
  })

  it('H3 t2v: upload_ids [] + aspect_ratio, even when the request carries images (none is uploaded)', () => {
    const r = req({ model: 'minimax_h3', mode: 't2v', resolution: '768p', duration: 5 })
    const body = toVideoJobBody(r, { projectId: 'p', uploadIdFor })
    expect(Object.keys(body)).toEqual(JOB_REFS_KEYS)
    expect(body.upload_ids).toEqual([])
    expect(body.aspect_ratio).toBe('16:9')
    expect(imagesToUpload(r)).toEqual([])
  })

  it('H3 i2v: upload_ids in @image_N order + aspect_ratio', () => {
    const r = req({ model: 'minimax_h3', mode: 'i2v', resolution: '2k', duration: 5, ratio: '9:16' })
    const body = toVideoJobBody(r, { projectId: 'p', uploadIdFor })
    expect(Object.keys(body)).toEqual(JOB_REFS_KEYS)
    expect(body).toMatchObject({ upload_ids: ['up_a', 'up_b'], aspect_ratio: '9:16', resolution: '2k' })
  })

  it('input shapes follow runVideoNode / normalizeConnections', () => {
    expect(inputShapeOf('seedance_2_5', 't2v')).toBe('refs')
    expect(inputShapeOf('minimax_h3', 'i2v')).toBe('refs')
    expect(inputShapeOf('minimax_h3', 'transform')).toBe('frames')
    expect(inputShapeOf('minimax_h3', 't2v')).toBe('none')
  })

  it('prompt trimmed at both ends only (inner text and @image tokens untouched); resolution lower-cased', () => {
    const body = toVideoJobBody(req({ prompt: '  \n@image_1  walks\n\nto @image_2 \t', resolution: '2K', model: 'minimax_h3', mode: 'i2v' }), { projectId: 'p', uploadIdFor })
    expect(body.prompt).toBe('@image_1  walks\n\nto @image_2')
    expect(body.resolution).toBe('2k')
  })

  it('lists images to upload in order without duplicates', () => {
    const r = req({ images: [{ n: 1, assetId: 'a', imageId: 'x' }, { n: 2, assetId: 'a', imageId: 'x' }, { n: 3, assetId: 'b', imageId: 'y' }] })
    expect(imagesToUpload(r)).toEqual(['x', 'y'])
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

  it('applies canvasapp prompt limits (H3 t2v/i2v 7.000) to the trimmed prompt', () => {
    expect(promptLimitOf('minimax_h3', 't2v')).toBe(7000)
    expect(promptLimitOf('minimax_h3', 'transform')).toBe(20000)
    expect(validateRequest(req({ model: 'minimax_h3', prompt: 'x'.repeat(7001), images: [] })).join(' ')).toMatch(/7\.000/)
    expect(validateRequest(req({ model: 'minimax_h3', prompt: '  ' + 'x'.repeat(7000) + '\n\n', images: [] }))).toEqual([])
  })

  it('checks options from /api/video-profiles when known (resolutions compared lower-cased)', () => {
    const profiles = [{ model_profile: 'seedance_2_5', display_name: 'Seedance 2.5', options: { durations: [5, 10], resolutions: ['720p'], aspect_ratios: ['16:9'] } }]
    const problems = validateRequest(req(), profiles)
    expect(problems.some((p) => p.includes('15s'))).toBe(true)
    expect(problems.some((p) => p.includes('1080p'))).toBe(true)
    // a model missing from the list gets the client's fallback: MiniMax-H3 locked
    expect(validateRequest(req({ model: 'minimax_h3', images: [] }), profiles).join(' ')).toMatch(/MiniMax-H3 hiện không khả dụng/)
    const h3 = [{ model_profile: 'minimax_h3', can_create: true, options: { resolutions: ['768p', '2k'] } }]
    expect(validateRequest(req({ model: 'minimax_h3', mode: 'i2v', resolution: '2K' }), h3)).toEqual([])
    // the client reads a missing can_create of MiniMax-H3 as false
    expect(validateRequest(req({ model: 'minimax_h3', mode: 'i2v', resolution: '2K' }), [{ model_profile: 'minimax_h3' }]).join(' ')).toMatch(/không khả dụng/)
  })

  it('profiles unreadable ([]) → canvasapp’s fallbacks, like its client: Seedance runs, MiniMax-H3 locked and transform off', () => {
    expect(validateRequest(req(), [])).toEqual([])
    expect(validateRequest(req({ duration: 30, resolution: '480p' }), [])).toEqual([])
    const h3 = validateRequest(h3Transform(), []).join(' ')
    expect(h3).toMatch(/MiniMax-H3 hiện không khả dụng/)
    expect(h3).toMatch(/tạm ngừng/)
    // not known at all (null) → no profile check
    expect(validateRequest(h3Transform(), null)).toEqual([])
  })

  it('runVideoNode gates: can_create false and a disabled mode are refused; `enabled` alone is not (the client ignores it)', () => {
    const h3 = (over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) => [
      { model_profile: 'minimax_h3', display_name: 'MiniMax-H3', enabled: true, can_create: true, ...over, options: { disabled_modes: [], ...options } },
    ]
    const i2v = req({ model: 'minimax_h3', mode: 'i2v', resolution: '768p', duration: 5 })
    expect(validateRequest(i2v, h3())).toEqual([])
    expect(validateRequest(i2v, h3({ enabled: false }))).toEqual([])
    expect(validateRequest(i2v, h3({ can_create: false })).join(' ')).toMatch(/MiniMax-H3 hiện không khả dụng/)
    expect(validateRequest(i2v, h3({}, { disabled_modes: ['i2v'] })).join(' ')).toMatch(/Ảnh → Video hiện tạm ngừng/)
    expect(validateRequest(h3Transform({ duration: 5 }), h3({}, { disabled_modes: ['transform'] })).join(' ')).toMatch(/tạm ngừng/)
    // H3 transform sends no aspect_ratio: its ratio comes from the frames (transformFrameRatio), not checked here
    expect(validateRequest(h3Transform({ duration: 5, ratio: '21:9' }), h3())).toEqual([])
    expect(validateRequest({ ...i2v, ratio: '21:9' }, h3()).join(' ')).toMatch(/21:9/)
  })

  it('profileSpecOf mirrors the client’s profileSpec(): Seedance as loaded, MiniMax-H3 merged with its fallback', () => {
    expect(profileSpecOf('seedance_2_5', [])).toBe(PROFILE_FALLBACKS.seedance_2_5)
    expect(profileSpecOf('minimax_h3', [])).toBe(PROFILE_FALLBACKS.minimax_h3)
    expect(PROFILE_FALLBACKS.minimax_h3).toMatchObject({ can_create: false, options: { disabled_modes: ['transform'] } })
    const seedance = { model_profile: 'seedance_2_5', can_create: true, options: { durations: [5] } }
    expect(profileSpecOf('seedance_2_5', [seedance])).toBe(seedance)
    const merged = profileSpecOf('minimax_h3', [
      { model_profile: 'minimax_h3', can_create: true, options: { durations: [5, 10], resolutions: ['768p', '2k', '4k'], disabled_modes: ['t2v'], modes: 'all' as unknown as string[] } },
    ])
    expect(merged.can_create).toBe(true)
    expect(merged.enabled).toBe(false) // not a boolean → false
    expect(merged.display_name).toBe('MiniMax-H3')
    expect(merged.options).toMatchObject({
      modes: ['t2v', 'i2v', 'transform'], // malformed → fallback
      durations: [5, 10, 15], // narrower than the fallback → fallback (validProfileList requires every fallback item)
      resolutions: ['768p', '2k', '4k'],
      disabled_modes: ['t2v'],
    })
  })
})

describe('canvasapp mapping: transform frame ratio (ratioFromDimensions / transformInputState)', () => {
  it('nearest supported ratio within 2 %, else null', () => {
    expect(ratioFromDimensions(1920, 1080)).toBe('16:9')
    expect(ratioFromDimensions(1080, 1920)).toBe('9:16')
    expect(ratioFromDimensions(1024, 1024)).toBe('1:1')
    expect(ratioFromDimensions(1600, 1200)).toBe('4:3')
    expect(ratioFromDimensions(1200, 1600)).toBe('3:4')
    expect(ratioFromDimensions(1940, 1080)).toBe('16:9') // 1 % off
    expect(ratioFromDimensions(2560, 1080)).toBeNull() // 21:9
    expect(ratioFromDimensions(0, 1080)).toBeNull()
    expect(ratioFromDimensions(NaN, 1080)).toBeNull()
  })

  it('both frames must share one supported ratio', () => {
    expect(transformFrameRatio('16:9', '16:9')).toEqual({ ratio: '16:9' })
    expect(transformFrameRatio('16:9', '9:16')).toMatchObject({ problem: expect.stringMatching(/khác tỷ lệ \(16:9 \/ 9:16\)/) })
    expect(transformFrameRatio(null, '16:9')).toMatchObject({ problem: expect.stringMatching(/chưa thuộc danh sách/) })
  })
})

describe('canvasapp mapping: status + remote ids', () => {
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

  it('encodes and decodes remote ids (UUID project / job ids)', () => {
    expect(decodeRemoteId(encodeRemoteId('p1', 'j1'))).toEqual({ projectId: 'p1', jobId: 'j1' })
    const p = uuidFromKey('p')
    const j = uuidFromKey('j')
    expect(decodeRemoteId(encodeRemoteId(p, j))).toEqual({ projectId: p, jobId: j })
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

describe('canvasapp mapping: bridge canvas (canvasPayload shape)', () => {
  it('one video node per scene, image nodes wired 1..N in @image order, no key the client would not send', () => {
    const canvas = bridgeCanvas([entryFromRequest(req(), uploadIdFor, 10)])
    expectClientCanvasShape(canvas)
    const vid = canvasNodeId('scene_a')
    expect(videoNodes(canvas).map((n) => n.id)).toEqual([vid])
    const video = videoNodes(canvas)[0]
    expect(video.data).toEqual({ model_profile: 'seedance_2_5', duration: 15, resolution: '1080p', aspect_ratio: '16:9', mode: 't2v', prompt: '@image_1 walks to @image_2' })
    const imgs = imageNodes(canvas)
    expect(imgs.map((n) => n.data.upload_ids)).toEqual([['up_a'], ['up_b']])
    expect(imgs.map((n) => n.id)).toEqual([imageNodeId('up_a'), imageNodeId('up_b')])
    expect(canvas.connections).toEqual([
      { from: imgs[0].id, to: vid, target_handle: 'reference', order: ORDER_BASE },
      { from: imgs[1].id, to: vid, target_handle: 'reference', order: ORDER_BASE + 1 },
    ])
    expect(ORDER_BASE).toBe(1)
    // deterministic: the same entries give the same canvas
    expect(bridgeCanvas([entryFromRequest(req(), uploadIdFor, 10)])).toEqual(canvas)
  })

  it('transform node aspect_ratio = the ratio the frames share (setTransformFrame), or null', () => {
    expect(entryFromRequest(h3Transform({ ratio: '16:9' }), uploadIdFor, 1, '9:16').ratio).toBe('9:16')
    expect(videoNodes(bridgeCanvas([entryFromRequest(h3Transform(), uploadIdFor, 1, '9:16')]))[0].data.aspect_ratio).toBe('9:16')
    expect(videoNodes(bridgeCanvas([entryFromRequest(h3Transform(), uploadIdFor, 1, null)]))[0].data.aspect_ratio).toBeNull()
    // the frame ratio only applies to transform
    expect(entryFromRequest(req(), uploadIdFor, 1, '9:16').ratio).toBe('16:9')
  })

  it('transform frames: first_frame order 1, last_frame order 2; aspect_ratio kept, or null when there is none', () => {
    const canvas = bridgeCanvas([entryFromRequest(h3Transform(), uploadIdFor, 1)])
    expectClientCanvasShape(canvas)
    expect(canvas.connections.map((c) => [c.target_handle, c.order])).toEqual([
      ['first_frame', FIRST_FRAME_ORDER],
      ['last_frame', LAST_FRAME_ORDER],
    ])
    expect([FIRST_FRAME_ORDER, LAST_FRAME_ORDER]).toEqual([1, 2])
    expect(videoNodes(canvas)[0].data).toMatchObject({ mode: 'transform', aspect_ratio: '16:9', resolution: '768p' })
    const noRatio = bridgeCanvas([{ ...entryFromRequest(h3Transform(), uploadIdFor, 1), ratio: '' }])
    expectClientCanvasShape(noRatio)
    expect(videoNodes(noRatio)[0].data.aspect_ratio).toBeNull()
    // any other mode falls back to 16:9
    expect(videoNodes(bridgeCanvas([{ ...entryFromRequest(req(), uploadIdFor, 1), ratio: '' }]))[0].data.aspect_ratio).toBe('16:9')
  })

  it('H3 t2v gets no image node / edge (the client drops them), even from a stale stored entry', () => {
    const r = req({ model: 'minimax_h3', mode: 't2v', resolution: '768p', duration: 5 })
    expect(entryFromRequest(r, uploadIdFor, 1).uploadIds).toEqual([])
    const stale: BridgeEntry = { ...entryFromRequest(r, uploadIdFor, 1), uploadIds: ['up_a'] }
    const canvas = bridgeCanvas([stale])
    expectClientCanvasShape(canvas)
    expect(canvas.nodes.map((n) => n.type)).toEqual(['video'])
    expect(canvas.connections).toEqual([])
  })

  it('all reference edges first, then frame edges (normalizeConnections order), across scenes', () => {
    const canvas = bridgeCanvas([
      entryFromRequest(h3Transform({ sceneId: 'tf' }), uploadIdFor, 3),
      entryFromRequest(req({ sceneId: 'sd' }), uploadIdFor, 2),
    ])
    expectClientCanvasShape(canvas)
    expect(canvas.connections.map((c) => c.target_handle)).toEqual(['reference', 'reference', 'first_frame', 'last_frame'])
  })

  it('keeps the newest scenes within the 40-node limit', () => {
    const entry = (i: number): BridgeEntry => ({ ...entryFromRequest(req({ sceneId: 's' + i, images: [] }), uploadIdFor, i), uploadIds: [] })
    const canvas = bridgeCanvas(Array.from({ length: 45 }, (_, i) => entry(i + 1)))
    expectClientCanvasShape(canvas)
    expect(canvas.nodes).toHaveLength(MAX_BRIDGE_NODES)
    expect(videoNodes(canvas)[0].id).toBe(canvasNodeId('s45'))
    expect(videoNodes(canvas).at(-1)!.id).toBe(canvasNodeId('s6'))
  })

  /** Image uploads on a canvas, counted like the client's imageIds() (every image node's upload_ids, duplicates too). */
  const imageUploads = (c: ReturnType<typeof bridgeCanvas>) => imageNodes(c).flatMap((n) => n.data.upload_ids)

  it('never more than 30 image uploads on the canvas (the client’s imageIds() / upload guard): 8 scenes × 4 refs', () => {
    const entry = (i: number): BridgeEntry => ({
      ...entryFromRequest(req({ sceneId: 's' + i }), uploadIdFor, i),
      uploadIds: Array.from({ length: 4 }, (_, k) => `u${i}_${k}`),
    })
    const canvas = bridgeCanvas(Array.from({ length: 8 }, (_, i) => entry(i + 1)))
    expectClientCanvasShape(canvas)
    expect(MAX_BRIDGE_IMAGES).toBe(30)
    expect(imageUploads(canvas)).toHaveLength(28) // s8…s2; s1 would make 32
    expect(videoNodes(canvas).map((n) => n.id)).toEqual(['s8', 's7', 's6', 's5', 's4', 's3', 's2'].map(canvasNodeId))
    // an older scene that still fits is kept (only the one that does not fit is left out)
    const small: BridgeEntry = { ...entry(0), uploadIds: ['u0_0', 'u0_1'] }
    const withSmall = bridgeCanvas([...Array.from({ length: 8 }, (_, i) => entry(i + 1)), small])
    expect(imageUploads(withSmall)).toHaveLength(30)
    expect(videoNodes(withSmall).map((n) => n.id)).toContain(canvasNodeId('s0'))
    // 30 references in the newest scene: kept alone with every reference
    const full: BridgeEntry = { ...entry(99), uploadIds: Array.from({ length: 30 }, (_, k) => `f${k}`) }
    const alone = bridgeCanvas([entry(1), full])
    expect(imageUploads(alone)).toHaveLength(30)
    expect(videoNodes(alone).map((n) => n.id)).toEqual([canvasNodeId('s99')])
  })

  it('a character image reused across scenes is ONE image node feeding every video node (counted once)', () => {
    const shared = ['up_elara', 'up_lumi', 'up_village', 'up_sky']
    const entries = Array.from({ length: 8 }, (_, i): BridgeEntry => ({ ...entryFromRequest(req({ sceneId: 's' + i }), uploadIdFor, i), uploadIds: shared }))
    const canvas = bridgeCanvas(entries)
    expectClientCanvasShape(canvas)
    expect(videoNodes(canvas)).toHaveLength(8)
    expect(imageNodes(canvas).map((n) => n.data.upload_ids[0])).toEqual(shared)
    expect(imageNodes(canvas).map((n) => n.id)).toEqual(shared.map((u) => imageNodeId(u)))
    expect(canvas.connections).toHaveLength(32)
    // every video node: references 1..4 in @image order, from the shared nodes
    for (const v of videoNodes(canvas)) {
      expect(canvas.connections.filter((c) => c.to === v.id).map((c) => [c.from, c.order])).toEqual(shared.map((u, k) => [imageNodeId(u), k + 1]))
    }
    // one edge per (image node, video node), as normalizeConnections() keeps
    expect(new Set(canvas.connections.map((c) => `${c.from}>${c.to}`)).size).toBe(canvas.connections.length)
  })

  it('the same upload twice in one video node, or as both frames, gets two image nodes (the client keeps one edge per image node)', () => {
    const twice: BridgeEntry = { ...entryFromRequest(req(), uploadIdFor, 2), uploadIds: ['up_a', 'up_b', 'up_a'] }
    const canvas = bridgeCanvas([twice])
    expectClientCanvasShape(canvas)
    expect(imageNodes(canvas).map((n) => n.id)).toEqual([imageNodeId('up_a'), imageNodeId('up_b'), imageNodeId('up_a', 1)])
    expect(canvas.connections.map((c) => c.order)).toEqual([1, 2, 3])
    const sameFrames = bridgeCanvas([entryFromRequest(h3Transform({ lastFrame: { assetId: 'f', imageId: 'img_f' } }), uploadIdFor, 1)])
    expectClientCanvasShape(sameFrames)
    const [ff, lf] = sameFrames.connections
    expect(ff.from).not.toBe(lf.from) // setTransformFrame(): first and last must be two different image nodes
    expect(imageNodes(sameFrames).map((n) => n.data.upload_ids)).toEqual([['up_f'], ['up_f']])
  })

  it('keeps the prompts of one canvas within budget (newest entry always kept)', () => {
    const long = (i: number, usedAt: number): BridgeEntry => ({ ...entryFromRequest(req({ sceneId: 'L' + i, images: [] }), uploadIdFor, usedAt), prompt: 'x'.repeat(150_000) })
    const canvas = bridgeCanvas([long(1, 1), long(2, 2), long(3, 3), long(4, 4)])
    expect(videoNodes(canvas).map((n) => n.id)).toEqual(['L4', 'L3'].map(canvasNodeId))
    expect(videoNodes(canvas).reduce((s, n) => s + n.data.prompt.length, 0)).toBeLessThanOrEqual(MAX_BRIDGE_PROMPT_CHARS)
    const huge = bridgeCanvas([{ ...long(9, 9), prompt: 'y'.repeat(MAX_BRIDGE_PROMPT_CHARS + 1) }])
    expect(videoNodes(huge)).toHaveLength(1)
  })
})

describe('canvasapp mapping: persisted bridge entries', () => {
  it('keeps v0.2.0 entries (extra label dropped) and drops malformed ones', () => {
    const v020 = {
      sceneId: 'scene_a',
      label: 'S01 · T1 — Mở đầu',
      model: 'seedance_2_5',
      mode: 't2v',
      duration: 30,
      resolution: '480p',
      ratio: '16:9',
      prompt: '@image_1 đi dạo',
      uploadIds: ['up_a'],
      firstFrameUploadId: null,
      lastFrameUploadId: null,
      usedAt: 5,
    }
    const out = bridgeEntriesFrom({
      scene_a: v020,
      bad_model: { ...v020, sceneId: 'bad_model', model: 'sora' },
      bad_uploads: { ...v020, sceneId: 'bad_uploads', uploadIds: 'up_a' },
      wrong_key: { ...v020 },
      no_prompt: { ...v020, sceneId: 'no_prompt', prompt: undefined },
      junk: 42,
    })
    expect(Object.keys(out)).toEqual(['scene_a'])
    expect(out.scene_a).not.toHaveProperty('label')
    expectClientCanvasShape(bridgeCanvas(Object.values(out)))
    expect(bridgeEntriesFrom(null)).toEqual({})
    expect(bridgeEntriesFrom([v020])).toEqual({})
    expect(bridgeEntriesFrom('x')).toEqual({})
  })
})

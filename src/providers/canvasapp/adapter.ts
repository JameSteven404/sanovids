// VideoProvider for canvasapp.io.vn (experimental, desktop only, OFF by default).
// Uses the user's own canvasapp account and credits through the Electron session (no password ever reaches SanoVids).
//
// submit:  ensure the "SanoVids bridge" project (created once, id remembered) → upload missing reference images
//          (cache: SanoVids imageId → upload_id) → PUT a minimal bridge canvas (so canvas_node_id exists) →
//          POST /api/video-jobs with client_request_id = take id (idempotency).
// poll:    ONE GET /api/video-jobs?project_id=… for all running takes, never more often than every 15 s.
// result:  GET /api/video-jobs/{id}/stream → MP4 blob (the engine extracts the poster frame).
import type { ModelId } from '../../core/types'
import { capabilitiesFromModels } from '../capabilities'
import type { JobRequest, ProviderAvailability, ProviderCapabilities, RemoteStatus, VideoProvider } from '../types'
import { CanvasappError, canvasappErrorText, type CanvasappApi, type CanvasJob, type VideoProfile } from './api'
import {
  ALLOWED_IMAGE_TYPES,
  BRIDGE_PROJECT_NAME,
  bridgeCanvas,
  decodeRemoteId,
  encodeRemoteId,
  entryFromRequest,
  imagesToUpload,
  jobIdFromCreateResponse,
  mapJobStatus,
  toVideoJobBody,
  uploadFilename,
  validateRequest,
  type BridgeEntry,
} from './mapping'

/** Never poll canvasapp more often than this (the site itself polls every 60 s). */
export const MIN_POLL_MS = 15_000
export const DEFAULT_POLL_MS = 20_000
/** Jobs running at the same time through the gateway. */
export const MAX_CONCURRENCY = 2
/** A job missing from the list this many polls in a row is reported as failed. */
const MAX_MISSES = 3

export interface KeyValueStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export const memoryStorage = (): KeyValueStorage => {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) }
}

export const browserStorage = (): KeyValueStorage => ({
  get: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* ignore */
    }
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  },
})

export interface CanvasappProviderDeps {
  api: CanvasappApi
  /** Media-store lookup (lib/imageStore getBlob). */
  getBlob: (imageId: string) => Promise<Blob | null>
  storage?: KeyValueStorage
  now?: () => number
  /** ≥ MIN_POLL_MS. */
  pollIntervalMs?: number
  generateAudio?: () => boolean
}

interface GatewayState {
  projectId: string | null
  /** SanoVids media-store imageId → canvasapp upload_id */
  uploads: Record<string, string>
  /** sceneId → bridge entry */
  entries: Record<string, BridgeEntry>
}

export const STATE_KEY = 'bdp:canvasapp:gateway'

export type CanvasappProvider = VideoProvider & {
  reset(): void
  /** Re-read /api/video-profiles (capabilities + validation). */
  refreshProfiles(): Promise<VideoProfile[]>
  bridgeProjectId(): string | null
  uploadCacheSize(): number
}

export function createCanvasappProvider(deps: CanvasappProviderDeps): CanvasappProvider {
  const { api } = deps
  const storage = deps.storage ?? memoryStorage()
  const now = deps.now ?? Date.now
  const pollMs = Math.max(MIN_POLL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_MS)

  let state: GatewayState = load()
  let profiles: VideoProfile[] | null = null
  let ensuring: Promise<string> | null = null
  /** Serialises submits: uploads + canvas PUT + job POST of one take never interleave with another's. */
  let chain: Promise<unknown> = Promise.resolve()
  const lists = new Map<string, { at: number; jobs: CanvasJob[] }>()
  const misses = new Map<string, number>()

  function load(): GatewayState {
    try {
      const raw = storage.get(STATE_KEY)
      if (raw) {
        const p = JSON.parse(raw) as Partial<GatewayState>
        return { projectId: p.projectId ?? null, uploads: p.uploads ?? {}, entries: p.entries ?? {} }
      }
    } catch {
      /* ignore */
    }
    return { projectId: null, uploads: {}, entries: {} }
  }
  function save() {
    storage.set(STATE_KEY, JSON.stringify(state))
  }

  async function ensureProject(): Promise<string> {
    if (state.projectId) return state.projectId
    if (!ensuring) {
      ensuring = (async () => {
        const existing = (await api.listProjects()).find((p) => p.name === BRIDGE_PROJECT_NAME)
        const id = existing?.project_id ?? (await api.createProject(BRIDGE_PROJECT_NAME))
        state = { ...state, projectId: id, entries: existing ? state.entries : {} }
        save()
        return id
      })().finally(() => {
        ensuring = null
      })
    }
    return ensuring
  }

  async function uploadMissing(req: JobRequest) {
    for (const imageId of imagesToUpload(req)) {
      if (state.uploads[imageId]) continue
      const blob = await deps.getBlob(imageId)
      if (!blob) throw new CanvasappError('bad-request', 'Không tìm thấy ảnh tham chiếu trong máy (đã bị xoá?).')
      const type = blob.type || 'image/png'
      if (!ALLOWED_IMAGE_TYPES.includes(type)) throw new CanvasappError('unsupported', `canvasapp chỉ nhận ảnh JPG/PNG/WEBP (ảnh này là ${type}).`)
      // Sequential on purpose: gentle on the server.
      const uploadId = await api.uploadImage(blob, uploadFilename(imageId, type))
      state = { ...state, uploads: { ...state.uploads, [imageId]: uploadId } }
      save()
    }
  }

  const uploadIdFor = (imageId: string) => {
    const id = state.uploads[imageId]
    if (!id) throw new CanvasappError('bad-request', 'Ảnh tham chiếu chưa được tải lên canvasapp.')
    return id
  }

  async function submitNow(req: JobRequest): Promise<{ remoteId: string }> {
    const problems = validateRequest(req, profiles)
    if (problems.length) throw new CanvasappError('unsupported', problems.join(' '))
    let projectId = await ensureProject()
    await uploadMissing(req)
    const entry = entryFromRequest(req, uploadIdFor, now())
    const putCanvas = async () => {
      state = { ...state, entries: { ...state.entries, [req.sceneId]: entry } }
      save()
      await api.putCanvas(projectId, bridgeCanvas(Object.values(state.entries)))
    }
    try {
      await putCanvas()
    } catch (e) {
      // The remembered bridge project was deleted on canvasapp → create/find it again once.
      if (!(e instanceof CanvasappError && e.code === 'not-found')) throw e
      state = { ...state, projectId: null, entries: {} }
      save()
      projectId = await ensureProject()
      await putCanvas()
    }
    const raw = await api.createVideoJob(toVideoJobBody(req, { projectId, uploadIdFor, generateAudio: deps.generateAudio?.() ?? true }))
    const jobId = jobIdFromCreateResponse(raw)
    if (!jobId) throw new CanvasappError('bad-response', 'canvasapp đã nhận yêu cầu nhưng không trả mã job — kiểm tra trên canvasapp.io.vn trước khi chạy lại (tránh trả credit hai lần).')
    lists.delete(projectId) // next poll sees the new job
    return { remoteId: encodeRemoteId(projectId, jobId) }
  }

  async function jobsOf(projectId: string): Promise<CanvasJob[]> {
    const hit = lists.get(projectId)
    if (hit && now() - hit.at < pollMs) return hit.jobs
    const jobs = await api.listVideoJobs(projectId)
    lists.set(projectId, { at: now(), jobs })
    return jobs
  }

  return {
    id: 'canvasapp',
    label: 'canvasapp.io.vn',

    available: async (): Promise<ProviderAvailability> => {
      const t = await api.transport.available()
      if (!t.ok) return t
      try {
        const auth = await api.authState()
        return auth.authenticated ? { ok: true } : { ok: false, reason: 'Chưa đăng nhập canvasapp.io.vn.' }
      } catch (e) {
        return { ok: false, reason: canvasappErrorText(e) }
      }
    },

    capabilities: (model: ModelId): ProviderCapabilities => {
      const base = capabilitiesFromModels(model, { maxConcurrency: MAX_CONCURRENCY, pollIntervalMs: pollMs, maxRefVideos: 0 })
      const o = profiles?.find((p) => p.model_profile === model)?.options
      if (!o) return base
      return {
        ...base,
        modes: o.modes ? base.modes.filter((m) => o.modes!.includes(m) && !o.disabled_modes?.includes(m)) : base.modes,
        durations: o.durations?.map(Number).filter(Number.isFinite) ?? base.durations,
        resolutions: o.resolutions ?? base.resolutions,
        ratios: o.aspect_ratios ?? base.ratios,
      }
    },

    submit: (req) => {
      const run = chain.then(() => submitNow(req))
      chain = run.catch(() => undefined)
      return run
    },

    poll: async (remoteIds) => {
      const out: RemoteStatus[] = []
      const byProject = new Map<string, { remoteId: string; jobId: string }[]>()
      for (const remoteId of remoteIds) {
        const d = decodeRemoteId(remoteId)
        if (!d) {
          out.push({ remoteId, state: 'failed', error: 'Mã job canvasapp không hợp lệ.' })
          continue
        }
        byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), { remoteId, jobId: d.jobId }])
      }
      for (const [projectId, items] of byProject) {
        const jobs = await jobsOf(projectId)
        const byId = new Map(jobs.map((j) => [j.job_id, j]))
        for (const { remoteId, jobId } of items) {
          const job = byId.get(jobId)
          if (job) {
            misses.delete(remoteId)
            out.push(mapJobStatus(remoteId, job))
            continue
          }
          const n = (misses.get(remoteId) ?? 0) + 1
          misses.set(remoteId, n)
          out.push(
            n >= MAX_MISSES
              ? { remoteId, state: 'failed', error: 'Không thấy job trên canvasapp nữa (đã bị xoá?). Kiểm tra trên canvasapp.io.vn.' }
              : { remoteId, state: 'processing' },
          )
        }
      }
      return out
    },

    fetchResult: async (remoteId) => {
      const d = decodeRemoteId(remoteId)
      if (!d) throw new CanvasappError('bad-request', 'Mã job canvasapp không hợp lệ.')
      const video = await api.fetchVideo(d.jobId)
      return { video, poster: null }
    },

    // No cancel(): canvasapp has no documented cancel endpoint and DELETE may not refund. Cancelling in SanoVids
    // only stops tracking; the job keeps running (and costing) on canvasapp.

    reset: () => {
      state = { projectId: null, uploads: {}, entries: {} }
      storage.remove(STATE_KEY)
      lists.clear()
      misses.clear()
      profiles = null
    },

    refreshProfiles: async () => {
      profiles = await api.videoProfiles()
      return profiles
    },
    bridgeProjectId: () => state.projectId,
    uploadCacheSize: () => Object.keys(state.uploads).length,
  }
}

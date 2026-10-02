// Demo provider behind the VideoProvider interface: no network, no cost.
// Timing / fail rate come from the runs store's mock settings; pictures from lib/mockProvider.ts.
// Progress is wall-clock based so background-tab timer throttling doesn't slow the demo down.
import { settingsLabel } from '../core/models'
import { renderMockBlobs } from '../lib/mockProvider'
import type { ModelId } from '../core/types'
import { capabilitiesFromModels } from './capabilities'
import type { JobRequest, JobResult, RemoteStatus, VideoProvider } from './types'

export type MockSpeed = 'fast' | 'normal' | 'slow'
export interface MockSettings {
  speed: MockSpeed
  /** 0..1 probability that a job fails (to test error UI). */
  failRate: number
  concurrency: number
  recordVideo: boolean
}

export const DEFAULT_MOCK_SETTINGS: MockSettings = { speed: 'fast', failRate: 0.1, concurrency: 3, recordVideo: true }

export const SPEED_MS: Record<MockSpeed, [number, number]> = { fast: [3000, 6000], normal: [9000, 16000], slow: [22000, 38000] }
export const FAIL_MESSAGES = [
  'Nhà cung cấp từ chối nội dung (demo).',
  'Hết thời gian chờ từ nhà cung cấp (demo).',
  'Ảnh tham chiếu không hợp lệ (demo).',
]

/** Renderer: (input) → blobs. Defaults to lib/mockProvider.ts (DOM canvas); tests inject a fake. */
export type MockRenderer = (req: JobRequest, settings: MockSettings) => Promise<JobResult>

interface Plan {
  total: number
  fail: boolean
  start: number
  req: JobRequest
}

export interface MockProviderOptions {
  now?: () => number
  random?: () => number
  render?: MockRenderer
}

const defaultRender: MockRenderer = async (req, settings) => {
  // Reference videos show up in the demo clip through their poster frames, then the images in @image order.
  const imageIds = [
    ...req.videos.map((v) => v.posterId).filter((x): x is string => !!x),
    ...req.images.map((i) => i.imageId),
    ...[req.firstFrame?.imageId, req.lastFrame?.imageId].filter((x): x is string => !!x),
  ]
  const out = await renderMockBlobs({
    takeId: req.takeId,
    code: req.sceneCode,
    takeNumber: req.takeNumber,
    title: req.title,
    prompt: req.rawPrompt,
    ratio: req.ratio,
    durationLabel: settingsLabel(req),
    color: req.color,
    imageIds,
    recordVideo: settings.recordVideo,
  })
  return { poster: out.poster, video: out.video }
}

export type MockProvider = VideoProvider & {
  /** Number of jobs the mock currently tracks (tests / debugging). */
  size(): number
}

export function createMockProvider(settings: () => MockSettings, opts: MockProviderOptions = {}): MockProvider {
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random
  const render = opts.render ?? defaultRender
  const plans = new Map<string, Plan>()

  return {
    id: 'mock',
    label: 'Demo giả lập',
    available: async () => ({ ok: true }),
    capabilities: (model: ModelId) => capabilitiesFromModels(model, { maxConcurrency: Math.max(1, settings().concurrency), pollIntervalMs: 0 }),

    submit: async (req) => {
      const s = settings()
      const [lo, hi] = SPEED_MS[s.speed] ?? SPEED_MS.fast
      // The take id is the remote id: submitting the same take twice never creates two jobs.
      plans.set(req.key, { total: lo + random() * (hi - lo), fail: random() < s.failRate, start: req.startedAt || now(), req })
      return { remoteId: req.key }
    },

    poll: async (remoteIds) => {
      const out: RemoteStatus[] = []
      for (const id of remoteIds) {
        const plan = plans.get(id)
        if (!plan) {
          out.push({ remoteId: id, state: 'failed', error: 'Job demo không còn trong bộ giả lập (đã tải lại trang?).' })
          continue
        }
        const progress = Math.max(1, Math.min(99, Math.round(((now() - plan.start) / plan.total) * 100)))
        if (plan.fail && progress >= 40 + (plan.req.takeNumber % 5) * 10) {
          plans.delete(id)
          out.push({ remoteId: id, state: 'failed', progress, error: FAIL_MESSAGES[plan.req.takeNumber % FAIL_MESSAGES.length] })
        } else if (progress >= 99) {
          out.push({ remoteId: id, state: 'completed', progress: 99 })
        } else {
          out.push({ remoteId: id, state: 'processing', progress })
        }
      }
      return out
    },

    fetchResult: async (remoteId) => {
      const plan = plans.get(remoteId)
      if (!plan) throw new Error('Job demo không còn trong bộ giả lập.')
      try {
        return await render(plan.req, settings())
      } finally {
        plans.delete(remoteId)
      }
    },

    cancel: (remoteId) => {
      plans.delete(remoteId)
    },
    reset: () => plans.clear(),
    size: () => plans.size,
  }
}

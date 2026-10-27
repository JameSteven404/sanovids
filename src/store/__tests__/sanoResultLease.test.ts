// Actual queue engine + SANO adapter, with only persistence/poster/network replaced by inert fixtures.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const disk = vi.hoisted(() => ({
  pending: [] as { blob: Blob; resolve: () => void }[],
  count: 0,
  peak: 0,
}))
vi.mock('../../lib/imageStore', () => ({
  putBlob: vi.fn((blob: Blob, prefix: string) => {
    if (prefix !== 'video') throw new Error('Unexpected poster write')
    const id = ++disk.count
    return new Promise<string>((resolve) => {
      disk.pending.push({ blob, resolve: () => resolve(`video-${id}`) })
      disk.peak = Math.max(disk.peak, disk.pending.length)
    })
  }),
  getBlob: vi.fn(async () => null), getUrl: vi.fn(async () => null), cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined), dataUrlToBlob: () => new Blob(), useMediaUrl: () => null,
}))
vi.mock('../../providers/poster', () => ({ posterFromVideo: vi.fn(async () => null) }))
import type { Project, Take } from '../../core/types'
import { jwt } from '../../providers/__tests__/insideSano'
import { createSanoGatewayProvider } from '../../providers/sano/gateway'
import { getProvider, registerProvider } from '../../providers'
import { useRuns, setEngineLockManager, setEngineHooks } from '../runs'
import { useProject } from '../project'
import { useDownloadPrefs } from '../../lib/downloads'

const original = getProvider('sano-gateway')
const priorAutoDownload = useDownloadPrefs.getState().autoDownload
const settings = { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' } as const
const models = [{ id: 'seedance_2_5', label: 'Fixture', ratios: ['16:9'], resolutions: ['480p'], durations: [5], maxRefs: 4 }]
const project = {
  id: 'result-lease-fixture', name: 'Fixture', schemaVersion: 2, createdAt: 0, updatedAt: 0,
  settings: { autoRenumber: true }, assets: [], presets: [],
  scenes: [{ id: 's1', order: 1, title: 'Scene', prompt: 'Walk', refs: [], videoRefs: [], presetId: null, settings,
    firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '' }],
} as Project
let provider: ReturnType<typeof createSanoGatewayProvider> | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('VITE_SANO_GATEWAY', '1')
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden') }))
  vi.stubGlobal('window', { location: { origin: 'https://sano.example' }, parent: { location: { origin: 'https://sano.example' } } })
  setEngineLockManager(null); setEngineHooks({})
  useDownloadPrefs.setState({ autoDownload: false })
  useProject.getState().loadProject(project)
  useRuns.getState().loadRuns({ takes: [], credits: 100, spent: 0 })
  disk.pending = []; disk.count = 0; disk.peak = 0
})

afterEach(async () => {
  useRuns.getState().loadRuns({ takes: [], credits: 100, spent: 0 })
  for (const item of disk.pending.splice(0)) item.resolve()
  await vi.advanceTimersByTimeAsync(1)
  provider?.reset(); provider = undefined
  registerProvider(original); setEngineLockManager(undefined); setEngineHooks({})
  useDownloadPrefs.setState({ autoDownload: priorAutoDownload })
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it('bounds complete result blobs awaiting persistence to two across polls, then completes all six as storage releases', async () => {
  const calls: { url: string; method: string }[] = []
  provider = createSanoGatewayProvider({
    available: () => true, token: async () => jwt({ sub: 'fixture-A' }), getBlob: async () => null,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET' })
      if (url.endsWith('/capabilities')) return Response.json({ mode: 'simulator', models })
      if (url.endsWith('/result')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '3' } })
      return Response.json({ id: url.split('/').at(-1), status: 'done', mode: 'simulator', progress: 100 })
    },
  })
  await provider.refreshLimits({ force: true }); registerProvider(provider)
  const takes = Array.from({ length: 6 }, (_, i) => ({
    id: `take-${i}`, sceneId: 's1', number: i + 1, status: 'processing', progress: 0, createdAt: 1, startedAt: 1,
    finishedAt: null, promptSnapshot: 'Walk', rawPromptSnapshot: 'Walk', refsSnapshot: [], videoRefsSnapshot: [],
    imageKeysSnapshot: [], settings, cost: 4, starred: false, posterId: null, videoId: null, error: null, position: null,
    provider: 'sano-gateway', remoteId: `job-${i}`, account: provider!.account(), charged: false, simulated: true,
  })) as Take[]
  useRuns.getState().loadRuns({ takes, credits: 100, spent: 0 })

  const pendingCounts: number[] = []
  for (const ms of [1_000, 16_000, 16_000]) {
    await vi.advanceTimersByTimeAsync(ms)
    pendingCounts.push(disk.pending.length)
  }
  expect(pendingCounts).toEqual([2, 2, 2]) // before the lease fix these were [2, 4, 6]
  expect(disk.pending.reduce((bytes, item) => bytes + item.blob.size, 0)).toBe(6)
  expect(calls.filter(({ url }) => url.endsWith('/result'))).toHaveLength(2)
  expect(useRuns.getState().takes.every((take) => take.status === 'processing' && take.videoId === null)).toBe(true)

  for (let completed = 2; completed <= 6; completed += 2) {
    for (const item of disk.pending.splice(0)) item.resolve()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(useRuns.getState().takes.filter((take) => take.status === 'completed')).toHaveLength(completed)
    expect(disk.pending).toHaveLength(completed < 6 ? 2 : 0)
  }
  expect(disk.peak).toBe(2)
  expect(disk.count).toBe(6)
  expect(calls.filter(({ url }) => url.endsWith('/result'))).toHaveLength(6)
  expect(useRuns.getState().takes.every((take) => take.status === 'completed' && take.progress === 100 && take.videoId)).toBe(true)
  expect(calls.filter(({ method }) => method === 'POST')).toHaveLength(0)
  expect(fetch).not.toHaveBeenCalled()
})

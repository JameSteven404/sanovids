// Actual Run check + SANO capabilities cache, with an injected clock and HTTP. No jobs are sent.
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'fixture'), getBlob: vi.fn(async () => null), getUrl: vi.fn(async () => null),
  cachedUrl: () => null, deleteMedia: vi.fn(async () => undefined), dataUrlToBlob: () => new Blob(), useMediaUrl: () => null,
}))

import { createSanoGatewayProvider, CAPS_TTL_MS } from '../sano/gateway'
import { activeProviderId, getProvider, registerProvider } from '..'
import { applyDevAccessState, bareState } from '../devAccess'
import { jwt, stubInsideSano } from './insideSano'
import { jobRefCount, settingsRunBlock, settingsRunWarning } from '../limits'
import { compileScene } from '../../core/compile'
import type { Asset, Scene } from '../../core/types'
import { useProject, LAYOUT } from '../../store/project'
import { useRuns } from '../../store/runs'

const originalProvider = getProvider('sano-gateway')
const blank = useProject.getState().project
afterEach(() => {
  getProvider('sano-gateway').reset?.()
  registerProvider(originalProvider)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  applyDevAccessState(bareState('build'))
  useProject.setState({ project: blank })
  useRuns.setState({ takes: [] })
})

it('Run check keeps a stale maxRefs warning after a failed refresh, while fresh limits block and an in-limit scene stays clear', async () => {
  stubInsideSano()
  applyDevAccessState(bareState('locked'))
  vi.stubGlobal('fetch', () => { throw new Error('Un-injected HTTP forbidden') })
  let now = Date.now()
  let fail = false
  const calls: string[] = []
  const provider = createSanoGatewayProvider({
    now: () => now, available: () => true, token: async () => jwt({ sub: 'fixture-stale' }),
    getBlob: async () => new Blob(['fixture'], { type: 'image/png' }),
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url !== '/api/video/capabilities') throw new Error('Only fake capabilities allowed')
      return fail ? Response.json({ error: 'fixture unavailable' }, { status: 503 }) : Response.json({
        mode: 'simulator', models: [{ id: 'seedance_2_5', label: 'Fixture model', ratios: ['16:9'], resolutions: ['1080p'], durations: [15], maxRefs: 1 }],
      })
    },
  })
  registerProvider(provider)
  const scene: Scene = {
    id: 's1', order: 1, title: 'Fixture', prompt: '@image_1 walks beside @image_2', refs: ['a1'], videoRefs: [], presetId: null,
    settings: { model: 'seedance_2_5', mode: 'i2v', duration: 15, resolution: '1080p', ratio: '16:9' },
    firstFrame: null, lastFrame: null, color: null, position: { x: LAYOUT.scenesX, y: 60 }, note: '',
  }
  const asset: Asset = { id: 'a1', kind: 'character', name: 'Fixture', tag: 'fixture', description: '', imageIds: ['img1', 'img2'], color: '#999', position: null }
  const project = { ...blank, id: 'fixture-stale', scenes: [scene], assets: [asset], folders: [] }
  useProject.setState({ project })
  useRuns.setState({ takes: [] })
  expect(activeProviderId()).toBe('sano-gateway')
  expect(await provider.refreshLimits({ force: true })).toBe('read')
  const refs = jobRefCount(scene, compileScene(project, scene))
  expect(refs).toBe(2)
  expect(useRuns.getState().check(['s1'])[0]).toMatchObject({ ok: false, reason: 'Fixture model trên SANO nhận tối đa 1 ảnh tham chiếu (đang có 2)' })

  now += CAPS_TTL_MS + 1
  fail = true
  expect(await provider.refreshLimits({ force: true })).toBe('kept')
  const limits = provider.settingsLimits()
  expect(limits.firm).toBe(false)
  expect(settingsRunBlock(limits, scene.settings, refs)).toBeNull()
  expect(settingsRunWarning(limits, scene.settings, 'sano-gateway', refs)).toContain('tối đa 1 ảnh tham chiếu (đang có 2)')
  const stale = useRuns.getState().check(['s1'])[0]
  expect(stale.ok).toBe(true) // Stale limits warn; they never become a firm block.
  expect(stale.warnings).toEqual([expect.stringContaining('tối đa 1 ảnh tham chiếu (đang có 2)')])
  expect(stale.warnings[0]).toContain('theo lần đọc cấu hình model trước')

  // Count the current scene, rather than retaining the previous warning after an image is removed.
  useProject.setState({ project: { ...project, scenes: [{ ...scene, prompt: '@image_1 walks' }], assets: [{ ...asset, imageIds: ['img1'] }] } })
  expect(useRuns.getState().check(['s1'])[0]).toMatchObject({ ok: true, warnings: [] })
  expect(calls).toEqual(['GET /api/video/capabilities', 'GET /api/video/capabilities'])
})

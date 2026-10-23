// D226: SanoVids inside SANO's desktop frame with canvasapp hidden (window.bdpDesktop.sano.canvasapp === false, set by
// electron/preload.cjs from main's CANVASAPP_IN_SANO): nothing offers or names canvasapp, no provider left = "paused",
// and the queue leaves canvasapp takes exactly as saved.
// The page loads as Sano Agent does (the bridge is there before any module runs, development mode locked): server
// rendering reads each zustand store's INITIAL state, so that is the state the markup below shows.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sanoWindow = vi.hoisted(() => {
  const w = { bdpDesktop: { sano: { canvasapp: false } }, addEventListener: () => undefined, removeEventListener: () => undefined }
  ;(globalThis as { window?: unknown }).window = w
  return w
})

vi.mock('../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'img_1'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))

import { renderToStaticMarkup } from 'react-dom/server'
import { rerunTake, requestRun } from '../actions'
import { GatewaySection } from '../components/dialogs/GatewaySection'
import { GATEWAY_GROUP_TEXT, SettingsDialog } from '../components/dialogs/SettingsDialog'
import { Inspector } from '../components/inspector/Inspector'
import { QueueDrawer, QueuePanel } from '../components/runs/QueueDrawer'
import { costTitle } from '../components/sidebar/shared'
import { CreditPill } from '../components/topbar/CreditPill'
import type { Project, Scene, Take } from '../core/types'
import {
  activeProviderId,
  canvasappOff,
  getProvider,
  providerBlockedReason,
  providerPaused,
  registerProvider,
  SANO_PAUSED_REASON,
  selectableProviders,
  useProviderPrefs,
} from '../providers'
import { capabilitiesFromModels } from '../providers/capabilities'
import { applyDevAccessState, bareState } from '../providers/devAccess'
import type { VideoProvider } from '../providers/types'
import { useProject } from '../store/project'
import { activeCount, restartWork, sendingCount, setEngineHooks, setEngineLockManager, useRuns } from '../store/runs'
import { useUI } from '../store/ui'

const scene: Scene = {
  id: 's1',
  order: 1,
  title: 'Cảnh 1',
  prompt: 'A hero walks',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
}
const project: Project = { id: 'p', name: 'P', schemaVersion: 2, createdAt: 0, updatedAt: 0, presets: [], settings: { autoRenumber: true }, assets: [], scenes: [scene] }

const take = (id: string, patch: Partial<Take>): Take => ({
  id,
  sceneId: 's1',
  number: 1,
  status: 'processing',
  progress: 1,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  promptSnapshot: 'x',
  rawPromptSnapshot: 'x',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: scene.settings,
  cost: 4,
  starred: false,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
  provider: 'canvasapp',
  remoteId: null,
  charged: false,
  ...patch,
})

const realCanvasapp = getProvider('canvasapp')
const html = (el: React.ReactElement) => renderToStaticMarkup(el)

beforeEach(() => {
  setEngineLockManager(null)
  setEngineHooks({})
  useProject.getState().loadProject(project)
  useUI.setState({ toasts: [] })
})
afterEach(() => {
  useRuns.getState().loadRuns({ takes: [], credits: 100, spent: 0 })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  applyDevAccessState(bareState('locked'))
  useProviderPrefs.getState().setProvider('dev')
  useUI.setState({ toasts: [] })
  registerProvider(realCanvasapp)
})
afterAll(() => {
  setEngineLockManager(undefined)
  if ((globalThis as { window?: unknown }).window === sanoWindow) delete (globalThis as { window?: unknown }).window
})

describe('D226: canvasapp hidden inside SANO', () => {
  it('development mode locked (Sano Agent): no provider — every surface says generation is paused, never canvasapp', () => {
    expect(activeProviderId()).toBe('canvasapp')
    expect(selectableProviders()).toEqual([])
    expect(providerPaused(activeProviderId())).toBe(true)
    expect(providerBlockedReason('canvasapp')).toBe(SANO_PAUSED_REASON)
    expect(canvasappOff()).toBe(true)
    expect(SANO_PAUSED_REASON).not.toMatch(/canvasapp/i)
    // Run: the reason, without a "Mở Cài đặt" that could change nothing
    requestRun(['s1'])
    expect(useUI.getState().dialog.kind).toBe('none')
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ text: SANO_PAUSED_REASON, action: undefined })
    // "Thử lại" of a DEV take whose submit is unknown: paused too (not "tạo take mới trên canvasapp.io.vn")
    useRuns.setState({ takes: [take('d', { provider: 'dev', status: 'failed', submitUnknown: true })] })
    rerunTake('d')
    expect(useUI.getState().toasts.at(-1)?.text).toBe(SANO_PAUSED_REASON)
    useRuns.setState({ takes: [] })
    expect(costTitle(20, 'canvasapp', 'Chạy S01 · ')).toBe(`Chạy S01 · ${SANO_PAUSED_REASON}`)

    const gateway = html(<GatewaySection />)
    expect(gateway).toContain(SANO_PAUSED_REASON)
    expect(gateway).not.toMatch(/canvasapp/i)
    expect(html(<CreditPill />)).toBe('')
    expect(html(<QueueDrawer />)).not.toMatch(/canvasapp/i)
    const queue = html(<QueuePanel />)
    expect(queue).toContain(SANO_PAUSED_REASON)
    expect(queue).not.toMatch(/canvasapp/i)
    const inspector = html(<Inspector />)
    expect(inspector).toContain(SANO_PAUSED_REASON)
    expect(inspector).not.toMatch(/canvasapp/i)
    // Cài đặt at both levels (read when the dialog opens), and what its search finds
    expect(JSON.stringify(GATEWAY_GROUP_TEXT)).not.toMatch(/canvasapp/i)
    for (const level of ['basic', 'advanced']) {
      vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'bdp:pref:settingsLevel' ? JSON.stringify(level) : null), setItem: () => undefined, removeItem: () => undefined })
      expect(html(<SettingsDialog />), level).not.toMatch(/canvasapp/i)
    }
  })

  it('development mode open (from source): only the simulator, even when canvasapp was the saved choice', async () => {
    applyDevAccessState(bareState('build'))
    useProviderPrefs.getState().setProvider('canvasapp')
    expect(useProviderPrefs.getState().provider).toBe('canvasapp') // the saved choice is never rewritten
    expect(activeProviderId()).toBe('dev')
    expect(selectableProviders()).toEqual(['dev'])
    expect(providerPaused(activeProviderId())).toBe(false)
    // a page loaded with development mode open (fresh modules: their initial state is the one rendered)
    sanoWindow.bdpDesktop = { ...sanoWindow.bdpDesktop, devAccess: { initial: 'build' } } as typeof sanoWindow.bdpDesktop
    vi.resetModules()
    try {
      const { GatewaySection: OpenGateway } = await import('../components/dialogs/GatewaySection')
      const gateway = html(<OpenGateway />)
      expect(gateway).toContain('chỉ có chế độ Phát triển')
      expect(gateway).not.toContain('canvasapp.io.vn')
      expect(gateway).not.toContain('Nhà cung cấp video cho take mới')
    } finally {
      sanoWindow.bdpDesktop = { sano: { canvasapp: false } }
    }
  })

  it('the queue leaves canvasapp takes exactly as saved: never sent, polled, looked up or failed', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const fake: VideoProvider = {
      id: 'canvasapp',
      label: 'canvasapp',
      minPollIntervalMs: 0,
      available: async () => ({ ok: true }),
      capabilities: (m) => capabilitiesFromModels(m, { maxConcurrency: 2, pollIntervalMs: 0 }),
      submit: async () => (calls.push('submit'), { remoteId: 'r' }),
      poll: async () => (calls.push('poll'), []),
      recover: async () => (calls.push('recover'), null),
      fetchResult: async () => (calls.push('fetch'), { video: new Blob(), poster: new Blob() }),
    }
    registerProvider(fake)
    const saved = [take('q', { status: 'queued', startedAt: null }), take('p', { remoteId: 'job_1' }), take('u', {})]
    useRuns.getState().loadRuns({ takes: saved, credits: 100, spent: 0 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toEqual([])
    expect(useRuns.getState().takes).toEqual(saved)
  })

  it('"Chạy lại" of a canvasapp take whose submit is unknown: paused, before any question', () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('window', { ...sanoWindow, confirm })
    const unknown = take('u', { status: 'failed', submitUnknown: true })
    const unverifiable = take('v', { status: 'failed', submitUnknown: true, error: 'Không kiểm tra được lần gửi trước — x' })
    for (const t of [unknown, unverifiable]) {
      useRuns.setState({ takes: [t] })
      rerunTake(t.id)
      expect(confirm).not.toHaveBeenCalled()
      expect(useUI.getState().toasts.at(-1)?.text).toBe(SANO_PAUSED_REASON)
      expect(useRuns.getState().takes).toEqual([t])
    }
    expect(useUI.getState().dialog.kind).toBe('none')
  })

  it('update waits, "busy" and the queue counts leave canvasapp takes out: SanoVids itself runs them', () => {
    const saved = [take('q', { status: 'queued', startedAt: null }), take('p', { remoteId: 'job_1' }), take('u', {})]
    useRuns.setState({ takes: saved })
    expect(restartWork(saved, new Set(['s1']))).toEqual({ queued: 0, processing: 0, sending: 0 })
    expect(sendingCount()).toBe(0)
    expect(activeCount(useRuns.getState())).toBe(0)
    // a development-mode take still counts
    const dev = take('d', { provider: 'dev', status: 'queued', startedAt: null })
    expect(restartWork([...saved, dev], new Set(['s1']))).toEqual({ queued: 1, processing: 0, sending: 0 })
    expect(activeCount({ ...useRuns.getState(), takes: [...saved, dev] })).toBe(1)
  })
})

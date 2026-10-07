// lib/desktopBusy: the macOS desktop app tells the main process whether takes are queued / being made (IPC 'app:busy'),
// so a window hidden by its close button keeps working at full speed — and keeps the Mac awake — only then
// (electron/hardening-rules.cjs createHiddenWork). First answer, then changes only; nothing outside the Mac app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../imageStore', () => ({
  putBlob: vi.fn(async () => 'img_1'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))

import type { Project, Scene, Take } from '../../core/types'
import { useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { desktopBusyBridge, startBusyReporter, startDesktopBusy } from '../desktopBusy'

const scene = (id: string, order: number): Scene => ({
  id,
  order,
  title: 'Cảnh ' + order,
  prompt: 'A hero walks',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: order * 300 },
  note: '',
})

const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [],
  scenes: [scene('s1', 1), scene('s2', 2)],
})

const take = (id: string, sceneId: string, status: Take['status'], patch: Partial<Take> = {}): Take =>
  ({ id, sceneId, status, provider: 'dev', remoteId: null, ...patch }) as Take

describe('startBusyReporter', () => {
  it('sends the first answer, then only changes; the stop function unsubscribes', () => {
    let busy = false
    let listener: (() => void) | null = null
    const sent: boolean[] = []
    const off = vi.fn()
    const stop = startBusyReporter({
      busy: () => busy,
      send: (b) => sent.push(b),
      subscribe: (l) => {
        listener = l
        return off
      },
    })
    expect(sent).toEqual([false])
    listener!()
    expect(sent).toEqual([false]) // same answer: nothing sent
    busy = true
    listener!()
    listener!()
    busy = false
    listener!()
    expect(sent).toEqual([false, true, false])
    stop()
    expect(off).toHaveBeenCalledTimes(1)
  })
})

describe('desktopBusyBridge', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('only in the macOS desktop app, and only with a setBusy function', () => {
    expect(desktopBusyBridge()).toBeNull() // no window (tests run in Node)
    const setBusy = async () => true
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'win32', app: { setBusy } } })
    expect(desktopBusyBridge()).toBeNull()
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', app: { setBusy } } })
    expect(desktopBusyBridge()).toBeNull()
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'darwin', app: { signature: async () => ({}) } } })
    expect(desktopBusyBridge()).toBeNull()
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'darwin' } })
    expect(desktopBusyBridge()).toBeNull()
    const app = { setBusy }
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'darwin', app } })
    expect(desktopBusyBridge()).toBe(app)
  })
})

describe('startDesktopBusy (the stores of the open project)', () => {
  beforeEach(() => {
    useProject.getState().loadProject(project())
    useRuns.setState({ takes: [] })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    useRuns.setState({ takes: [] })
  })

  it('outside the macOS app nothing is sent and the cleanup is a no-op', () => {
    const setBusy = vi.fn(async () => true)
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'win32', app: { setBusy } } })
    const stop = startDesktopBusy()
    useRuns.setState({ takes: [take('a', 's1', 'processing')] })
    stop()
    expect(setBusy).not.toHaveBeenCalled()
  })

  it('busy while a take is queued (its scene exists) or running; idle once they finish; a deleted scene’s queued take does not count', () => {
    const setBusy = vi.fn(async (_busy: boolean) => true)
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'darwin', app: { setBusy } } })
    const stop = startDesktopBusy()
    const sent = () => setBusy.mock.calls.map((c) => c[0])
    expect(sent()).toEqual([false])
    useRuns.setState({ takes: [take('a', 's2', 'queued')] })
    expect(sent()).toEqual([false, true])
    useRuns.setState({ takes: [take('a', 's2', 'processing', { remoteId: 'r_a' })] }) // still busy: not sent again
    expect(sent()).toEqual([false, true])
    useRuns.setState({ takes: [take('a', 's2', 'completed', { remoteId: 'r_a' })] })
    expect(sent()).toEqual([false, true, false])
    // a queued take whose scene gets deleted never starts: the window is not kept awake for it
    useRuns.setState({ takes: [take('b', 's2', 'queued')] })
    expect(sent()).toEqual([false, true, false, true])
    useProject.getState().removeScenes(['s2'])
    expect(sent()).toEqual([false, true, false, true, false])
    stop()
    useRuns.setState({ takes: [take('c', 's1', 'processing')] })
    expect(sent()).toEqual([false, true, false, true, false]) // stopped: no more answers
  })

  it('a bridge that throws or rejects never breaks the page', async () => {
    vi.stubGlobal('window', {
      bdpDesktop: {
        version: '0.6.0',
        platform: 'darwin',
        app: {
          setBusy: () => {
            throw new Error('no handler')
          },
        },
      },
    })
    expect(() => startDesktopBusy()()).not.toThrow()
    vi.stubGlobal('window', { bdpDesktop: { version: '0.6.0', platform: 'darwin', app: { setBusy: () => Promise.reject(new Error('gone')) } } })
    const stop = startDesktopBusy()
    useRuns.setState({ takes: [take('a', 's1', 'processing')] })
    await Promise.resolve()
    stop()
  })
})

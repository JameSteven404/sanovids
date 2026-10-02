// Provider registry + the "which provider runs new takes" setting.
// Default and fallback: the mock (demo) provider. The canvasapp gateway is only active when the user chose it in
// Settings AND the desktop bridge exists (window.bdpDesktop.canvasapp).
// NOTE: do not import lib/pwa or store/* here (runs.ts imports this module; avoid import cycles).
import { create } from 'zustand'
import { getBlob } from '../lib/imageStore'
import { createCanvasappApi } from './canvasapp/api'
import { browserStorage, createCanvasappProvider, type CanvasappProvider } from './canvasapp/adapter'
import { createDesktopTransport, hasCanvasappBridge, WEB_UNAVAILABLE } from './canvasapp/transport'
import type { ProviderId, VideoProvider } from './types'

export type { ProviderId, VideoProvider } from './types'

const PREF_KEY = 'bdp:pref:provider'

function savedProvider(): ProviderId {
  try {
    return localStorage.getItem(PREF_KEY) === 'canvasapp' ? 'canvasapp' : 'mock'
  } catch {
    return 'mock'
  }
}

interface ProviderPrefs {
  /** Provider chosen in Settings. Effective provider: see activeProviderId(). */
  provider: ProviderId
  setProvider: (p: ProviderId) => void
}

export const useProviderPrefs = create<ProviderPrefs>()((set) => ({
  provider: savedProvider(),
  setProvider: (provider) => {
    try {
      localStorage.setItem(PREF_KEY, provider)
    } catch {
      /* ignore */
    }
    set({ provider })
  },
}))

const registry = new Map<ProviderId, VideoProvider>()
let canvasapp: CanvasappProvider | null = null

export function registerProvider(p: VideoProvider): void {
  registry.set(p.id, p)
}

/** The canvasapp gateway provider (created on first use). */
export function canvasappProvider(): CanvasappProvider {
  if (!canvasapp) {
    canvasapp = createCanvasappProvider({ api: createCanvasappApi(createDesktopTransport()), getBlob, storage: browserStorage() })
  }
  return canvasapp
}

export function getProvider(id: ProviderId): VideoProvider {
  const hit = registry.get(id)
  if (hit) return hit
  if (id === 'canvasapp') {
    const p = canvasappProvider()
    registry.set('canvasapp', p)
    return p
  }
  throw new Error(`Chưa đăng ký nhà cung cấp video “${id}”.`)
}

/** Provider used for NEW takes. */
export function activeProviderId(): ProviderId {
  return useProviderPrefs.getState().provider === 'canvasapp' && hasCanvasappBridge() ? 'canvasapp' : 'mock'
}

/** Synchronous pre-check used by enqueue (login is checked when the job is submitted). Null = OK. */
export function providerBlockedReason(id: ProviderId): string | null {
  if (id === 'canvasapp' && !hasCanvasappBridge()) return WEB_UNAVAILABLE
  return null
}

export const PROVIDER_LABEL: Record<ProviderId, string> = { mock: 'Demo giả lập', canvasapp: 'canvasapp.io.vn' }

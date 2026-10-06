// Where the desktop app runs from, for the reminder in "Cài đặt → Ứng dụng / Giới thiệu" (lib/aboutModel placementNote):
//   'installer'  installed by SanoVids-Setup (Desktop / Start icons, auto-update);
//   'portable'   SanoVids-Portable (no icon, no auto-update);
//   'temp-copy'  a copy running straight from Windows' temp folder (left by an interrupted Setup / Portable run) —
//                Windows may delete it any time;
//   'dev'        running from the sources.
// Sources: 'desktop' = window.bdpDesktop.app.placement() (electron/preload.cjs → IPC 'app:placement'; the main process
// answers { kind } only — never a path); 'none' = a desktop build without it (older preload) → unknown; 'sim' = outside
// Electron (`npm run dev`): development mode's simulated answer (providers/dev/appPlacement), driven from "Bảng phát
// triển → Cập nhật → Vị trí chạy", followed live. Every payload is checked (parseAppPlacement), never thrown on.
//
// ---- API ----
//   parseAppPlacement(raw)            untrusted payload → { kind } (anything else → { kind: 'unknown' }).
//   appPlacementSource()              'desktop' | 'none' | 'sim'.
//   useAppPlacement                   zustand store { placement: AppPlacement | null } (null = not asked yet).
//   loadAppPlacement()                ask once (one promise in flight / kept after success); never throws.
//   createAppPlacementLoader(deps)    the same with injected bridges (tests).
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { devPlacementBridge, useDevPlacement } from '../providers/dev/appPlacement'
import { isDesktop } from './pwa'

export type AppPlacementKind = 'installer' | 'portable' | 'temp-copy' | 'dev'

export interface AppPlacement {
  kind: AppPlacementKind | 'unknown'
}

/** window.bdpDesktop.app.placement (electron/preload.cjs), next to signature(). */
export interface DesktopPlacementBridge {
  placement(): Promise<unknown>
}

export type AppPlacementSource = 'desktop' | 'none' | 'sim'

export const APP_PLACEMENT_KINDS: readonly AppPlacementKind[] = ['installer', 'portable', 'temp-copy', 'dev']

const unknownPlacement = (): AppPlacement => ({ kind: 'unknown' })

/**
 * Strict check of a payload: exactly an object with a known `kind` (other keys are ignored, never shown — the main
 * process sends no path). Anything else → { kind: 'unknown' }.
 */
export function parseAppPlacement(raw: unknown): AppPlacement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unknownPlacement()
  const kind = (raw as { kind?: unknown }).kind
  return typeof kind === 'string' && (APP_PLACEMENT_KINDS as readonly string[]).includes(kind) ? { kind: kind as AppPlacementKind } : unknownPlacement()
}

export interface AppPlacementStore {
  /** null until the first answer. */
  placement: AppPlacement | null
}

export interface AppPlacementLoaderDeps {
  source: () => AppPlacementSource
  desktop: () => DesktopPlacementBridge | null
  sim: () => DesktopPlacementBridge
  /** Live changes of the simulation; returns an unsubscribe. */
  watchSim: (listener: (raw: unknown) => void) => () => void
}

export interface AppPlacementLoader {
  store: UseBoundStore<StoreApi<AppPlacementStore>>
  load(): Promise<AppPlacement>
}

export function createAppPlacementLoader(deps: AppPlacementLoaderDeps): AppPlacementLoader {
  const store = create<AppPlacementStore>()(() => ({ placement: null }))
  let inflight: Promise<AppPlacement> | null = null
  let watching = false

  const set = (placement: AppPlacement) => {
    if (store.getState().placement?.kind !== placement.kind) store.setState({ placement })
  }

  async function ask(): Promise<AppPlacement> {
    const source = deps.source()
    if (source === 'none') return unknownPlacement()
    if (source === 'desktop') {
      const bridge = deps.desktop()
      return bridge ? parseAppPlacement(await bridge.placement()) : unknownPlacement()
    }
    if (!watching) {
      watching = true
      deps.watchSim((raw) => set(parseAppPlacement(raw)))
    }
    return parseAppPlacement(await deps.sim().placement())
  }

  function load(): Promise<AppPlacement> {
    if (inflight) return inflight
    const p: Promise<AppPlacement> = ask().then(
      (placement) => {
        set(placement)
        return placement
      },
      () => {
        const placement = unknownPlacement()
        set(placement)
        // A failed ask may be retried by the next call (the next time the block opens).
        if (inflight === p) inflight = null
        return placement
      },
    )
    inflight = p
    return p
  }

  return { store, load }
}

function desktopPlacementBridge(): DesktopPlacementBridge | null {
  if (typeof window === 'undefined') return null
  const app: { placement?: unknown } | undefined = window.bdpDesktop?.app
  return app && typeof app === 'object' && typeof app.placement === 'function' ? (app as DesktopPlacementBridge) : null
}

/** Where the placement comes from in this window. */
export function appPlacementSource(): AppPlacementSource {
  if (desktopPlacementBridge()) return 'desktop'
  return isDesktop() ? 'none' : 'sim'
}

const appLoader = createAppPlacementLoader({
  source: appPlacementSource,
  desktop: desktopPlacementBridge,
  sim: devPlacementBridge,
  watchSim: (listener) => useDevPlacement.subscribe((s) => listener(s)),
})

/** { placement } — select `placement` only. */
export const useAppPlacement = appLoader.store
/** Ask where the app runs from (idempotent: one promise in flight, kept after success). Never throws. */
export const loadAppPlacement = appLoader.load

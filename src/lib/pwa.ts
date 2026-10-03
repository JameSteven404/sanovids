/// <reference types="vite-plugin-pwa/vanillajs" />
// Web app (PWA) + desktop integration:
//  - registers the service worker (vite-plugin-pwa, autoUpdate) on http(s) production builds only — never inside
//    the Electron desktop build (window.bdpDesktop) or when opened from file:
//  - tracks whether the browser offered to install the app (beforeinstallprompt) and whether we already run
//    as an installed app (display-mode standalone, iOS home screen, or the desktop build).
// Call initPwa() once at startup (main.tsx) so the one-shot beforeinstallprompt event is never missed.
import { useSyncExternalStore } from 'react'
import type { CanvasappBridge } from '../providers/canvasapp/transport'
import type { DesktopFilesBridge } from './desktopFiles'
import type { DesktopUpdatesBridge } from './updateTypes'
import { flush, useSave } from '../store/persist'
import { toast, useUI } from '../store/ui'

export interface PwaInstallState {
  /** The browser offered to install the app (beforeinstallprompt received). */
  canInstall: boolean
  /** Running as an installed app (standalone window, PWA or desktop build). */
  installed: boolean
  /** Running inside the Electron desktop build. */
  desktop: boolean
  promptInstall: () => Promise<void>
}

/** Exposed by electron/preload.cjs. */
export interface DesktopInfo {
  version: string
  electron?: string
  platform?: string
  /**
   * canvasapp.io.vn gateway (IPC to the main process); missing in older desktop builds. See providers/canvasapp.
   * Includes `checkout()` (top-up: opens the real SePay page in a modal window) in builds that support it.
   */
  canvasapp?: CanvasappBridge
  /** Save dialog, folder picker and writes into picked folders (lib/desktopFiles.ts); missing in older desktop builds. */
  files?: DesktopFilesBridge
  /** Auto-update (electron/updater.cjs, lib/updates.ts); missing in builds before 0.5.0. */
  updates?: DesktopUpdatesBridge
}

declare global {
  interface Window {
    bdpDesktop?: DesktopInfo
  }
  interface Navigator {
    /** iOS Safari: launched from the home screen. */
    standalone?: boolean
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

/** True inside the Electron desktop build. */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false
  return !!window.bdpDesktop || (typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent))
}

/** Desktop build info (app version…), or null in a browser. */
export function desktopInfo(): DesktopInfo | null {
  return typeof window !== 'undefined' ? (window.bdpDesktop ?? null) : null
}

// ---------------- install state (tiny external store) ----------------
const STANDALONE_QUERIES = ['(display-mode: standalone)', '(display-mode: window-controls-overlay)', '(display-mode: fullscreen)']

let initialized = false
let deferred: BeforeInstallPromptEvent | null = null
let standalone = false
let desktop = false
const listeners = new Set<() => void>()

const promptInstall = async (): Promise<void> => {
  const event = deferred
  if (!event) return
  deferred = null // the event can be used only once
  try {
    await event.prompt()
    await event.userChoice
  } catch {
    /* the browser refused to show the prompt */
  } finally {
    publish()
  }
}

let snapshot: PwaInstallState = { canInstall: false, installed: false, desktop: false, promptInstall }

function compute(): PwaInstallState {
  const installed = desktop || standalone
  return { canInstall: !!deferred && !installed, installed, desktop, promptInstall }
}

function publish() {
  const next = compute()
  if (next.canInstall === snapshot.canInstall && next.installed === snapshot.installed && next.desktop === snapshot.desktop) return
  snapshot = next
  for (const l of listeners) l()
}

function readStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (navigator.standalone === true) return true
  return typeof window.matchMedia === 'function' && STANDALONE_QUERIES.some((q) => window.matchMedia(q).matches)
}

/** Start listening for install events. Idempotent; called from main.tsx before the first render. */
export function initPwa(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  desktop = isDesktop()
  standalone = readStandalone()
  snapshot = compute()

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // keep it for our own "Cài app" button instead of the browser mini-infobar
    deferred = e as BeforeInstallPromptEvent
    publish()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    publish()
  })
  if (typeof window.matchMedia === 'function') {
    for (const q of STANDALONE_QUERIES) {
      window.matchMedia(q).addEventListener('change', () => {
        standalone = readStandalone()
        publish()
      })
    }
  }
}

function subscribe(listener: () => void) {
  initPwa()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => snapshot

/** Install state for the "Cài app" button. Stable object between changes (safe for React). */
export function usePwaInstall(): PwaInstallState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------- service worker ----------------
/**
 * Register the service worker (precached app shell, works offline, auto-updates).
 * Production http(s) only: skipped in dev, inside Electron (the app is already local) and on file:.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof window === 'undefined') return
  if (isDesktop()) return
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return
  void import('virtual:pwa-register')
    .then(({ registerSW }) =>
      registerSW({
        // immediate: false → registers after the window "load" event, so precaching never competes with startup.
        // A new version took over: the old page may now miss lazy chunks, so save and reload.
        onNeedReload: () => void reloadForUpdate(),
      }),
    )
    .catch(() => undefined)
}

/**
 * Is the user in the middle of something a reload would interrupt: a dialog open, or typing in a text field
 * (prompt editor, rename box…)? Exported for tests.
 */
export function isUserBusy(dialogOpen: boolean, active: Element | null): boolean {
  if (dialogOpen) return true
  const el = active as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type)
  }
  return !!el.isContentEditable
}

let reloading = false
let updateToast: number | null = null

/** Save what is unsaved, then load the new version. */
async function saveAndReload() {
  if (reloading) return
  reloading = true
  try {
    // Before bootstrap finished there is nothing of the user's in memory to save.
    if (useSave.getState().ready) await flush()
  } catch {
    /* reload anyway: the pagehide handler writes the emergency backup */
  }
  window.location.reload()
}

/**
 * A new version took over. Reload now unless the user is busy (dialog open / typing): then a toast that stays
 * ("Đã có phiên bản mới" · "Tải lại") lets them reload when they are ready.
 */
async function reloadForUpdate() {
  if (reloading) return
  const busy = isUserBusy(useUI.getState().dialog.kind !== 'none', typeof document !== 'undefined' ? document.activeElement : null)
  if (!busy) {
    if (useSave.getState().ready) toast('Đã có phiên bản mới — đang lưu và tải lại…', { tone: 'info', ms: 4000 })
    await saveAndReload()
    return
  }
  if (updateToast !== null && useUI.getState().toasts.some((t) => t.id === updateToast)) return
  updateToast = toast('Đã có phiên bản mới', {
    tone: 'info',
    persistent: true,
    action: { label: 'Tải lại', run: () => void saveAndReload() },
  })
}

// Desktop app on macOS: tells the main process whether takes are queued / being made, so a window hidden by its close
// button / ⌘W keeps working at full speed (and keeps the Mac awake) ONLY then — electron/hardening-rules.cjs
// createHiddenWork, IPC 'app:busy' through electron/preload.cjs bdpDesktop.app.setBusy (only a boolean crosses).
// The first answer, then changes only. Windows and the browser: nothing is sent (nothing listens there).
import { useProject } from '../store/project'
import { currentRestartWork, useRuns } from '../store/runs'

/** window.bdpDesktop.app.setBusy (electron/preload.cjs, macOS builds from 0.6.0 on). */
export interface DesktopBusyBridge {
  setBusy(busy: boolean): Promise<unknown>
}

export interface BusyReporterDeps {
  /** Takes queued / being made right now. */
  busy: () => boolean
  send: (busy: boolean) => void
  /** Calls the listener when the answer may have changed; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

/** Sends the current answer once, then only when it changes. Returns the stop function. */
export function startBusyReporter(deps: BusyReporterDeps): () => void {
  let last: boolean | null = null
  const report = () => {
    const busy = deps.busy()
    if (busy === last) return
    last = busy
    deps.send(busy)
  }
  report()
  return deps.subscribe(report)
}

/** The bridge, only in the macOS desktop app (the only place a hidden window keeps running). */
export function desktopBusyBridge(): DesktopBusyBridge | null {
  if (typeof window === 'undefined') return null
  const desktop = window.bdpDesktop
  if (!desktop || desktop.platform !== 'darwin') return null
  const app = desktop.app as { setBusy?: unknown } | undefined
  return app && typeof app === 'object' && typeof app.setBusy === 'function' ? (app as unknown as DesktopBusyBridge) : null
}

/** What an app restart would interrupt (runs.restartWork: queued takes of existing scenes + running ones) is "busy". */
function busyNow(): boolean {
  const work = currentRestartWork()
  return work.queued + work.processing > 0
}

/** Called once from App's Shell (an effect: returns its cleanup). */
export function startDesktopBusy(): () => void {
  const bridge = desktopBusyBridge()
  if (!bridge) return () => {}
  return startBusyReporter({
    busy: busyNow,
    send: (busy) => {
      try {
        void Promise.resolve(bridge.setBusy(busy)).catch(() => {})
      } catch {
        // an older main process without 'app:busy': the hidden window simply is not kept working
      }
    },
    subscribe: (listener) => {
      const offRuns = useRuns.subscribe((s, prev) => {
        if (s.takes !== prev.takes) listener()
      })
      // A deleted scene's queued take never starts (restartWork leaves it out); another project opened.
      const offProject = useProject.subscribe((s, prev) => {
        if (s.project.id !== prev.project.id || s.project.scenes.length !== prev.project.scenes.length) listener()
      })
      return () => {
        offRuns()
        offProject()
      }
    },
  })
}

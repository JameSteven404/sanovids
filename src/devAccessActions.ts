// The development-mode lock, app side (providers/devAccess mirrors main; electron/devaccess.cjs decides):
//   initDevAccess()          once, before the first render (main.tsx): the browser simulation on loopback hosts, the
//                            sync with main, and what follows a change of access.
//   When it LOCKS            Bảng phát triển closes, and so do "Nạp credit" / "Nhập job" when they were on the
//                            simulated gateway (closesOnLock: they would follow the real canvasapp gateway otherwise);
//                            the simulated login / SePay sheets close (answered "closed"), a toast says why (by hand /
//                            time ran out / clock went back). Running DEV takes finish (the engine keeps polling them
//                            through getProvider('dev')); saved DEV takes stay viewable.
//   One-time notice          locked + development mode was used on this device (the simulated server's data) + not
//                            shown before → "Chế độ Phát triển đã được ẩn…" [Mở Cài đặt]. It never turns the canvasapp
//                            gateway on (real money): only the user does, in Cài đặt.
//   unlockDevAccess / lockDevAccess / setDevKeep / beginTotpLink / confirmTotpLink / cancelTotpLink / removeTotpLink
//                            the UI's calls (DevUnlock, DevTotpLink, DevAccessRows): forward to the bridge, mirror the
//                            answer. Main checks every one of them; nothing here decides an unlock.
import { openSettings } from './actions'
import { closesOnLock, DEV_HIDDEN_NOTICE, DEV_HIDDEN_NOTICE_KEY, DEV_TRACE_KEYS, lockToastText, shouldNoticeHidden } from './components/dev/devUnlockModel'
import { effectiveProvider, useProviderPrefs } from './providers'
import { canvasappHiddenInSano, hasCanvasappBridge } from './providers/canvasapp/transport'
import { installDevAccessSim } from './providers/dev/devAccess'
import { closeDevPrompts } from './providers/dev/prompts'
import {
  applyDevAccessState,
  devAccessBridge,
  parseDevAccessResult,
  parseDevAccessState,
  startDevAccessSync,
  useDevAccess,
  whenDevAccessKnown,
  type DevAccessResult,
  type DevTotpBegin,
} from './providers/devAccess'
import { toast, useUI } from './store/ui'

let started = false

function isElectron(): boolean {
  return typeof window !== 'undefined' && (!!(window as { bdpDesktop?: unknown }).bdpDesktop || (typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)))
}

/** What follows a change of access (also the simulation's "Xem như bản phát hành"). */
function onAccessChange(next: ReturnType<typeof useDevAccess.getState>, prev: ReturnType<typeof useDevAccess.getState>) {
  if (next.state.access === prev.state.access) return
  if (next.state.access !== 'locked') return
  // The gateway new takes used right before the lock (the saved choice is never rewritten by locking).
  const wasSimulated = effectiveProvider({ access: prev.state.access, saved: useProviderPrefs.getState().provider, bridge: hasCanvasappBridge() }) === 'dev'
  if (closesOnLock(useUI.getState().dialog, wasSimulated)) useUI.getState().closeDialog()
  closeDevPrompts()
  toast(lockToastText(next.reason), { tone: next.reason ? 'warning' : 'info' })
}

function readStorage(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function maybeNoticeHidden() {
  const access = useDevAccess.getState().state.access
  const hasDevTraces = DEV_TRACE_KEYS.some((k) => readStorage(k) !== null)
  if (!shouldNoticeHidden({ access, hasDevTraces, noticed: readStorage(DEV_HIDDEN_NOTICE_KEY) !== null, inSano: canvasappHiddenInSano() })) return
  try {
    localStorage.setItem(DEV_HIDDEN_NOTICE_KEY, String(Date.now()))
  } catch {
    /* shown again next time: harmless */
  }
  toast(DEV_HIDDEN_NOTICE, { tone: 'info', persistent: true, action: { label: 'Mở Cài đặt', run: () => openSettings('gateway') } })
}

export function initDevAccess(): void {
  if (started) return
  started = true
  if (!isElectron() && typeof window !== 'undefined') {
    let host: string | undefined
    try {
      host = window.location.hostname
    } catch {
      host = undefined
    }
    installDevAccessSim(host)
  }
  startDevAccessSync()
  // After the first answer (a reload keeps the window's first value): never a notice — nor a "locked" toast — from a
  // stale initial value; every change after that is followed.
  void whenDevAccessKnown().then(() => {
    useDevAccess.subscribe(onAccessChange)
    maybeNoticeHidden()
  })
}

// ---- the UI's calls ----

const NO_BRIDGE: DevAccessResult = { ok: false, error: 'not-desktop' }

async function call(run: (b: NonNullable<ReturnType<typeof devAccessBridge>>) => Promise<unknown>): Promise<DevAccessResult> {
  const bridge = devAccessBridge()
  if (!bridge) return NO_BRIDGE
  let res: DevAccessResult
  try {
    res = parseDevAccessResult(await run(bridge))
  } catch {
    res = { ok: false, error: 'failed' }
  }
  if (res.ok) applyDevAccessState(res.state)
  return res
}

/** The unlock box: a 6-digit code or an SV1 code (main checks it). */
export function unlockDevAccess(code: string): Promise<DevAccessResult> {
  return call((b) => b.unlock(code.slice(0, 300)))
}

/** "Khoá lại ngay". */
export async function lockDevAccess(): Promise<void> {
  const bridge = devAccessBridge()
  if (!bridge) return
  try {
    const st = parseDevAccessState(await bridge.lock())
    if (st) applyDevAccessState(st)
  } catch {
    /* the push (or the next read) brings the state */
  }
}

/** "Giữ mở khoá": 1 / 7 / 30 days, 0 = until locked. */
export function setDevKeep(days: number): Promise<DevAccessResult> {
  return call((b) => b.setKeep(days))
}

/** Start linking (only inside the link window main opened after a code unlock; once per window). */
export async function beginTotpLink(): Promise<DevTotpBegin> {
  const bridge = devAccessBridge()
  if (!bridge) return { ok: false, error: 'not-desktop' }
  try {
    const raw = (await bridge.totpBegin()) as Record<string, unknown> | null
    if (raw && raw.ok === true && typeof raw.uri === 'string' && Array.isArray(raw.secretGroups) && raw.secretGroups.every((g) => typeof g === 'string' && /^[A-Z2-7]{1,4}$/.test(g)) && typeof raw.label === 'string') {
      return { ok: true, uri: raw.uri, secretGroups: raw.secretGroups as string[], label: raw.label }
    }
    return { ok: false, error: raw && typeof raw.error === 'string' ? raw.error : 'failed' }
  } catch {
    return { ok: false, error: 'failed' }
  }
}

export function confirmTotpLink(code: string): Promise<DevAccessResult> {
  return call((b) => b.totpConfirm(code.slice(0, 300)))
}

/** "Để sau" / closing the box or Cài đặt: main drops the pending secret and closes the window. */
export async function cancelTotpLink(): Promise<void> {
  const bridge = devAccessBridge()
  if (!bridge) return
  try {
    const st = parseDevAccessState(await bridge.linkCancel())
    if (st) applyDevAccessState(st)
  } catch {
    /* nothing pending then */
  }
}

export function removeTotpLink(): Promise<DevAccessResult> {
  return call((b) => b.totpRemove())
}

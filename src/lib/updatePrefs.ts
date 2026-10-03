// Auto-update preference of this device ("Cài đặt → Cập nhật"):
// - autoDownload ("Tự động tải bản cập nhật", default on): the installer build downloads a new version in the
//   background and installs it on quit / restart. Off: SanoVids only says a new version exists; the user downloads it.
// Distinct from lib/downloads `autoDownload` ("Tự tải khi video xong"). This store is the source of truth: lib/updates
// pushes the value to the main process at startup and on every change (main keeps a copy for checks made before the
// page is up). Saved in localStorage 'bdp:pref:updates', validated on read.
import { create } from 'zustand'

export interface UpdatePrefs {
  /** Download new versions in the background (installer build only). */
  autoDownload: boolean
}

export const UPDATE_PREFS_KEY = 'bdp:pref:updates'
export const DEFAULT_UPDATE_PREFS: UpdatePrefs = { autoDownload: true }

/** Stored JSON → prefs (unknown keys ignored, wrong types / garbage → defaults). */
export function parseUpdatePrefs(raw: string | null | undefined): UpdatePrefs {
  if (!raw) return { ...DEFAULT_UPDATE_PREFS }
  try {
    const saved = JSON.parse(raw) as Partial<Record<keyof UpdatePrefs, unknown>> | null
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...DEFAULT_UPDATE_PREFS }
    return { autoDownload: typeof saved.autoDownload === 'boolean' ? saved.autoDownload : DEFAULT_UPDATE_PREFS.autoDownload }
  } catch {
    return { ...DEFAULT_UPDATE_PREFS }
  }
}

function readPrefs(): UpdatePrefs {
  try {
    return parseUpdatePrefs(localStorage.getItem(UPDATE_PREFS_KEY))
  } catch {
    return { ...DEFAULT_UPDATE_PREFS }
  }
}

export type UpdatePrefsState = UpdatePrefs & { set: (patch: Partial<UpdatePrefs>) => void }

export const useUpdatePrefs = create<UpdatePrefsState>()((setState, getState) => ({
  ...readPrefs(),
  set: (patch) => {
    if (!patch || typeof patch.autoDownload !== 'boolean' || patch.autoDownload === getState().autoDownload) return
    setState({ autoDownload: patch.autoDownload })
    try {
      localStorage.setItem(UPDATE_PREFS_KEY, JSON.stringify({ autoDownload: getState().autoDownload }))
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
  },
}))

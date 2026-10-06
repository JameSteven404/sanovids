// Development mode: a simulated answer of "where does the app run from" (window.bdpDesktop.app.placement() in the
// desktop app, electron/main.cjs IPC 'app:placement') so the Portable / temp-copy reminder of "Cài đặt → Ứng dụng /
// Giới thiệu" can be tried in the browser (`npm run dev`). lib/appPlacement uses it ONLY outside Electron. Driven from
// "Bảng phát triển → Cập nhật → Vị trí chạy" (components/dev/DevPanel.tsx).
//
// ---- API ----
//   useDevPlacement                  zustand store { kind } (default 'dev': running from the sources, no reminder).
//   devPlacementBridge()             the app's simulated bridge (created on first use): placement() resolves a copy of
//                                    the store after DEV_PLACEMENT_DELAY_MS.
//   devPlacement.simulate(kind)      'installer' | 'portable' | 'temp-copy' | 'dev' (anything else is ignored).
//   devPlacement.reset()             back to 'dev'.
//   DEV_PLACEMENT_OPTIONS            the Segmented control's options.
//   createDevPlacementBridge(store, delayMs)   a separate instance (tests).
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { AppPlacement, AppPlacementKind, DesktopPlacementBridge } from '../../lib/appPlacement'

const KINDS: readonly AppPlacementKind[] = ['installer', 'portable', 'temp-copy', 'dev']

/** "Vị trí chạy" (Segmented). */
export const DEV_PLACEMENT_OPTIONS: { id: AppPlacementKind; label: string; title: string }[] = [
  { id: 'installer', label: 'Bản cài', title: 'Cài bằng SanoVids-Setup: có icon Desktop / Start, tự cập nhật' },
  { id: 'portable', label: 'Bản Portable', title: 'SanoVids-Portable: không icon, không tự cập nhật — hiện lời nhắc cài bản Setup' },
  { id: 'temp-copy', label: 'Thư mục tạm', title: 'Bản sao chạy thẳng từ thư mục tạm của Windows — hiện lời nhắc cài bản Setup' },
  { id: 'dev', label: 'Bản phát triển', title: 'Chạy từ mã nguồn: không có lời nhắc' },
]

/** Time a simulated answer takes. */
export const DEV_PLACEMENT_DELAY_MS = 150

export const useDevPlacement: UseBoundStore<StoreApi<{ kind: AppPlacementKind }>> = create<{ kind: AppPlacementKind }>()(() => ({ kind: 'dev' }))

/** A simulated bridge reading `store`: each answer is a fresh copy taken when it resolves. */
export function createDevPlacementBridge(store: StoreApi<{ kind: AppPlacementKind }> = useDevPlacement, delayMs = DEV_PLACEMENT_DELAY_MS): DesktopPlacementBridge {
  return {
    placement: () => new Promise<AppPlacement>((resolve) => setTimeout(() => resolve({ kind: store.getState().kind }), delayMs)),
  }
}

let appBridge: DesktopPlacementBridge | null = null

/** The app's simulated answer (development mode in a browser). */
export function devPlacementBridge(): DesktopPlacementBridge {
  return (appBridge ??= createDevPlacementBridge())
}

/** Set `store` to a kind (unknown values are ignored). */
export function simulateDevPlacement(store: StoreApi<{ kind: AppPlacementKind }>, kind: AppPlacementKind): void {
  if (!(KINDS as readonly string[]).includes(kind)) return
  store.setState({ kind }, true)
}

/** Controls of "Bảng phát triển → Cập nhật → Vị trí chạy". */
export const devPlacement = {
  simulate: (kind: AppPlacementKind) => simulateDevPlacement(useDevPlacement, kind),
  reset: () => simulateDevPlacement(useDevPlacement, 'dev'),
}

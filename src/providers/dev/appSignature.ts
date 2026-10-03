// Development mode: a simulated answer of the app's code-signature self-check (window.bdpDesktop.app.signature() in the
// desktop app, electron/main.cjs) so every state of "Cài đặt → Giới thiệu" can be tried in the browser (`npm run dev`).
// Nothing is checked. lib/appSignature uses it ONLY outside Electron. Driven from "Bảng phát triển → Cập nhật → Chữ ký số
// (Giới thiệu)" (components/dev/DevUpdatesTab.tsx).
//
// ---- API ----
//   useDevSignature                    zustand store: the simulated AppSignature (default: unsigned, not packaged).
//   devSignatureBridge()               the app's simulated DesktopAppBridge (created on first use): signature() resolves a
//                                      copy of the store after DEV_SIGNATURE_DELAY_MS.
//   devSignature.simulate(preset)      'signed' | 'dev' | 'unsigned-packaged' | 'other' | 'impostor' | 'tampered' | 'unknown'.
//   devSignature.reset()               back to the default.
//   devSignaturePresetOf(sig)          the preset a state corresponds to (the Segmented control's value).
//   createDevSignatureBridge(store, delayMs)   a separate instance (tests).
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { ABOUT_AUTHOR, ABOUT_OFFICIAL_THUMBPRINT, borrowsAuthorName } from '../../lib/aboutModel'
import type { AppSignature, DesktopAppBridge } from '../../lib/appSignature'

export type DevSignaturePreset = 'signed' | 'dev' | 'unsigned-packaged' | 'other' | 'impostor' | 'tampered' | 'unknown'

export const DEV_SIGNATURE_PRESET_IDS: readonly DevSignaturePreset[] = ['signed', 'dev', 'unsigned-packaged', 'other', 'impostor', 'tampered', 'unknown']

/** Simulated foreign certificate (a made-up thumbprint, never a real one). */
export const DEV_OTHER_SIGNER = 'Người lạ (giả lập)'
export const DEV_OTHER_THUMBPRINT = '0123456789ABCDEF0123456789ABCDEF01234567'
/** Simulated impostor certificate carrying the author's exact name (made-up thumbprint): only the thumbprint differs. */
export const DEV_IMPOSTOR_THUMBPRINT = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98'

export const DEV_SIGNATURE_PRESETS: Readonly<Record<DevSignaturePreset, Readonly<AppSignature>>> = {
  signed: { status: 'signed', packaged: true, signer: ABOUT_AUTHOR, thumbprint: ABOUT_OFFICIAL_THUMBPRINT },
  dev: { status: 'unsigned', packaged: false },
  'unsigned-packaged': { status: 'unsigned', packaged: true },
  other: { status: 'other-signer', packaged: true, signer: DEV_OTHER_SIGNER, thumbprint: DEV_OTHER_THUMBPRINT },
  impostor: { status: 'other-signer', packaged: true, signer: ABOUT_AUTHOR, thumbprint: DEV_IMPOSTOR_THUMBPRINT },
  tampered: { status: 'tampered', packaged: true },
  unknown: { status: 'unknown', packaged: true },
}

/** Segmented control of "Chữ ký số (Giới thiệu)". */
export const DEV_SIGNATURE_OPTIONS: { id: DevSignaturePreset; label: string; title: string }[] = [
  { id: 'signed', label: 'Đã ký', title: 'Bản gốc: ký số bởi tác giả, chữ ký còn nguyên vẹn' },
  { id: 'dev', label: 'Chưa ký – bản phát triển', title: 'Chạy từ mã nguồn: không có chữ ký số (bình thường)' },
  { id: 'unsigned-packaged', label: 'Chưa ký – bản cài', title: 'Bản cài / portable không có chữ ký số' },
  { id: 'other', label: 'Người ký khác', title: 'Ký bởi một chứng chỉ khác chứng chỉ của tác giả' },
  { id: 'impostor', label: 'Giả tên tác giả', title: 'Chứng chỉ mang đúng tên tác giả nhưng khác dấu vân tay (bản giả mạo)' },
  { id: 'tampered', label: 'Bị sửa', title: 'File đã bị thay đổi sau khi ký' },
  { id: 'unknown', label: 'Không rõ', title: 'Windows không cho đọc chữ ký số (PowerShell bị chặn hoặc quá lâu)' },
]

/** Time a simulated self-check takes. */
export const DEV_SIGNATURE_DELAY_MS = 300

const cloneSig = (s: Readonly<AppSignature>): AppSignature => {
  const out: AppSignature = { status: s.status, packaged: s.packaged }
  if (s.signer !== undefined) out.signer = s.signer
  if (s.thumbprint !== undefined) out.thumbprint = s.thumbprint
  return out
}

export const useDevSignature: UseBoundStore<StoreApi<AppSignature>> = create<AppSignature>()(() => cloneSig(DEV_SIGNATURE_PRESETS.dev))

/** The preset a state corresponds to. */
export function devSignaturePresetOf(sig: Pick<AppSignature, 'status' | 'packaged' | 'signer'>): DevSignaturePreset {
  switch (sig.status) {
    case 'signed':
      return 'signed'
    case 'other-signer':
      return borrowsAuthorName(sig.signer) ? 'impostor' : 'other'
    case 'tampered':
      return 'tampered'
    case 'unsigned':
      return sig.packaged ? 'unsigned-packaged' : 'dev'
    default:
      return 'unknown'
  }
}

/** A simulated bridge reading `store`: each answer is a fresh copy taken when it resolves. */
export function createDevSignatureBridge(store: StoreApi<AppSignature> = useDevSignature, delayMs = DEV_SIGNATURE_DELAY_MS): DesktopAppBridge {
  return {
    signature: () => new Promise<AppSignature>((resolve) => setTimeout(() => resolve(cloneSig(store.getState())), delayMs)),
  }
}

let appBridge: DesktopAppBridge | null = null

/** The app's simulated self-check (development mode in a browser). */
export function devSignatureBridge(): DesktopAppBridge {
  return (appBridge ??= createDevSignatureBridge())
}

/** Set `store` to a preset (unknown ids are ignored). */
export function simulateDevSignature(store: StoreApi<AppSignature>, preset: DevSignaturePreset): void {
  if (!(DEV_SIGNATURE_PRESET_IDS as readonly string[]).includes(preset)) return
  // Replace (not merge): a preset without signer / thumbprint must drop the previous ones.
  store.setState(cloneSig(DEV_SIGNATURE_PRESETS[preset]), true)
}

/** Controls of "Bảng phát triển → Cập nhật → Chữ ký số (Giới thiệu)". */
export const devSignature = {
  simulate: (preset: DevSignaturePreset) => simulateDevSignature(useDevSignature, preset),
  reset: () => simulateDevSignature(useDevSignature, 'dev'),
}

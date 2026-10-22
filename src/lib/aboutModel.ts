// What "Cài đặt → Cơ bản → Giới thiệu" shows (components/dialogs/SettingsBasic.tsx AboutBlock) — pure: no stores, no
// React, no bridge; every user-facing string of the block lives here. Tested in __tests__/aboutModel.test.ts.
// The signature state comes from lib/appSignature.ts. The author is the main developer; Sano Group is credited only as
// a partner ("Đồng hành"). The strings match package.json author.name / build.copyright / sanovids.signers (tested).
//
// The Mac build (phase 1) is signed ad hoc: anyone can re-sign an app that way, so it proves nothing about the author.
// On a Mac the block never claims a verified signature and never shows the Windows certificate thumbprints: every
// packaged answer reads "Bản cho Mac — chưa có chữ ký của Apple" (main sends { status: 'unknown', packaged: true }
// there), with the same SHA-256 advice as the licence and the release notes.
//
// ---- API ----
//   ABOUT_*                         titles, search keywords, author / partner / copyright / licence / open-source lines.
//   ABOUT_OFFICIAL_THUMBPRINT       the pinned certificate of official builds (package.json sanovids.signers[0]).
//   formatThumbprint(t)             '7489ABFA…' → '7489 ABFA …' (groups of 4).
//   thumbprintLine(t)               'Dấu vân tay chứng chỉ: …'.
//   officialThumbprintLine()        'Bản chính thức — dấu vân tay chứng chỉ: …'.
//   thumbprintRows(sig, platform?)  the thumbprint line(s) under the signature row, as { label, value } ([] on a Mac).
//   versionLine(version, kind, desktop)   'Phiên bản 0.5.0 · Bản cài' ('… · Bản cho Mac' for kind 'mac-manual').
//   signatureView(sig, platform?)   tone, title and detail of the signature row (platform: lib/platform, default this
//                                   device's; tests and the development-mode simulation pass it).
//   aboutOpenSource(platform?)      where the open-source licences are (install folder / inside SanoVids.app).
//   MAC_SIGNATURE_TITLE / _DETAIL   the Mac build's signature row (not Apple-signed, ad hoc: no author verification).
//   borrowsAuthorName(signer)       a certificate name that copies the author's (an impostor when not pinned).
//   placementNote(kind, updateKind) the reminder of a Portable build / a copy left in Windows' temp folder (no Desktop /
//                                   Start icon, no auto-update): shown in "Ứng dụng" and "Giới thiệu" (null = none).
//   PLACEMENT_KEYWORDS              search words of that reminder (Settings group "Ứng dụng").
// Only `sanovids` is imported from package.json (a named import keeps `build` and the rest out of the bundle).
import { sanovids } from '../../package.json'
import type { AppPlacementKind } from './appPlacement'
import type { AppSignature } from './appSignature'
import { PLATFORM, type Platform } from './platform'
import { UPDATE_RELEASES_PAGE_LABEL, type UpdateKind } from './updateTypes'

export const ABOUT_TITLE = 'Giới thiệu'
export const ABOUT_DESC = 'Phiên bản, tác giả, bản quyền và chữ ký số của SanoVids.'
export const ABOUT_KEYWORDS =
  'about thông tin tác giả author bản quyền copyright nguyễn giang minh jame steven sano group đồng hành chữ ký số ký số chứng chỉ certificate signature vân tay thumbprint bản gốc chính thức phiên bản version giấy phép license mã nguồn mở open source electron trang tải về download github'

export const ABOUT_AUTHOR = 'Nguyễn Giang Minh (Jame Steven)'
export const ABOUT_AUTHOR_LINE = 'Tác giả: Nguyễn Giang Minh (Jame Steven)'
export const ABOUT_PARTNER_LINE = 'Đồng hành: Sano Group'
export const ABOUT_COPYRIGHT = '© 2026 Nguyễn Giang Minh (Jame Steven). Mọi quyền được bảo lưu.'
export const ABOUT_LICENSE_NOTE =
  'Chỉ dùng khi được tác giả cho phép (ví dụ: trong nội bộ nhóm). Không sao chép, chỉnh sửa, dịch ngược hay phân phối lại khi chưa có đồng ý bằng văn bản của tác giả.'
export const ABOUT_OPEN_SOURCE =
  'SanoVids dùng các thành phần mã nguồn mở (Electron, Chromium, React…). Giấy phép của chúng nằm trong thư mục cài đặt (LICENSE.electron.txt, LICENSES.chromium.html, THIRD-PARTY-NOTICES.txt).'
/** The Mac build keeps them inside the app bundle (package.json build.mac.extraResources → Contents/Resources). */
export const ABOUT_OPEN_SOURCE_MAC =
  'SanoVids dùng các thành phần mã nguồn mở (Electron, Chromium, React…). Giấy phép của chúng nằm trong gói ứng dụng: chuột phải SanoVids → Hiển thị nội dung gói (Show Package Contents) → Contents/Resources (LICENSE.electron.txt, LICENSES.chromium.html, THIRD-PARTY-NOTICES.txt).'

/** Where the open-source licences are on this platform (lib/platform; default: this device). */
export function aboutOpenSource(platform: Platform = PLATFORM): string {
  return platform === 'mac' ? ABOUT_OPEN_SOURCE_MAC : ABOUT_OPEN_SOURCE
}
export const ABOUT_DOWNLOAD_LINE = 'Trang tải về chính thức: ' + UPDATE_RELEASES_PAGE_LABEL
export const ABOUT_OPEN_PAGE = 'Mở trang tải về'
export const ABOUT_OPEN_PAGE_TITLE = `Mở ${UPDATE_RELEASES_PAGE_LABEL} trong trình duyệt`

/** Thumbprint of the certificate official builds are signed with (the first pin of package.json sanovids.signers). */
export const ABOUT_OFFICIAL_THUMBPRINT: string = sanovids.signers[0]

/** '7489ABFAC1A7…' → '7489 ABFA C1A7 …' (whitespace dropped, upper case, groups of 4). */
export function formatThumbprint(t: string): string {
  const hex = t.replace(/\s+/g, '').toUpperCase()
  return (hex.match(/.{1,4}/g) ?? []).join(' ')
}

const THUMB_LABEL = 'Dấu vân tay chứng chỉ'
const OFFICIAL_THUMB_LABEL = 'Bản chính thức — dấu vân tay chứng chỉ'

export function thumbprintLine(t: string): string {
  return `${THUMB_LABEL}: ${formatThumbprint(t)}`
}

export function officialThumbprintLine(): string {
  return `${OFFICIAL_THUMB_LABEL}: ${formatThumbprint(ABOUT_OFFICIAL_THUMBPRINT)}`
}

/** One thumbprint line split for display: `${label}: ${value}` is thumbprintLine / officialThumbprintLine. */
export interface ThumbprintRow {
  label: string
  /** Grouped by 4 (formatThumbprint). */
  value: string
}

/**
 * The line(s) under the signature row: the running file's certificate when known, else the official one. A file signed
 * by someone else shows both, so the two can be compared. On a Mac: none (those are the Windows certificate's; the Mac
 * build carries no author signature to compare with).
 */
export function thumbprintRows(sig: AppSignature | null, platform: Platform = PLATFORM): ThumbprintRow[] {
  if (platform === 'mac') return []
  const official: ThumbprintRow = { label: OFFICIAL_THUMB_LABEL, value: formatThumbprint(ABOUT_OFFICIAL_THUMBPRINT) }
  if (!sig?.thumbprint) return [official]
  const own: ThumbprintRow = { label: THUMB_LABEL, value: formatThumbprint(sig.thumbprint) }
  return sig.status === 'other-signer' ? [own, official] : [own]
}

/** Kind of build as the About block names it. */
export function buildLabel(kind: UpdateKind, desktop: boolean): string {
  if (kind === 'installer') return 'Bản cài'
  if (kind === 'portable') return 'Bản portable'
  if (kind === 'mac-manual') return 'Bản cho Mac'
  return desktop ? 'Bản phát triển' : 'Bản web'
}

/** 'Phiên bản 0.5.0 · Bản cài'. */
export function versionLine(version: string, kind: UpdateKind, desktop: boolean): string {
  return `Phiên bản ${version} · ${buildLabel(kind, desktop)}`
}

export type AboutTone = 'ok' | 'warn' | 'neutral'

export interface SignatureView {
  tone: AboutTone
  title: string
  detail: string
}

/** Accent-free, lower case, single spaces (the same for NFC and NFD input; đ → d). */
function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const AUTHOR_NAME_PARTS = ['nguyen giang minh', 'jame steven']

/**
 * The certificate's name borrows the author's name (any case, accents or spacing) — the certificate is still not the
 * author's when its thumbprint is not pinned: only the thumbprint is trusted, never the name.
 */
export function borrowsAuthorName(signer: string | undefined): boolean {
  if (!signer) return false
  const name = foldName(signer)
  return AUTHOR_NAME_PARTS.some((part) => name.includes(part))
}

/** The Mac build's signature row: never "signed" — an ad-hoc signature does not tell who made the app. */
export const MAC_SIGNATURE_TITLE = 'Bản cho Mac — chưa có chữ ký của Apple'
export const MAC_SIGNATURE_DETAIL =
  'Bản Mac hiện chưa được Apple ký và công chứng, nên lần đầu mở (và mỗi bản mới) macOS sẽ cảnh báo. Chỉ tải SanoVids ở trang tải về chính thức và đối chiếu mã SHA-256 với tác giả qua một nguồn khác trang tải về.'

const DEV_SIGNATURE_VIEW: SignatureView = { tone: 'neutral', title: 'Bản phát triển (chưa ký số)', detail: 'Chạy từ mã nguồn nên không có chữ ký số — bình thường khi phát triển.' }

/**
 * The signature row: null = still checking. `platform` (lib/platform): on a Mac a packaged build always reads
 * MAC_SIGNATURE_* (phase 1: ad hoc, main does not check anything there), the sources read as a development build; the
 * Windows texts (PowerShell, DLLs, certificate) never show there.
 */
export function signatureView(sig: AppSignature | null, platform: Platform = PLATFORM): SignatureView {
  if (!sig) return { tone: 'neutral', title: 'Đang kiểm tra chữ ký số…', detail: '' }
  if (platform === 'mac') return sig.packaged ? { tone: 'neutral', title: MAC_SIGNATURE_TITLE, detail: MAC_SIGNATURE_DETAIL } : { ...DEV_SIGNATURE_VIEW }
  switch (sig.status) {
    case 'signed':
      return { tone: 'ok', title: `Đã ký số bởi ${sig.signer || ABOUT_AUTHOR} ✓`, detail: 'Bản gốc — file chương trình và các thư viện DLL chính còn nguyên chữ ký số của tác giả.' }
    case 'other-signer':
      // An impostor certificate carrying the author's own name: "signed by X, not the author X" would read like a glitch.
      if (borrowsAuthorName(sig.signer)) {
        return {
          tone: 'warn',
          title: 'Không phải bản gốc — có thể là bản giả mạo',
          detail: `Bản này được ký bằng một chứng chỉ mang tên “${sig.signer}” nhưng KHÔNG phải chứng chỉ của tác giả (dấu vân tay khác với bản chính thức bên dưới). Hãy tải lại bản chính thức ở trang tải về và so dấu vân tay trước khi cài.`,
        }
      }
      return {
        tone: 'warn',
        title: 'Không phải bản gốc',
        detail: `Bản này được ký bởi “${sig.signer || 'người khác'}”, không phải tác giả Nguyễn Giang Minh (Jame Steven). Hãy tải lại bản chính thức ở trang tải về.`,
      }
    case 'tampered':
      return {
        tone: 'warn',
        title: 'File của SanoVids đã bị thay đổi',
        detail: 'Chữ ký số không còn khớp với nội dung file. Hãy tải lại bản chính thức ở trang tải về rồi cài đè.',
      }
    case 'unsigned':
      return sig.packaged
        ? {
            tone: 'warn',
            title: 'Bản này không có chữ ký số',
            detail: 'Bản cài chính thức luôn được ký số bởi Nguyễn Giang Minh (Jame Steven). Hãy tải bản chính thức ở trang tải về.',
          }
        : { ...DEV_SIGNATURE_VIEW }
    default:
      return {
        tone: 'neutral',
        title: 'Chưa kiểm tra được chữ ký số',
        detail: 'Windows không cho đọc chữ ký số lúc này (PowerShell bị chặn hoặc quá lâu). Bản chính thức luôn được ký số bởi Nguyễn Giang Minh (Jame Steven).',
      }
  }
}

// ---------------- where the app runs from (lib/appPlacement) ----------------
/** Search words of the Portable / temp-copy reminder (Settings group "Ứng dụng"). */
export const PLACEMENT_KEYWORDS = 'icon lối tắt shortcut desktop start menu ghim portable cài đặt setup'

export interface PlacementNote {
  kind: 'portable' | 'temp-copy'
  text: string
  /** The button: the official download page (lib/updates openReleasePage). */
  action: string
}

export const PLACEMENT_PORTABLE_TEXT =
  'Bản Portable: không có icon ở Desktop / Start và không tự cập nhật. Muốn có icon và tự cập nhật, hãy cài bản Setup.'
export const PLACEMENT_TEMP_TEXT =
  'SanoVids đang chạy từ thư mục tạm của Windows — thư mục này có thể bị xoá bất cứ lúc nào. Hãy cài bản Setup để có icon và tự cập nhật.'

/**
 * The reminder to install the Setup build: a Portable build, or a copy running from Windows' temp folder (what an
 * interrupted Setup / Portable run leaves behind). `kind`: lib/appPlacement (null = not known yet, 'unknown' = could
 * not be told); without it, the updater's own kind still tells a Portable build. null = nothing to say.
 */
export function placementNote(kind: AppPlacementKind | 'unknown' | null | undefined, updateKind?: UpdateKind): PlacementNote | null {
  const k = kind && kind !== 'unknown' ? kind : updateKind === 'portable' ? 'portable' : null
  if (k === 'portable') return { kind: 'portable', text: PLACEMENT_PORTABLE_TEXT, action: ABOUT_OPEN_PAGE }
  if (k === 'temp-copy') return { kind: 'temp-copy', text: PLACEMENT_TEMP_TEXT, action: ABOUT_OPEN_PAGE }
  return null
}

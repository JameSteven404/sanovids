// What "Cài đặt → Cơ bản → Giới thiệu" shows (components/dialogs/SettingsBasic.tsx AboutBlock) — pure: no stores, no
// React, no bridge; every user-facing string of the block lives here. Tested in __tests__/aboutModel.test.ts.
// The signature state comes from lib/appSignature.ts. The author is the main developer; Sano Group is credited only as
// a partner ("Đồng hành"). The strings match package.json author.name / build.copyright / sanovids.signers (tested).
//
// ---- API ----
//   ABOUT_*                         titles, search keywords, author / partner / copyright / licence / open-source lines.
//   ABOUT_OFFICIAL_THUMBPRINT       the pinned certificate of official builds (package.json sanovids.signers[0]).
//   formatThumbprint(t)             '7489ABFA…' → '7489 ABFA …' (groups of 4).
//   thumbprintLine(t)               'Dấu vân tay chứng chỉ: …'.
//   officialThumbprintLine()        'Bản chính thức — dấu vân tay chứng chỉ: …'.
//   thumbprintRows(sig)             the thumbprint line(s) under the signature row, as { label, value }.
//   versionLine(version, kind, desktop)   'Phiên bản 0.5.0 · Bản cài'.
//   signatureView(sig)              tone, title and detail of the signature row.
//   borrowsAuthorName(signer)       a certificate name that copies the author's (an impostor when not pinned).
// Only `sanovids` is imported from package.json (a named import keeps `build` and the rest out of the bundle).
import { sanovids } from '../../package.json'
import type { AppSignature } from './appSignature'
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
 * by someone else shows both, so the two can be compared.
 */
export function thumbprintRows(sig: AppSignature | null): ThumbprintRow[] {
  const official: ThumbprintRow = { label: OFFICIAL_THUMB_LABEL, value: formatThumbprint(ABOUT_OFFICIAL_THUMBPRINT) }
  if (!sig?.thumbprint) return [official]
  const own: ThumbprintRow = { label: THUMB_LABEL, value: formatThumbprint(sig.thumbprint) }
  return sig.status === 'other-signer' ? [own, official] : [own]
}

/** Kind of build as the About block names it. */
export function buildLabel(kind: UpdateKind, desktop: boolean): string {
  if (kind === 'installer') return 'Bản cài'
  if (kind === 'portable') return 'Bản portable'
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

/** The signature row: null = still checking. */
export function signatureView(sig: AppSignature | null): SignatureView {
  if (!sig) return { tone: 'neutral', title: 'Đang kiểm tra chữ ký số…', detail: '' }
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
        : { tone: 'neutral', title: 'Bản phát triển (chưa ký số)', detail: 'Chạy từ mã nguồn nên không có chữ ký số — bình thường khi phát triển.' }
    default:
      return {
        tone: 'neutral',
        title: 'Chưa kiểm tra được chữ ký số',
        detail: 'Windows không cho đọc chữ ký số lúc này (PowerShell bị chặn hoặc quá lâu). Bản chính thức luôn được ký số bởi Nguyễn Giang Minh (Jame Steven).',
      }
  }
}

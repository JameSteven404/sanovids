// "Cài đặt → Giới thiệu" texts (lib/aboutModel): every signature row, thumbprint formatting, the version line, and the
// author / partner / copyright / pinned-thumbprint constants matching package.json (NFC, Sano Group only as a partner).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json'
import aboutSource from '../aboutModel.ts?raw'
import * as about from '../aboutModel'
import {
  ABOUT_AUTHOR,
  ABOUT_AUTHOR_LINE,
  ABOUT_COPYRIGHT,
  ABOUT_DOWNLOAD_LINE,
  ABOUT_KEYWORDS,
  ABOUT_OFFICIAL_THUMBPRINT,
  ABOUT_OPEN_SOURCE,
  ABOUT_PARTNER_LINE,
  borrowsAuthorName,
  buildLabel,
  formatThumbprint,
  officialThumbprintLine,
  signatureView,
  thumbprintLine,
  thumbprintRows,
  versionLine,
} from '../aboutModel'
import type { AppSignature } from '../appSignature'
import { UPDATE_RELEASES_PAGE_LABEL } from '../updateTypes'

const AUTHOR = 'Nguyễn Giang Minh (Jame Steven)'
const COPYRIGHT_BUILD = '© 2026 Nguyễn Giang Minh (Jame Steven) · Đồng hành: Sano Group'
const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const OTHER = '0123456789ABCDEF0123456789ABCDEF01234567'

describe('constants', () => {
  it('match package.json (author.name, build.copyright, sanovids.signers[0])', () => {
    expect(ABOUT_AUTHOR).toBe(AUTHOR)
    expect(pkg.author.name).toBe(ABOUT_AUTHOR)
    expect(pkg.build.copyright).toBe(COPYRIGHT_BUILD)
    // The About copyright and the build copyright name the same author; the partner line is the build's tail.
    expect(ABOUT_COPYRIGHT.startsWith(`© 2026 ${ABOUT_AUTHOR}.`)).toBe(true)
    expect(pkg.build.copyright.startsWith(`© 2026 ${ABOUT_AUTHOR} · `)).toBe(true)
    expect(pkg.build.copyright.endsWith(ABOUT_PARTNER_LINE)).toBe(true)
    expect(ABOUT_AUTHOR_LINE).toBe(`Tác giả: ${ABOUT_AUTHOR}`)
    expect(ABOUT_PARTNER_LINE).toBe('Đồng hành: Sano Group')
    expect(ABOUT_OFFICIAL_THUMBPRINT).toBe(pkg.sanovids.signers[0])
    expect(ABOUT_OFFICIAL_THUMBPRINT).toBe(PIN)
    expect(ABOUT_DOWNLOAD_LINE).toBe(`Trang tải về chính thức: ${UPDATE_RELEASES_PAGE_LABEL}`)
  })

  it('Sano Group is a partner only, never the author', () => {
    expect(ABOUT_AUTHOR_LINE).not.toMatch(/sano/i)
    expect(ABOUT_COPYRIGHT).not.toMatch(/sano/i)
    expect(ABOUT_PARTNER_LINE.startsWith('Đồng hành:')).toBe(true)
  })

  it('every string is NFC', () => {
    const strings = Object.values(about).filter((v): v is string => typeof v === 'string')
    expect(strings.length).toBeGreaterThan(10)
    for (const s of strings) expect(s).toBe(s.normalize('NFC'))
    for (const sig of SIGS) {
      const v = signatureView(sig)
      expect(v.title).toBe(v.title.normalize('NFC'))
      expect(v.detail).toBe(v.detail.normalize('NFC'))
    }
  })

  it('search keywords name the author, the partner and the signature', () => {
    for (const w of ['tác giả', 'nguyễn giang minh', 'jame steven', 'sano group', 'đồng hành', 'chữ ký số', 'vân tay', 'phiên bản', 'giấy phép']) {
      expect(ABOUT_KEYWORDS).toContain(w)
    }
  })

  it('the open-source note names the same licence files as LICENSE.txt clause 6', () => {
    const license = readFileSync(new URL('../../../LICENSE.txt', import.meta.url), 'utf8')
    const clause = license.split('\n').find((l) => l.startsWith('6. '))
    const files = clause?.match(/[A-Za-z.-]+\.(?:txt|html)/g) ?? []
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const f of files) expect(ABOUT_OPEN_SOURCE, f).toContain(f)
  })

  it('imports only `sanovids` from package.json (never `build` or the whole file)', () => {
    const pkgImports = aboutSource.split('\n').filter((l) => /from\s+'[./]+package\.json'/.test(l))
    expect(pkgImports).toEqual(["import { sanovids } from '../../package.json'"])
  })
})

const SIGS: (AppSignature | null)[] = [
  null,
  { status: 'signed', packaged: true, signer: AUTHOR, thumbprint: PIN },
  { status: 'signed', packaged: true },
  { status: 'other-signer', packaged: true, signer: 'Người lạ', thumbprint: OTHER },
  { status: 'other-signer', packaged: true },
  { status: 'other-signer', packaged: true, signer: AUTHOR, thumbprint: OTHER },
  { status: 'tampered', packaged: true },
  { status: 'unsigned', packaged: true },
  { status: 'unsigned', packaged: false },
  { status: 'unknown', packaged: true },
  { status: 'unknown', packaged: false },
]

describe('signatureView', () => {
  it('null: still checking', () => {
    expect(signatureView(null)).toEqual({ tone: 'neutral', title: 'Đang kiểm tra chữ ký số…', detail: '' })
  })

  it('signed: ok, names the signer (the author when missing)', () => {
    expect(signatureView({ status: 'signed', packaged: true, signer: AUTHOR, thumbprint: PIN })).toEqual({
      tone: 'ok',
      title: 'Đã ký số bởi Nguyễn Giang Minh (Jame Steven) ✓',
      detail: 'Bản gốc — file chương trình và các thư viện DLL chính còn nguyên chữ ký số của tác giả.',
    })
    expect(signatureView({ status: 'signed', packaged: true, signer: 'SanoVids Thử Nghiệm A' }).title).toBe('Đã ký số bởi SanoVids Thử Nghiệm A ✓')
    expect(signatureView({ status: 'signed', packaged: true }).title).toBe(`Đã ký số bởi ${AUTHOR} ✓`)
  })

  it('other-signer: warn, quotes the signer', () => {
    expect(signatureView({ status: 'other-signer', packaged: true, signer: 'Người lạ', thumbprint: OTHER })).toEqual({
      tone: 'warn',
      title: 'Không phải bản gốc',
      detail: 'Bản này được ký bởi “Người lạ”, không phải tác giả Nguyễn Giang Minh (Jame Steven). Hãy tải lại bản chính thức ở trang tải về.',
    })
    expect(signatureView({ status: 'other-signer', packaged: true }).detail).toContain('“người khác”')
  })

  it('other-signer with a certificate carrying the author name: a possible impostor (never "signed by X, not X")', () => {
    const want = {
      tone: 'warn',
      title: 'Không phải bản gốc — có thể là bản giả mạo',
      detail:
        'Bản này được ký bằng một chứng chỉ mang tên “Nguyễn Giang Minh (Jame Steven)” nhưng KHÔNG phải chứng chỉ của tác giả (dấu vân tay khác với bản chính thức bên dưới). Hãy tải lại bản chính thức ở trang tải về và so dấu vân tay trước khi cài.',
    }
    expect(signatureView({ status: 'other-signer', packaged: true, signer: AUTHOR, thumbprint: OTHER })).toEqual(want)
    expect(want.detail).not.toContain('không phải tác giả Nguyễn Giang Minh')
    // NFD, other case, extra spaces, no accents, part of the name: still the impostor text
    for (const signer of [AUTHOR.normalize('NFD'), AUTHOR.toUpperCase(), '  Nguyễn   Giang  Minh  (Jame  Steven) ', 'Nguyen Giang Minh', 'JAME STEVEN', 'Nguyễn Giang Minh Studio']) {
      expect(borrowsAuthorName(signer), signer).toBe(true)
      expect(signatureView({ status: 'other-signer', packaged: true, signer, thumbprint: OTHER }).title, signer).toBe('Không phải bản gốc — có thể là bản giả mạo')
    }
    for (const signer of [undefined, '', 'Người lạ', 'SanoVids Thử Nghiệm A', 'Sano Group', 'Minh Giang']) {
      expect(borrowsAuthorName(signer), String(signer)).toBe(false)
    }
  })

  it('tampered: warn', () => {
    expect(signatureView({ status: 'tampered', packaged: true })).toEqual({
      tone: 'warn',
      title: 'File của SanoVids đã bị thay đổi',
      detail: 'Chữ ký số không còn khớp với nội dung file. Hãy tải lại bản chính thức ở trang tải về rồi cài đè.',
    })
  })

  it('unsigned: warn for a packaged build, neutral when running from the sources', () => {
    expect(signatureView({ status: 'unsigned', packaged: true })).toEqual({
      tone: 'warn',
      title: 'Bản này không có chữ ký số',
      detail: 'Bản cài chính thức luôn được ký số bởi Nguyễn Giang Minh (Jame Steven). Hãy tải bản chính thức ở trang tải về.',
    })
    expect(signatureView({ status: 'unsigned', packaged: false })).toEqual({
      tone: 'neutral',
      title: 'Bản phát triển (chưa ký số)',
      detail: 'Chạy từ mã nguồn nên không có chữ ký số — bình thường khi phát triển.',
    })
  })

  it('unknown: neutral whatever `packaged` says', () => {
    const want = {
      tone: 'neutral',
      title: 'Chưa kiểm tra được chữ ký số',
      detail: 'Windows không cho đọc chữ ký số lúc này (PowerShell bị chặn hoặc quá lâu). Bản chính thức luôn được ký số bởi Nguyễn Giang Minh (Jame Steven).',
    }
    expect(signatureView({ status: 'unknown', packaged: true })).toEqual(want)
    expect(signatureView({ status: 'unknown', packaged: false })).toEqual(want)
  })

  it('every warn names a way out (the download page)', () => {
    for (const sig of SIGS) {
      const v = signatureView(sig)
      if (v.tone === 'warn') expect(v.detail).toContain('trang tải về')
    }
  })
})

describe('thumbprints', () => {
  it('formatThumbprint: groups of 4, upper case, whitespace dropped', () => {
    expect(formatThumbprint(PIN)).toBe('7489 ABFA C1A7 CD23 D5FF B078 5CA7 CAB4 14AE 49ED')
    expect(formatThumbprint(' 7489abfa c1a7cd23d5ffb0785ca7cab414ae49ed ')).toBe('7489 ABFA C1A7 CD23 D5FF B078 5CA7 CAB4 14AE 49ED')
    expect(formatThumbprint('')).toBe('')
  })

  it('thumbprintLine / officialThumbprintLine', () => {
    expect(thumbprintLine(PIN)).toBe('Dấu vân tay chứng chỉ: 7489 ABFA C1A7 CD23 D5FF B078 5CA7 CAB4 14AE 49ED')
    expect(officialThumbprintLine()).toBe('Bản chính thức — dấu vân tay chứng chỉ: 7489 ABFA C1A7 CD23 D5FF B078 5CA7 CAB4 14AE 49ED')
  })

  it('thumbprintRows: the file’s certificate when known (plus the official one for another signer), else the official one', () => {
    const lines = (sig: AppSignature | null) => thumbprintRows(sig).map((r) => `${r.label}: ${r.value}`)
    expect(lines(null)).toEqual([officialThumbprintLine()])
    expect(lines({ status: 'tampered', packaged: true })).toEqual([officialThumbprintLine()])
    expect(lines({ status: 'signed', packaged: true, thumbprint: PIN })).toEqual([thumbprintLine(PIN)])
    expect(lines({ status: 'other-signer', packaged: true, thumbprint: OTHER })).toEqual([thumbprintLine(OTHER), officialThumbprintLine()])
    expect(thumbprintRows(null)).toEqual([{ label: 'Bản chính thức — dấu vân tay chứng chỉ', value: '7489 ABFA C1A7 CD23 D5FF B078 5CA7 CAB4 14AE 49ED' }])
  })
})

describe('versionLine', () => {
  it('names the kind of build', () => {
    expect(versionLine('0.5.80', 'installer', true)).toBe('Phiên bản 0.5.80 · Bản cài')
    expect(versionLine('0.5.0', 'portable', true)).toBe('Phiên bản 0.5.0 · Bản portable')
    expect(versionLine('0.5.0', 'dev', true)).toBe('Phiên bản 0.5.0 · Bản phát triển')
    expect(versionLine('0.5.0', 'dev', false)).toBe('Phiên bản 0.5.0 · Bản web')
    // the development-mode simulation of an installer build in the browser
    expect(buildLabel('installer', false)).toBe('Bản cài')
  })
})

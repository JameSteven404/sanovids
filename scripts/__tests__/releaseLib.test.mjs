// Unit tests of the pure release helpers (scripts/releaseLib.mjs). Fixtures: the real CHANGELOG.md, the latest.yml
// of the published 0.4.2 build, a hand-made asar header and the public signing certificate (build/signing/*.cer).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { load as loadYaml } from 'js-yaml'
import {
  AUTHOR,
  COPYRIGHT_BUILD,
  EXPECTED_FUSE_WIRE,
  FUSE_NAMES,
  NOTES_CAP,
  PRIVATE_REPO,
  PUBLIC_REPO,
  PUBLISHER_NAME_MISSING,
  PUBLISH_ENTRY,
  SIGNER_THUMBPRINT,
  SIGNING_CERT_FILE,
  SIGNING_NOTE,
  asarDataOffset,
  asarDependencyProblems,
  asarEntry,
  asarHas,
  asarHeaderBytes,
  assetsFor,
  boldTitlesToHeadings,
  buildArgsProblem,
  buildReleaseNotes,
  capText,
  certThumbprint,
  checkAppUpdateYml,
  checkAsarIntegrity,
  checkBuildFreshness,
  checkCertFile,
  checkFuseWire,
  checkInstallerIdentity,
  checkLatestYml,
  checkPackagedIdentity,
  checkRotation,
  checkSignatureVerdict,
  checkVersionInfo,
  compareAssets,
  compareVersions,
  extractChangelogSection,
  formatArgv,
  ghCreateDraftArgs,
  ghEditNotesArgs,
  ghListReleasesArgs,
  ghPublishArgs,
  ghUploadArgs,
  newestPublishedVersion,
  offlineEnvSet,
  peeledTagSha,
  planTarget,
  readAsarHeader,
  releaseBody,
  releaseFiles,
  releaseTitle,
  stripLinkRefs,
  updateNotesText,
} from '../releaseLib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHANGELOG = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
/** The public part of the real signing certificate (early signing track; DER, no key). */
const CERT = fs.readFileSync(path.join(root, 'build', 'signing', 'SanoVids-NguyenGiangMinh.cer'))
const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const TEST_PIN = 'A'.repeat(40)

const LATEST_042 = `version: 0.4.2
files:
  - url: SanoVids-Setup-0.4.2.exe
    sha512: Vr+VrT5owRdXC9gcjJ5ifaNm72ps/5WjmYNuVGB79YlFHbhyldx4cAWLyhgjtm+lhHP4yMgR/AfDzYbHB1Yjtw==
    size: 103195548
path: SanoVids-Setup-0.4.2.exe
sha512: Vr+VrT5owRdXC9gcjJ5ifaNm72ps/5WjmYNuVGB79YlFHbhyldx4cAWLyhgjtm+lhHP4yMgR/AfDzYbHB1Yjtw==
releaseDate: '2026-10-02T14:17:54.395Z'
`
const SHA512_042 = 'Vr+VrT5owRdXC9gcjJ5ifaNm72ps/5WjmYNuVGB79YlFHbhyldx4cAWLyhgjtm+lhHP4yMgR/AfDzYbHB1Yjtw=='
const EXPECT_042 = { version: '0.4.2', setupName: 'SanoVids-Setup-0.4.2.exe', sha512: SHA512_042, size: 103195548 }

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

/** A minimal asar: size pickle, header pickle (payload size, JSON length, JSON, padding), then file data. */
function fakeAsar(files, data) {
  const json = Buffer.from(JSON.stringify({ files }), 'utf8')
  const padded = Math.ceil(json.length / 4) * 4
  const headerPickleSize = 8 + padded
  const buf = Buffer.alloc(8 + headerPickleSize + data.length)
  buf.writeUInt32LE(4, 0)
  buf.writeUInt32LE(headerPickleSize, 4)
  buf.writeUInt32LE(4 + padded, 8)
  buf.writeUInt32LE(json.length, 12)
  json.copy(buf, 16)
  data.copy(buf, 8 + headerPickleSize)
  return buf
}

describe('versions', () => {
  it('compares numerically', () => {
    expect(compareVersions('0.5.0', '0.4.2')).toBe(1)
    expect(compareVersions('0.4.10', '0.4.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.4.2', '0.5.0')).toBe(-1)
  })
  it('finds the newest published release, skipping drafts, pre-releases and odd tags', () => {
    expect(
      newestPublishedVersion([
        { tag_name: 'v0.5.0', draft: false, prerelease: false },
        { tag_name: 'v0.6.0', draft: true, prerelease: false },
        { tag_name: 'v0.5.5', draft: false, prerelease: true },
        { tag_name: 'v0.5.1', draft: false, prerelease: false },
        { tag_name: 'docs', draft: false, prerelease: false },
      ]),
    ).toBe('0.5.1')
    expect(newestPublishedVersion([])).toBeNull()
    expect(newestPublishedVersion(null)).toBeNull()
  })
  it('with `below`, only versions strictly older count (the release users run before this one)', () => {
    const list = [
      { tag_name: 'v0.5.0', draft: false, prerelease: false },
      { tag_name: 'v0.5.1', draft: false, prerelease: false },
      { tag_name: 'v0.5.2', draft: true, prerelease: false },
    ]
    expect(newestPublishedVersion(list, '0.5.1')).toBe('0.5.0')
    expect(newestPublishedVersion(list, '0.5.2')).toBe('0.5.1')
    expect(newestPublishedVersion(list, '0.5.0')).toBeNull()
    expect(newestPublishedVersion(list, null)).toBe('0.5.1')
  })
})

describe('extractChangelogSection (real CHANGELOG.md)', () => {
  it('reads a section with a subtitle', () => {
    const s = extractChangelogSection(CHANGELOG, '0.4.2')
    expect(s).toMatchObject({ version: '0.4.2', date: '2026-10-02', subtitle: 'Dây nối chạm đúng tâm chấm tròn' })
    expect(s.body.startsWith('🐞 **Dây nối không còn toả rộng cạnh chấm**')).toBe(true)
    expect(s.body).not.toContain('## [0.4.1]')
  })
  it('reads a section without a subtitle and stops at the next header', () => {
    const s = extractChangelogSection(CHANGELOG, '0.4.1')
    expect(s.subtitle).toBeNull()
    expect(s.body).toContain('Node Thư mục gọn gàng hơn')
    expect(s.body).not.toContain('0.4.0')
  })
  it('stops the last section at the link-reference block', () => {
    const s = extractChangelogSection(CHANGELOG, '0.1.0')
    expect(s.body).toContain('Giao diện kiểu Apple')
    expect(s.body).not.toMatch(/^\[0\.\d\.\d\]:/m)
  })
  it('handles CRLF and missing versions', () => {
    const crlf = '# x\r\n\r\n## [1.2.3] — 2026-01-02 — Tên\r\n\r\n- a\r\n- b\r\n\r\n[1.2.3]: https://x\r\n'
    expect(extractChangelogSection(crlf, '1.2.3')).toEqual({ version: '1.2.3', date: '2026-01-02', subtitle: 'Tên', body: '- a\n- b' })
    expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeNull()
    expect(extractChangelogSection(null, '0.4.2')).toBeNull()
    expect(extractChangelogSection(CHANGELOG, 'nope')).toBeNull()
  })
})

describe('notes text', () => {
  it('strips link refs', () => {
    expect(stripLinkRefs('a\n[0.4.2]: https://x\nb')).toBe('a\nb')
  })
  it('caps at a line break and ends with an ellipsis line', () => {
    const text = Array.from({ length: 50 }, (_, i) => `dòng ${i} ${'x'.repeat(30)}`).join('\n')
    const out = capText(text, 200)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith('\n…')).toBe(true)
    expect(out.split('\n').slice(0, -1).every((l) => l.startsWith('dòng '))).toBe(true)
    expect(capText('short', 200)).toBe('short')
  })
  it('builds build/release-notes.md from the section (LF, one trailing newline)', () => {
    const { found, text } = updateNotesText(CHANGELOG, '0.4.2')
    expect(found).toBe(true)
    expect(text.startsWith('### 🐞 Dây nối không còn toả rộng cạnh chấm\n- ')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
    expect(text).not.toContain('\r')
    expect(text.length).toBeLessThanOrEqual(NOTES_CAP + 1)
  })
  it('section titles become headings (the in-app notes show "### …" as headings)', () => {
    const { found, text } = updateNotesText(CHANGELOG, '0.5.0')
    expect(found).toBe(true)
    // the 0.5.0 section fits the app's notes without being cut
    expect(text.endsWith('…\n')).toBe(false)
    const headings = text.split('\n').filter((l) => l.startsWith('### '))
    expect(headings).toEqual(
      expect.arrayContaining([
        '### ✨ SanoVids tự cập nhật (bản cài Setup)',
        '### ⚠️ Lần này phải cài tay 0.5.0 một lần',
        '### 🛠️ Trang tải về chuyển sang',
      ]),
    )
    // only the CHANGELOG symbols, and no "emoji **Title**" line left unconverted
    for (const h of headings) expect(h).toMatch(/^### (✨|🛠️|🐞|⚠️) \S/u)
    expect(text).not.toMatch(/^(✨|🛠️|🐞|⚠️)\s+\*\*/mu)
    // a longer text after the bold part becomes the paragraph under the heading
    const after = text.split('\n')[text.split('\n').indexOf('### 🛠️ Trang tải về chuyển sang') + 1]
    expect(after.startsWith('[github.com/JameSteven404/sanovids-releases](')).toBe(true)
    // list items keep their bold phrases
    expect(text).toContain('- Bản 0.4.2 trở về trước chưa biết tự cập nhật')
    expect(boldTitlesToHeadings('- ✨ **không** phải tiêu đề\n**Không emoji**\nGiữa dòng ✨ **x**')).toBe('- ✨ **không** phải tiêu đề\n**Không emoji**\nGiữa dòng ✨ **x**')
    expect(boldTitlesToHeadings('🐞 **Sửa lỗi**: chi tiết ở đây')).toBe('### 🐞 Sửa lỗi\nchi tiết ở đây')
  })
  it('falls back to "SanoVids <v>" when the section is missing', () => {
    expect(updateNotesText(CHANGELOG, '9.9.9')).toEqual({ found: false, text: 'SanoVids 9.9.9\n' })
    expect(updateNotesText('', '1.0.0')).toEqual({ found: false, text: 'SanoVids 1.0.0\n' })
  })
  it('caps a huge section', () => {
    const big = `## [1.0.0] — 2026-01-01\n\n${Array.from({ length: 2000 }, (_, i) => `- mục ${i}`).join('\n')}\n`
    const { text } = updateNotesText(big, '1.0.0')
    expect(text.length).toBeLessThanOrEqual(NOTES_CAP + 1)
    expect(text.endsWith('…\n')).toBe(true)
  })
})

describe('release names and notes', () => {
  it('titles', () => {
    expect(releaseTitle('0.5.0', 'Tự động cập nhật')).toBe('SanoVids 0.5.0 — Tự động cập nhật')
    expect(releaseTitle('0.4.1', null)).toBe('SanoVids 0.4.1')
    expect(releaseTitle('0.4.1', '  ')).toBe('SanoVids 0.4.1')
  })
  it('file names and assets per audience', () => {
    expect(releaseFiles('0.5.0')).toEqual({
      setup: 'SanoVids-Setup-0.5.0.exe',
      portable: 'SanoVids-Portable-0.5.0.exe',
      blockmap: 'SanoVids-Setup-0.5.0.exe.blockmap',
      latestYml: 'latest.yml',
    })
    // the public certificate (no key) goes with every release, in both repos
    expect(SIGNING_CERT_FILE).toBe('SanoVids-NguyenGiangMinh.cer')
    expect(assetsFor('private', '0.5.0')).toEqual(['SanoVids-Setup-0.5.0.exe', 'SanoVids-Portable-0.5.0.exe', 'SanoVids-NguyenGiangMinh.cer'])
    expect(assetsFor('public', '0.5.0')).toEqual([
      'SanoVids-Setup-0.5.0.exe',
      'SanoVids-Setup-0.5.0.exe.blockmap',
      'latest.yml',
      'SanoVids-Portable-0.5.0.exe',
      'SanoVids-NguyenGiangMinh.cer',
    ])
    expect(() => assetsFor('other', '0.5.0')).toThrow()
  })
  it('rewrites links per audience', () => {
    const body = 'Xem [docs/TEST.md](docs/TEST.md), [trang](https://example.com), [repo](https://github.com/JameSteven404/sanovids/blob/main/x), [feed](https://github.com/JameSteven404/sanovids-releases/releases)\n[0.5.0]: https://x'
    const priv = releaseBody(body, 'private')
    expect(priv).toContain('[docs/TEST.md](https://github.com/JameSteven404/sanovids/blob/main/docs/TEST.md)')
    expect(priv).toContain('[trang](https://example.com)')
    expect(priv).not.toContain('[0.5.0]:')
    const pub = releaseBody(body, 'public')
    expect(pub).toContain('Xem docs/TEST.md, [trang](https://example.com), repo, [feed](https://github.com/JameSteven404/sanovids-releases/releases)')
    expect(pub).not.toMatch(/github\.com\/JameSteven404\/sanovids\//)
  })
  it('builds the v0.4.2-style notes with a download table', () => {
    const sha256 = { 'SanoVids-Setup-0.5.0.exe': SHA_A, 'SanoVids-Portable-0.5.0.exe': SHA_B.toUpperCase() }
    const priv = buildReleaseNotes({ version: '0.5.0', body: '✨ **Mới**\n- a', sha256, audience: 'private' })
    expect(priv).toBe(
      '\n✨ **Mới**\n- a\n\n---\n\n### ⬇️ Tải về\n\n| File | Dùng khi | SHA-256 |\n|---|---|---|\n' +
        `| **SanoVids-Setup-0.5.0.exe** | **Khuyên dùng.** Cài vào máy, có icon Desktop/Start Menu, tự cập nhật các bản sau. | \`${SHA_A}\` |\n` +
        `| **SanoVids-Portable-0.5.0.exe** | Chạy không cần cài (hợp chép USB). Không tự cập nhật — app chỉ báo có bản mới. | \`${SHA_B}\` |\n\n` +
        'Cài đè lên bản cũ được, dự án và cài đặt giữ nguyên. Lịch sử đầy đủ: [CHANGELOG.md](https://github.com/JameSteven404/sanovids/blob/main/CHANGELOG.md).\n\n' +
        'Bản cài được ký số bởi **Nguyễn Giang Minh (Jame Steven)** — dấu vân tay chứng chỉ `7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`. ' +
        'Kiểm tra: chuột phải file → Properties → Digital Signatures. File `SanoVids-NguyenGiangMinh.cer` là chứng chỉ công khai (không chứa khoá).\n',
    )
    const pub = buildReleaseNotes({ version: '0.5.0', body: '✨ a', sha256, audience: 'public' })
    expect(pub).toContain('`latest.yml` và `.blockmap` là file dùng cho việc tự cập nhật — không cần tải.')
    expect(pub).not.toContain('github.com/JameSteven404/sanovids/')
    expect(pub.endsWith(`\n\n${SIGNING_NOTE}\n`)).toBe(true)
  })
  it('the signing footer names the author and the pinned thumbprint (NFC, = the public certificate)', () => {
    expect(SIGNING_NOTE).toBe(
      'Bản cài được ký số bởi **Nguyễn Giang Minh (Jame Steven)** — dấu vân tay chứng chỉ `7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`. ' +
        'Kiểm tra: chuột phải file → Properties → Digital Signatures. File `SanoVids-NguyenGiangMinh.cer` là chứng chỉ công khai (không chứa khoá).',
    )
    expect(SIGNING_NOTE).toBe(SIGNING_NOTE.normalize('NFC'))
    expect(AUTHOR).toBe('Nguyễn Giang Minh (Jame Steven)')
    expect(AUTHOR).toBe(AUTHOR.normalize('NFC'))
    expect(COPYRIGHT_BUILD).toBe('© 2026 Nguyễn Giang Minh (Jame Steven) · Đồng hành: Sano Group')
    expect(COPYRIGHT_BUILD).toBe(COPYRIGHT_BUILD.normalize('NFC'))
    expect(certThumbprint(CERT)).toBe(SIGNER_THUMBPRINT)
  })
  it('refuses notes without checksums or with an unknown audience', () => {
    expect(() => buildReleaseNotes({ version: '0.5.0', body: 'x', sha256: {}, audience: 'public' })).toThrow(/SHA-256/)
    expect(() =>
      buildReleaseNotes({ version: '0.5.0', body: 'x', sha256: { 'SanoVids-Setup-0.5.0.exe': SHA_A, 'SanoVids-Portable-0.5.0.exe': 'nope' }, audience: 'public' }),
    ).toThrow()
    expect(() => buildReleaseNotes({ version: '0.5.0', body: 'x', sha256: {}, audience: 'x' })).toThrow()
  })
})

describe('checkLatestYml (0.4.2 latest.yml)', () => {
  const obj = loadYaml(LATEST_042)
  it('accepts the real file', () => {
    expect(checkLatestYml(obj, EXPECT_042)).toEqual([])
  })
  it('flags a build older than the release commit', () => {
    const p = checkLatestYml(obj, { ...EXPECT_042, notBefore: '2026-10-02T21:18:31+07:00' })
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/chạy lại npm run dist:win/)
    expect(checkLatestYml(obj, { ...EXPECT_042, notBefore: '2026-10-02T21:00:00+07:00' })).toEqual([])
  })
  it('flags every mismatch', () => {
    const p = checkLatestYml(obj, { version: '0.5.0', setupName: 'SanoVids-Setup-0.5.0.exe', sha512: 'x', size: 1 })
    expect(p.length).toBeGreaterThanOrEqual(6)
    expect(checkLatestYml({ ...obj, files: [] }, EXPECT_042).join(' ')).toMatch(/files/)
    expect(checkLatestYml({ ...obj, releaseDate: 'soon' }, EXPECT_042).join(' ')).toMatch(/releaseDate/)
  })
  it('accepts an unquoted (Date) releaseDate', () => {
    const unquoted = loadYaml(LATEST_042.replace("'2026-10-02T14:17:54.395Z'", '2026-10-02T14:17:54.395Z'))
    expect(unquoted.releaseDate).toBeInstanceOf(Date)
    expect(checkLatestYml(unquoted, EXPECT_042)).toEqual([])
  })
  it('rejects garbage', () => {
    expect(checkLatestYml(null, EXPECT_042)).toHaveLength(1)
    expect(checkLatestYml('text', EXPECT_042)).toHaveLength(1)
    expect(checkLatestYml([], EXPECT_042)).toHaveLength(1)
  })
})

describe('checkAppUpdateYml', () => {
  const want = { publisherName: AUTHOR }
  const good = {
    owner: 'JameSteven404',
    repo: 'sanovids-releases',
    provider: 'github',
    releaseType: 'release',
    publisherName: [AUTHOR],
    updaterCacheDirName: 'sanovids-updater',
  }
  // what electron-builder writes (js-yaml dump of the publish config + publisherName from signtoolOptions)
  const SIGNED_YML = `owner: JameSteven404\nrepo: sanovids-releases\nprovider: github\nreleaseType: release\npublisherName:\n  - ${AUTHOR}\nupdaterCacheDirName: sanovids-updater\n`
  it('accepts the signed public feed (array or string publisherName)', () => {
    expect(checkAppUpdateYml(good, want)).toEqual([])
    expect(checkAppUpdateYml(loadYaml(SIGNED_YML), want)).toEqual([])
    expect(checkAppUpdateYml({ ...good, publisherName: AUTHOR }, want)).toEqual([])
    // compared after NFC: a decomposed "ễ" in the file is the same name
    expect(checkAppUpdateYml({ ...good, publisherName: [AUTHOR.normalize('NFD')] }, want)).toEqual([])
  })
  it('publisherName is REQUIRED (release configuration; the pinned verifier runs either way)', () => {
    const missing = checkAppUpdateYml(loadYaml(SIGNED_YML.replace(`publisherName:\n  - ${AUTHOR}\n`, '')), want)
    expect(missing).toEqual([PUBLISHER_NAME_MISSING])
    expect(PUBLISHER_NAME_MISSING).toBe(
      'app-update.yml thiếu publisherName — lớp kiểm tra thứ hai của electron-updater bị mất: bản build không đúng cấu hình phát hành (build.win.signtoolOptions.publisherName).',
    )
    // never claim the app stops checking update signatures without it: electron/updater.cjs overrides verifySignature
    expect(PUBLISHER_NAME_MISSING).not.toMatch(/không kiểm tra chữ ký/)
    expect(checkAppUpdateYml({ ...good, publisherName: [] }, want)).toEqual(missing)
    expect(checkAppUpdateYml({ ...good, publisherName: null }, want)).toEqual(missing)
  })
  it('a wrong publisherName fails', () => {
    for (const bad of [['Nguyễn Giang Minh'], ['Nguy?n Giang Minh (Jame Steven)'], 'SanoVids', [AUTHOR, 'SanoVids Thử Nghiệm A'], [42], { name: AUTHOR }]) {
      const p = checkAppUpdateYml({ ...good, publisherName: bad }, want)
      expect(p).toHaveLength(1)
      expect(p[0]).toMatch(/^publisherName trong app-update.yml là .*, cần \["Nguyễn Giang Minh \(Jame Steven\)"\]\.$/)
    }
  })
  it('without an expected publisherName nothing passes (fail closed)', () => {
    expect(checkAppUpdateYml(good)).toHaveLength(1)
    expect(checkAppUpdateYml(good, { publisherName: '' })).toHaveLength(1)
  })
  it('refuses the 0.4.2 feed (private source repo, unsigned)', () => {
    const p = checkAppUpdateYml(loadYaml('owner: JameSteven404\nrepo: sanovids\nprovider: github\nupdaterCacheDirName: sanovids-updater\n'), want)
    expect(p).toHaveLength(2)
    expect(p[0]).toMatch(/sanovids-releases/)
    expect(p[1]).toMatch(/thiếu publisherName/)
  })
  it('refuses tokens, private, channel and other providers', () => {
    expect(checkAppUpdateYml({ ...good, token: 'x' }, want)).toHaveLength(1)
    expect(checkAppUpdateYml({ ...good, private: true }, want)).toHaveLength(1)
    expect(checkAppUpdateYml({ ...good, channel: 'beta' }, want)).toHaveLength(1)
    expect(checkAppUpdateYml({ ...good, provider: 'generic', owner: 'x' }, want)).toHaveLength(2)
    expect(checkAppUpdateYml(null, want)).toHaveLength(1)
  })
  it('PUBLISH_ENTRY is the anonymous public feed', () => {
    expect(PUBLISH_ENTRY).toEqual({ provider: 'github', owner: 'JameSteven404', repo: 'sanovids-releases', releaseType: 'release' })
    expect(checkAppUpdateYml({ ...PUBLISH_ENTRY, publisherName: [AUTHOR] }, want)).toEqual([])
    expect(PUBLIC_REPO).toBe('JameSteven404/sanovids-releases')
    expect(PRIVATE_REPO).toBe('JameSteven404/sanovids')
  })
})

describe('signed build checks', () => {
  const genuine = { ok: true, status: 'signed', reason: 'ok', thumbprint: PIN, signer: AUTHOR, timestamped: true }
  it('checkSignatureVerdict: signed AND timestamped, nothing else', () => {
    expect(checkSignatureVerdict('Setup', genuine)).toEqual([])
    const noTs = checkSignatureVerdict('Setup', { ...genuine, timestamped: false })
    expect(noTs).toHaveLength(1)
    expect(noTs[0]).toMatch(/thiếu dấu thời gian/)
    expect(checkSignatureVerdict('Setup', { ...genuine, ok: false })).toHaveLength(1)
    expect(checkSignatureVerdict('Setup', { ok: false, status: 'unsigned', reason: 'not-signed', timestamped: false })[0]).toBe('Setup chưa được ký số.')
    const other = checkSignatureVerdict('Setup', { ok: false, status: 'other-signer', reason: 'other-signer', thumbprint: '5B768D22' + '0'.repeat(32), signer: AUTHOR, timestamped: true })
    expect(other[0]).toMatch(/không phải chứng chỉ của tác giả/)
    expect(other[0]).toContain('5B768D22')
    expect(checkSignatureVerdict('Setup', { ok: false, status: 'tampered', reason: 'hash-mismatch', thumbprint: PIN, timestamped: true })[0]).toMatch(/bị sửa/)
    expect(checkSignatureVerdict('Setup', { ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false })[0]).toMatch(/không đọc được/)
    expect(checkSignatureVerdict('Setup', { ok: false, status: 'unknown', reason: 'bad-chain', timestamped: false })[0]).toMatch(/chuỗi chứng chỉ/)
    expect(checkSignatureVerdict('Setup', { ok: false, status: 'unknown', reason: 'no-pins', timestamped: false })[0]).toMatch(/sanovids\.signers/)
    expect(checkSignatureVerdict('Setup', null)).toHaveLength(1)
  })

  it('checkSignatureVerdict with signer: signed by THE release certificate, not just any pin (rotation)', () => {
    expect(checkSignatureVerdict('Setup', genuine, { signer: SIGNER_THUMBPRINT })).toEqual([])
    expect(checkSignatureVerdict('Setup', genuine, { signer: SIGNER_THUMBPRINT.toLowerCase() })).toEqual([])
    // pins = [OLD, NEW]: a file signed by the other pinned certificate is still the wrong one for this release
    const otherPin = { ...genuine, thumbprint: TEST_PIN }
    const p = checkSignatureVerdict('SanoVids.exe', otherPin, { signer: SIGNER_THUMBPRINT })
    expect(p).toHaveLength(1)
    expect(p[0]).toContain(TEST_PIN)
    expect(p[0]).toContain('SIGNER_THUMBPRINT')
    // both problems at once
    expect(checkSignatureVerdict('SanoVids.exe', { ...otherPin, timestamped: false }, { signer: SIGNER_THUMBPRINT })).toHaveLength(2)
    // timestamp: false leaves the timestamp to the caller (DLLs only warn)
    expect(checkSignatureVerdict('ffmpeg.dll', { ...genuine, timestamped: false }, { timestamp: false })).toEqual([])
  })

  it('checkRotation: "ghim trước, ký sau" against the newest public release', () => {
    const pkgWith = (signers) => ({ name: 'sanovids', version: '0.5.0', sanovids: { signers } })
    expect(checkRotation({ prevVersion: null, prevPkg: null, signer: PIN }).level).toBe('ok')
    expect(checkRotation({ prevVersion: '0.5.0', prevPkg: pkgWith([PIN]), signer: PIN })).toMatchObject({ level: 'ok' })
    expect(checkRotation({ prevVersion: '0.5.0', prevPkg: pkgWith([PIN.toLowerCase()]), signer: PIN }).level).toBe('ok')
    // step 2 of the rotation shipped: [OLD, NEW] is pinned, the new certificate may sign
    expect(checkRotation({ prevVersion: '0.6.0', prevPkg: pkgWith([PIN, TEST_PIN]), signer: TEST_PIN }).level).toBe('ok')
    // steps 2 and 3 merged: users on 0.5.0 pin only OLD and would refuse the update
    const merged = checkRotation({ prevVersion: '0.5.0', prevPkg: pkgWith([PIN]), signer: TEST_PIN })
    expect(merged.level).toBe('fail')
    expect(merged.text).toContain('ghim trước, ký sau')
    expect(merged.text).toContain(TEST_PIN)
    expect(merged.text).toContain('v0.5.0')
    // the previous package.json could not be read (tag not fetched): fail closed
    expect(checkRotation({ prevVersion: '0.5.0', prevPkg: null, signer: PIN })).toMatchObject({ level: 'fail' })
    expect(checkRotation({ prevVersion: '0.5.0', prevPkg: [], signer: PIN }).level).toBe('fail')
    // a 0.5.x+ package.json without pins is wrong; before 0.5.0 there was no updater to refuse anything
    expect(checkRotation({ prevVersion: '0.5.0', prevPkg: { version: '0.5.0' }, signer: PIN }).level).toBe('fail')
    expect(checkRotation({ prevVersion: '0.4.2', prevPkg: { version: '0.4.2' }, signer: PIN }).level).toBe('ok')
    expect(checkRotation({ prevVersion: '0.5.0', prevPkg: pkgWith([PIN]), signer: 'nope' }).level).toBe('fail')
  })

  it('checkAsarIntegrity: exactly resources\\app.asar, SHA256, the header hash', () => {
    const sha = 'cc718bbe00d3d903d3a843dc7bf1eb0bd231caa28347fd0ffcf880af7aefdaa3'
    const res = (items) => JSON.stringify(items)
    const good = res([{ file: 'resources\\app.asar', alg: 'SHA256', value: sha }])
    expect(checkAsarIntegrity([good], sha)).toEqual([])
    expect(checkAsarIntegrity([good], sha.toUpperCase())).toEqual([])
    expect(checkAsarIntegrity([], sha)[0]).toMatch(/không mở trên mọi máy/)
    expect(checkAsarIntegrity([good, good], sha)).toHaveLength(1)
    expect(checkAsarIntegrity(['not json'], sha)).toHaveLength(1)
    expect(checkAsarIntegrity([res([])], sha)).toHaveLength(1)
    expect(checkAsarIntegrity([res([{ file: 'resources\\app.asar', alg: 'SHA256', value: sha }, { file: 'resources\\x.asar', alg: 'SHA256', value: sha }])], sha)).toHaveLength(1)
    const stale = checkAsarIntegrity([good], 'a'.repeat(64))
    expect(stale).toHaveLength(1)
    expect(stale[0]).toMatch(/khác header app\.asar/)
    expect(checkAsarIntegrity([res([{ file: 'resources\\other.asar', alg: 'SHA512', value: sha }])], sha)).toHaveLength(2)
    expect(checkAsarIntegrity([good], 'xyz')[0]).toMatch(/Không tính được/)
  })

  it('checkBuildFreshness: win-unpacked must not be newer than the installers', () => {
    const installers = [
      { label: 'Setup', mtimeMs: 2000 },
      { label: 'Portable', mtimeMs: 2100 },
    ]
    expect(checkBuildFreshness({ unpacked: [{ label: 'SanoVids.exe', mtimeMs: 1000 }, { label: 'app.asar', mtimeMs: 900 }], installers })).toEqual([])
    expect(checkBuildFreshness({ unpacked: [{ label: 'SanoVids.exe', mtimeMs: 2000 }], installers })).toEqual([])
    const late = checkBuildFreshness({ unpacked: [{ label: 'SanoVids.exe', mtimeMs: 2050 }], installers })
    expect(late).toHaveLength(1)
    expect(late[0]).toMatch(/^SanoVids\.exe trong win-unpacked mới hơn Setup/)
    expect(checkBuildFreshness({ unpacked: [{ label: 'app.asar', mtimeMs: 9999 }], installers })).toHaveLength(2)
    expect(checkBuildFreshness({ unpacked: [{ label: 'x', mtimeMs: NaN }], installers })).toEqual([])
    expect(checkBuildFreshness({})).toEqual([])
  })

  it('checkFuseWire: the exact wire on 0–7, index 8+ ignored', () => {
    const wire = { version: '1', ...EXPECTED_FUSE_WIRE, 8: 49 }
    expect(EXPECTED_FUSE_WIRE).toEqual({ 0: 48, 1: 48, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 48 })
    expect(FUSE_NAMES).toHaveLength(8)
    expect(checkFuseWire(wire)).toEqual([])
    expect(checkFuseWire({ ...wire, 8: 48 })).toEqual([])
    // stock electron.exe: RunAsNode on, cookie encryption off, NodeOptions on, inspect on, no asar integrity…
    const stock = { 0: 49, 1: 48, 2: 49, 3: 49, 4: 48, 5: 48, 6: 48, 7: 49, 8: 49, version: '1' }
    const p = checkFuseWire(stock)
    expect(p).toHaveLength(6)
    expect(p[0]).toBe('Fuse RunAsNode đang bật, cần tắt.')
    // cookie encryption must stay OFF
    expect(checkFuseWire({ ...wire, 1: 49 })).toEqual(['Fuse EnableCookieEncryption đang bật, cần tắt.'])
    expect(checkFuseWire({ ...wire, 6: 114 })).toEqual(['Fuse LoadBrowserProcessSpecificV8Snapshot đang đã bị bỏ, cần tắt.'])
    expect(checkFuseWire({ ...wire, version: '2' })).toHaveLength(1)
    const short = { version: '1', 0: 48, 1: 48, 2: 48 }
    expect(checkFuseWire(short)).toHaveLength(5)
    expect(checkFuseWire(null)).toHaveLength(1)
  })

  it('checkPackagedIdentity: release name / version / author / exact pins, no test profile', () => {
    const repo = { name: 'sanovids', productName: 'SanoVids', version: '0.5.0', author: { name: AUTHOR }, sanovids: { signers: [PIN] } }
    const inner = { name: 'sanovids', productName: 'SanoVids', version: '0.5.0', author: { name: AUTHOR }, sanovids: { signers: [PIN] } }
    expect(checkPackagedIdentity(inner, repo)).toEqual([])
    // electron-builder may keep normalizePackageData's url next to the restored name
    expect(checkPackagedIdentity({ ...inner, author: { name: AUTHOR, url: 'Jame Steven' } }, repo)).toEqual([])
    // a test build: extraMetadata pins are unioned with the real one → [PIN, TEST]
    const unioned = checkPackagedIdentity({ ...inner, sanovids: { signers: [PIN, TEST_PIN] } }, repo)
    expect(unioned).toHaveLength(1)
    expect(unioned[0]).toMatch(/sanovids\.signers/)
    expect(checkPackagedIdentity({ ...inner, sanovids: { signers: [TEST_PIN] } }, repo)).toHaveLength(1)
    expect(checkPackagedIdentity({ ...inner, sanovids: undefined }, repo)[0]).toMatch(/không có sanovids\.signers/)
    expect(checkPackagedIdentity({ ...inner, author: { name: 'Nguyễn Giang Minh' } }, repo)[0]).toMatch(/tác giả/)
    expect(checkPackagedIdentity({ ...inner, author: 'SanoVids' }, repo)).toHaveLength(1)
    expect(checkPackagedIdentity({ ...inner, sanovidsTestProfileDir: 'C:\\x' }, repo)[0]).toMatch(/thử nghiệm/)
    expect(checkPackagedIdentity({ ...inner, name: 'sanovids-sigt1', productName: 'SanoVidsSigT1', version: '0.5.80' }, repo)).toHaveLength(3)
    expect(checkPackagedIdentity(inner, { ...repo, sanovids: {} })[0]).toMatch(/không có sanovids\.signers/)
    expect(checkPackagedIdentity(null, repo)).toHaveLength(1)
  })

  it('checkVersionInfo: CompanyName = author (with "(Jame Steven)"), LegalCopyright = build.copyright', () => {
    const expected = { company: AUTHOR, copyright: COPYRIGHT_BUILD }
    expect(checkVersionInfo('SanoVids.exe', { companyName: AUTHOR, legalCopyright: COPYRIGHT_BUILD, productName: 'SanoVids' }, expected)).toEqual([])
    const truncated = checkVersionInfo('SanoVids.exe', { companyName: 'Nguyễn Giang Minh', legalCopyright: COPYRIGHT_BUILD }, expected)
    expect(truncated).toEqual(['SanoVids.exe: CompanyName là "Nguyễn Giang Minh", cần "Nguyễn Giang Minh (Jame Steven)".'])
    expect(checkVersionInfo('Setup', { companyName: 'SanoVids', legalCopyright: '© 2026 SanoVids' }, expected)).toHaveLength(2)
    expect(checkVersionInfo('Setup', { companyName: null, legalCopyright: null }, expected)).toHaveLength(2)
    expect(checkVersionInfo('Setup', null, expected)).toHaveLength(1)
  })

  it('checkInstallerIdentity: the Setup is what installed apps accept as the update (updater-rules installerIdentityProblem)', () => {
    const rules = require('../../electron/updater-rules.cjs')
    const want = { productName: 'SanoVids', version: '0.5.0', size: rules.INSTALLER_MIN_BYTES, minBytes: rules.INSTALLER_MIN_BYTES }
    const info = { productName: 'SanoVids', productVersion: '0.5.0' }
    expect(checkInstallerIdentity('Setup', info, want)).toEqual([])
    // the same decision the app makes on the downloaded file
    expect(rules.installerIdentityProblem({ productName: 'SanoVids', productVersion: '0.5.0' }, { version: '0.5.0', current: '0.4.2', appName: 'SanoVids', size: want.size })).toBe('')
    expect(checkInstallerIdentity('Setup', { ...info, productVersion: '0.5.0.0' }, want)).toEqual([
      'Setup: ProductVersion là "0.5.0.0", cần "0.5.0" (mọi app đã cài sẽ từ chối bản cập nhật này).',
    ])
    expect(checkInstallerIdentity('Setup', { ...info, productName: 'SanoVidsSigT1' }, want)[0]).toMatch(/^Setup: ProductName là "SanoVidsSigT1", cần "SanoVids"/)
    expect(checkInstallerIdentity('Setup', info, { ...want, size: want.minBytes - 1 })[0]).toMatch(/^Setup: chỉ \d+ byte, nhỏ hơn/)
    expect(checkInstallerIdentity('Setup', info, { ...want, size: undefined })).toHaveLength(1)
    expect(checkInstallerIdentity('Setup', { productName: null, productVersion: null }, want)).toHaveLength(2)
    expect(checkInstallerIdentity('Setup', null, want)).toEqual(['Setup: không đọc được thông tin file (VersionInfo).'])
  })

  it('checkCertFile: the public certificate is pinned and holds no key', () => {
    expect(certThumbprint(CERT)).toBe(PIN)
    expect(checkCertFile(CERT, [PIN])).toEqual([])
    expect(checkCertFile(CERT, [PIN.toLowerCase()])).toEqual([])
    expect(checkCertFile(CERT, [TEST_PIN, PIN])).toEqual([])
    expect(checkCertFile(CERT, [TEST_PIN])[0]).toMatch(/không nằm trong package\.json sanovids\.signers/)
    expect(checkCertFile(CERT, [])).toHaveLength(1)
    // PEM form of the same certificate is fine too
    const pem = `-----BEGIN CERTIFICATE-----\n${CERT.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`
    expect(checkCertFile(Buffer.from(pem), [PIN])).toEqual([])
    // anything carrying a private key is refused outright
    expect(checkCertFile(Buffer.from(`${pem}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`), [PIN])[0]).toMatch(/khoá riêng/)
    expect(checkCertFile(Buffer.from('not a certificate'), [PIN])[0]).toMatch(/không phải chứng chỉ/)
    expect(checkCertFile(Buffer.alloc(0), [PIN])).toHaveLength(1)
    expect(certThumbprint(Buffer.from('x'))).toBeNull()
  })
})

describe('release scripts (source guarantees)', () => {
  const read = (f) => fs.readFileSync(path.join(root, 'scripts', f), 'utf8')
  it('tidy-release requires publisherName in the packaged feed and names the signer in DOC-TOI.txt', () => {
    const src = read('tidy-release.mjs')
    expect(src).toContain('/^publisherName:/m.test(feedText)')
    expect(src).toContain('!/^(token|private|channel):/m.test(feedText)')
    expect(src).not.toMatch(/token\|private\|publisherName/)
    // publisherName is the second lock, not the thing that turns update signature checks on
    expect(src).not.toMatch(/signed-update lock/)
    expect(src).toContain('`Bộ cài được ký số bởi ${AUTHOR} — vân tay chứng chỉ ${SIGNER_THUMBPRINT}.`')
    expect(`Bộ cài được ký số bởi ${AUTHOR} — vân tay chứng chỉ ${SIGNER_THUMBPRINT}.`).toBe(
      'Bộ cài được ký số bởi Nguyễn Giang Minh (Jame Steven) — vân tay chứng chỉ 7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED.',
    )
  })
  it('publish-release checks the signed build before anything is published', () => {
    const src = read('publish-release.mjs')
    for (const f of ['electron/main.cjs', 'electron/preload.cjs', 'electron/updater.cjs', 'electron/updater-rules.cjs', 'electron/signature.cjs', 'electron/hardening-rules.cjs']) {
      expect(src).toContain(`'${f}'`)
    }
    expect(src).toContain('checkPackagedIdentity(inner, pkg)')
    expect(src).toContain("inspectAppUpdateYml(path.join(resourcesDir, 'app-update.yml'), EXPECT.publisherName)")
    expect(src).toContain('await inspectWindowsBuild(')
    expect(src).toContain('offlineEnvSet(process.env)')
    expect(src).toContain("path.join(root, 'build', 'signing', SIGNING_CERT_FILE)")
    // (j) is a hard gate: it runs before the `if (failures) … exit(1)` that guards every gh write
    expect(src.indexOf('await inspectWindowsBuild(')).toBeLessThan(src.indexOf("console.log('\\nĐang thực hiện…')"))
    // every file signed by THE release certificate, the rotation rule, the licences shipped next to the exe
    expect(src).toContain('signer: SIGNER_THUMBPRINT,')
    expect(src).toContain('checkRotation({ prevVersion, prevPkg, signer: SIGNER_THUMBPRINT })')
    expect(src).toContain('newestPublishedVersion(publicReleases, V)')
    expect(src).toContain("git(['show', `refs/tags/v${prevVersion}:package.json`])")
    expect(src.indexOf('checkRotation({')).toBeLessThan(src.indexOf("console.log('\\nĐang thực hiện…')"))
    expect(src).toContain("{ name: 'LICENSE.txt', source: path.join(root, 'LICENSE.txt') }")
    expect(src).toContain('{ name: NOTICES_SHIPPED, source: path.join(root, ...NOTICES_SOURCE.split(\'/\')) }')
  })
})

describe('electron-build refusals', () => {
  const ARGS = ['--win', 'nsis', 'portable', '--publish', 'never']
  it('the dist:win command line passes', () => {
    expect(buildArgsProblem({}, ARGS)).toBeNull()
    expect(buildArgsProblem({ PATH: 'x', ELECTRON_BUILDER_OFFLINE: '0' }, ARGS)).toBeNull()
    expect(buildArgsProblem({ ELECTRON_BUILDER_OFFLINE: 'false' }, ARGS)).toBeNull()
    expect(buildArgsProblem({}, ['--publish', 'never', '--win', '--dir', '-c.directories.output=C:\\tmp\\x'])).toBeNull()
  })
  it('refuses ELECTRON_BUILDER_OFFLINE (any truthy value, any case of the name)', () => {
    for (const env of [{ ELECTRON_BUILDER_OFFLINE: 'true' }, { ELECTRON_BUILDER_OFFLINE: '1' }, { electron_builder_offline: 'yes' }, { ELECTRON_BUILDER_OFFLINE: ' TRUE ' }]) {
      expect(offlineEnvSet(env)).toBe(true)
      expect(buildArgsProblem(env, ARGS)).toMatch(/ELECTRON_BUILDER_OFFLINE/)
    }
    expect(offlineEnvSet({})).toBe(false)
    expect(offlineEnvSet({ ELECTRON_BUILDER_OFFLINE: '' })).toBe(false)
    expect(offlineEnvSet(null)).toBe(false)
  })
  it('refuses a line without the adjacent pair --publish never', () => {
    expect(buildArgsProblem({}, ['--win', 'nsis'])).toMatch(/Thiếu "--publish never"/)
    expect(buildArgsProblem({}, ['--win', '--publish'])).toMatch(/không được phép/)
    expect(buildArgsProblem({}, ['--win', 'never', '--publish'])).toMatch(/không được phép/)
    expect(buildArgsProblem({}, ['--win', '-p', 'never'])).toMatch(/Thiếu "--publish never"/)
    expect(buildArgsProblem({}, [])).toMatch(/Thiếu/)
    expect(buildArgsProblem({}, null)).toMatch(/Thiếu/)
  })
  it('refuses any other publish policy, even next to --publish never', () => {
    expect(buildArgsProblem({}, [...ARGS, '--publish', 'always'])).toMatch(/"--publish always" không được phép/)
    expect(buildArgsProblem({}, [...ARGS, '-p', 'onTagOrDraft'])).toMatch(/"-p onTagOrDraft"/)
    expect(buildArgsProblem({}, [...ARGS, '--publish=always'])).toMatch(/"--publish=always"/)
    expect(buildArgsProblem({}, [...ARGS, '-p=always'])).toMatch(/"-p=always"/)
    expect(buildArgsProblem({}, [...ARGS, '--publish=never'])).toBeNull()
  })
  it('electron-build.mjs spawns electron-builder without a shell and with the build cache off', () => {
    const src = fs.readFileSync(path.join(root, 'scripts', 'electron-build.mjs'), 'utf8')
    expect(src).toContain("require.resolve('electron-builder/cli.js')")
    expect(src).toContain('spawn(process.execPath, [cli, ...args]')
    expect(src).toContain("shell: false")
    expect(src).toContain("env.ELECTRON_BUILDER_DISABLE_BUILD_CACHE = 'true'")
    expect(src).toContain('buildArgsProblem(process.env, args)')
    expect(src).not.toMatch(/shell:\s*true/)
  })
})

describe('peeledTagSha', () => {
  const c = 'c8d629c8755e73695a4a013ee5e3b83458022e7a'
  const t = 'ecfdc9ec4ae1840b61347cceb2bdd06e69cefe85'
  it('prefers the peeled commit of an annotated tag', () => {
    expect(peeledTagSha(`${t}\trefs/tags/v0.4.2\r\n${c}\trefs/tags/v0.4.2^{}\r\n`, 'v0.4.2')).toBe(c)
  })
  it('uses the plain sha of a lightweight tag and ignores other tags', () => {
    expect(peeledTagSha(`${c}\trefs/tags/v0.4.2\n${t}\trefs/tags/v0.4.20\n`, 'v0.4.2')).toBe(c)
    expect(peeledTagSha(`${t}\trefs/tags/v0.4.20^{}\n`, 'v0.4.2')).toBeNull()
    expect(peeledTagSha('', 'v0.4.2')).toBeNull()
  })
})

describe('asar header', () => {
  const pkg = Buffer.from(JSON.stringify({ name: 'sanovids', productName: 'SanoVids', version: '0.5.0' }))
  const files = {
    'package.json': { size: pkg.length, offset: '0' },
    electron: { files: { 'main.cjs': { size: 0, offset: String(pkg.length) }, 'updater.cjs': { size: 0, offset: String(pkg.length) } } },
    node_modules: { files: { 'electron-updater': { files: { 'package.json': { size: 0, offset: String(pkg.length) } } } } },
  }
  const buf = fakeAsar(files, pkg)
  it('reads the header and finds entries', () => {
    expect(asarHeaderBytes(buf.subarray(0, 16))).toBe(16 + buf.readUInt32LE(12))
    const header = readAsarHeader(buf.subarray(0, asarHeaderBytes(buf)))
    expect(asarHas(header, 'electron/updater.cjs')).toBe(true)
    expect(asarHas(header, 'electron\\updater.cjs')).toBe(true)
    expect(asarHas(header, 'node_modules/electron-updater/package.json')).toBe(true)
    expect(asarHas(header, 'node_modules/react/package.json')).toBe(false)
    expect(asarHas(header, 'electron/constructor')).toBe(false)
    expect(asarHas(header, '')).toBe(false)
    expect(asarEntry(header, 'electron')).toHaveProperty('files')
  })
  it('locates file data', () => {
    const header = readAsarHeader(buf)
    const e = asarEntry(header, 'package.json')
    const start = asarDataOffset(buf) + Number(e.offset)
    expect(JSON.parse(buf.toString('utf8', start, start + e.size))).toMatchObject({ name: 'sanovids', version: '0.5.0' })
  })
  it('finds every runtime dependency of electron-updater (Node resolution, nested first)', () => {
    const dir = (pkgJson, extra = {}) => ({ files: { 'package.json': { size: 1, offset: '0', pkgJson }, ...extra } })
    const tree = {
      'electron-updater': dir(
        { dependencies: { 'builder-util-runtime': '9', semver: '~7.7.3', 'lazy-val': '1' }, optionalDependencies: { 'opt-only': '1' } },
        { node_modules: { files: { semver: dir({}) } } },
      ),
      'builder-util-runtime': dir({ dependencies: { debug: '4', sax: '1' } }),
      debug: dir({ dependencies: { ms: '2' } }),
      ms: dir({}),
      sax: dir({}),
      'lazy-val': dir({}),
    }
    const header = { files: { node_modules: { files: tree } } }
    const readJson = (p) => asarEntry(header, p)?.pkgJson ?? null
    expect(asarDependencyProblems(header, readJson)).toEqual([])
    // semver at the top level is fine too (electron-builder may hoist it)
    const hoisted = structuredClone(header)
    delete hoisted.files.node_modules.files['electron-updater'].files.node_modules
    hoisted.files.node_modules.files.semver = dir({})
    expect(asarDependencyProblems(hoisted, (p) => asarEntry(hoisted, p)?.pkgJson ?? null)).toEqual([])
    // missing packages (direct and transitive) are named
    const broken = structuredClone(header)
    delete broken.files.node_modules.files.ms
    delete broken.files.node_modules.files['electron-updater'].files.node_modules
    expect(asarDependencyProblems(broken, (p) => asarEntry(broken, p)?.pkgJson ?? null).sort()).toEqual(['Thiếu ms (debug cần).', 'Thiếu semver (electron-updater cần).'])
    expect(asarDependencyProblems({ files: {} }, () => null)).toEqual(['Thiếu node_modules/electron-updater/package.json.'])
    expect(asarDependencyProblems(header, () => null)).toEqual(['Không đọc được node_modules/electron-updater/package.json.'])
  })
  it('throws on truncated or foreign data', () => {
    expect(() => readAsarHeader(Buffer.alloc(4))).toThrow()
    expect(() => readAsarHeader(buf.subarray(0, 20))).toThrow(/truncated/)
    expect(() => asarHeaderBytes(Buffer.alloc(3))).toThrow()
  })
})

describe('compareAssets / planTarget', () => {
  const expected = [
    { name: 'SanoVids-Setup-0.5.0.exe', size: 100, sha256: SHA_A },
    { name: 'SanoVids-Portable-0.5.0.exe', size: 90, sha256: SHA_B },
  ]
  const asset = (name, size, sha, extra = {}) => ({ name, size, digest: sha ? `sha256:${sha}` : null, state: 'uploaded', ...extra })
  const both = [asset('SanoVids-Setup-0.5.0.exe', 100, SHA_A), asset('SanoVids-Portable-0.5.0.exe', 90, SHA_B)]
  const ctx = { repo: 'JameSteven404/sanovids', tag: 'v0.5.0', expected }

  it('compares names, sizes, digests and upload state', () => {
    expect(compareAssets(expected, both)).toEqual({ missing: [], mismatched: [], unverified: [], extra: [] })
    const r = compareAssets(expected, [
      asset('SanoVids-Setup-0.5.0.exe', 100, SHA_B.toUpperCase()),
      asset('old.txt', 1, SHA_A),
    ])
    expect(r.missing).toEqual(['SanoVids-Portable-0.5.0.exe'])
    expect(r.mismatched).toEqual([{ name: 'SanoVids-Setup-0.5.0.exe', reason: 'SHA-256 khác' }])
    expect(r.extra).toEqual(['old.txt'])
    expect(compareAssets(expected, [asset('SanoVids-Setup-0.5.0.exe', 99, SHA_A)]).mismatched[0].reason).toMatch(/kích thước/)
    expect(compareAssets(expected, [asset('SanoVids-Setup-0.5.0.exe', 100, SHA_A, { state: 'starter' })]).mismatched[0].reason).toMatch(/dở dang/)
    expect(compareAssets(expected, [asset('SanoVids-Setup-0.5.0.exe', 100, null)]).unverified).toEqual(['SanoVids-Setup-0.5.0.exe'])
    expect(compareAssets(expected, [asset('SanoVids-Setup-0.5.0.exe', 100, SHA_A.toUpperCase())]).mismatched).toEqual([])
  })
  it('no release → create a draft, upload everything, verify, publish', () => {
    expect(planTarget({ ...ctx, releases: [] })).toEqual({
      action: 'create',
      steps: ['create-draft', 'upload', 'verify', 'publish'],
      upload: ['SanoVids-Setup-0.5.0.exe', 'SanoVids-Portable-0.5.0.exe'],
      clobber: [],
    })
  })
  it('draft → upload missing, clobber mismatched, verify, publish', () => {
    const p = planTarget({ ...ctx, releases: [{ draft: true, assets: [asset('SanoVids-Setup-0.5.0.exe', 100, SHA_B)] }] })
    expect(p.action).toBe('update-draft')
    expect(p.steps).toEqual(['edit-notes', 'upload', 'clobber', 'verify', 'publish'])
    expect(p.upload).toEqual(['SanoVids-Portable-0.5.0.exe'])
    expect(p.clobber).toEqual(['SanoVids-Setup-0.5.0.exe'])
    expect(planTarget({ ...ctx, releases: [{ draft: true, assets: both }] }).steps).toEqual(['edit-notes', 'verify', 'publish'])
  })
  it('published and matching → skip; missing → repair without publish; no digest → verify only', () => {
    expect(planTarget({ ...ctx, releases: [{ draft: false, assets: both }] })).toMatchObject({ action: 'skip', steps: [] })
    const repair = planTarget({ ...ctx, releases: [{ draft: false, assets: [both[0]] }] })
    expect(repair).toMatchObject({ action: 'repair', steps: ['upload', 'verify'], upload: ['SanoVids-Portable-0.5.0.exe'], clobber: [] })
    const unverified = planTarget({ ...ctx, releases: [{ draft: false, assets: [both[0], asset('SanoVids-Portable-0.5.0.exe', 90, null)] }] })
    expect(unverified).toMatchObject({ action: 'verify-only', steps: ['verify'] })
  })
  it('published with a different file → STOP, never clobber', () => {
    const p = planTarget({ ...ctx, releases: [{ draft: false, assets: [asset('SanoVids-Setup-0.5.0.exe', 100, SHA_B), both[1]] }] })
    expect(p.action).toBe('stop')
    expect(p.steps).toEqual([])
    expect(p.clobber).toEqual([])
    expect(p.message).toMatch(/ĐÃ ĐĂNG/)
    expect(p.message).toMatch(/tăng số phiên bản/)
  })
  it('stops on duplicate releases or a pre-release', () => {
    expect(planTarget({ ...ctx, releases: [{ draft: true, assets: [] }, { draft: true, assets: [] }] }).action).toBe('stop')
    expect(planTarget({ ...ctx, releases: [{ draft: false, prerelease: true, assets: both }] }).action).toBe('stop')
  })
})

describe('gh argv', () => {
  const repo = 'JameSteven404/sanovids-releases'
  it('builds draft / upload / publish commands', () => {
    expect(ghListReleasesArgs(repo)).toEqual(['api', 'repos/JameSteven404/sanovids-releases/releases?per_page=100'])
    expect(ghCreateDraftArgs({ repo: PRIVATE_REPO, tag: 'v0.5.0', title: 'T', notesFile: 'n.md', audience: 'private' })).toEqual([
      'release', 'create', 'v0.5.0', '-R', 'JameSteven404/sanovids', '--draft', '--title', 'T', '--notes-file', 'n.md', '--verify-tag',
    ])
    expect(ghCreateDraftArgs({ repo, tag: 'v0.5.0', title: 'T', notesFile: 'n.md', audience: 'public' }).slice(-2)).toEqual(['--target', 'main'])
    expect(ghEditNotesArgs({ repo, tag: 'v0.5.0', title: 'T', notesFile: 'n.md' })).toEqual(['release', 'edit', 'v0.5.0', '-R', repo, '--title', 'T', '--notes-file', 'n.md'])
    expect(ghUploadArgs({ repo, tag: 'v0.5.0', files: ['a.exe', 'latest.yml'] })).toEqual(['release', 'upload', 'v0.5.0', 'a.exe', 'latest.yml', '-R', repo])
    expect(ghUploadArgs({ repo, tag: 'v0.5.0', files: ['a.exe'], clobber: true }).at(-1)).toBe('--clobber')
    // --prerelease=false: a draft marked pre-release would stay invisible to the app
    expect(ghPublishArgs({ repo, tag: 'v0.5.0' })).toEqual(['release', 'edit', 'v0.5.0', '-R', repo, '--draft=false', '--prerelease=false', '--latest'])
  })
  it('formats argv for display', () => {
    expect(formatArgv('gh', ['release', 'edit', 'v0.5.0', '--title', 'SanoVids 0.5.0 — x', 'release\\a.exe'])).toBe(
      'gh release edit v0.5.0 --title "SanoVids 0.5.0 — x" release\\a.exe',
    )
  })
})

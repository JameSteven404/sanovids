// Unit tests of the pure release helpers (scripts/releaseLib.mjs). Fixtures: the real CHANGELOG.md, the latest.yml
// of the published 0.4.2 build and a hand-made asar header.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { load as loadYaml } from 'js-yaml'
import {
  NOTES_CAP,
  PRIVATE_REPO,
  PUBLIC_REPO,
  PUBLISH_ENTRY,
  asarDataOffset,
  asarDependencyProblems,
  asarEntry,
  asarHas,
  asarHeaderBytes,
  assetsFor,
  boldTitlesToHeadings,
  buildReleaseNotes,
  capText,
  checkAppUpdateYml,
  checkLatestYml,
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
    const { text } = updateNotesText(CHANGELOG, '0.5.0')
    const headings = text.split('\n').filter((l) => l.startsWith('### '))
    expect(headings).toEqual([
      '### ✨ SanoVids tự cập nhật (bản cài Setup)',
      '### ⚠️ Lần này phải cài tay 0.5.0 một lần',
      '### 🛠️ Trang tải về chuyển sang',
    ])
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
    expect(assetsFor('private', '0.5.0')).toEqual(['SanoVids-Setup-0.5.0.exe', 'SanoVids-Portable-0.5.0.exe'])
    expect(assetsFor('public', '0.5.0')).toEqual([
      'SanoVids-Setup-0.5.0.exe',
      'SanoVids-Setup-0.5.0.exe.blockmap',
      'latest.yml',
      'SanoVids-Portable-0.5.0.exe',
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
        'Cài đè lên bản cũ được, dự án và cài đặt giữ nguyên. Lịch sử đầy đủ: [CHANGELOG.md](https://github.com/JameSteven404/sanovids/blob/main/CHANGELOG.md).\n',
    )
    const pub = buildReleaseNotes({ version: '0.5.0', body: '✨ a', sha256, audience: 'public' })
    expect(pub).toContain('`latest.yml` và `.blockmap` là file dùng cho việc tự cập nhật — không cần tải.')
    expect(pub).not.toContain('github.com/JameSteven404/sanovids/')
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
  const good = { owner: 'JameSteven404', repo: 'sanovids-releases', provider: 'github', releaseType: 'release', updaterCacheDirName: 'sanovids-updater' }
  it('accepts the public feed', () => {
    expect(checkAppUpdateYml(good)).toEqual([])
    expect(checkAppUpdateYml(loadYaml('owner: JameSteven404\nrepo: sanovids-releases\nprovider: github\nreleaseType: release\nupdaterCacheDirName: sanovids-updater\n'))).toEqual([])
  })
  it('refuses the 0.4.2 feed (private source repo)', () => {
    const p = checkAppUpdateYml(loadYaml('owner: JameSteven404\nrepo: sanovids\nprovider: github\nupdaterCacheDirName: sanovids-updater\n'))
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/sanovids-releases/)
  })
  it('refuses tokens, private, publisherName, channel and other providers', () => {
    expect(checkAppUpdateYml({ ...good, token: 'x' })).toHaveLength(1)
    expect(checkAppUpdateYml({ ...good, private: true })).toHaveLength(1)
    expect(checkAppUpdateYml({ ...good, publisherName: ['x'] })).toHaveLength(1)
    expect(checkAppUpdateYml({ ...good, channel: 'beta' })).toHaveLength(1)
    expect(checkAppUpdateYml({ ...good, provider: 'generic', owner: 'x' })).toHaveLength(2)
    expect(checkAppUpdateYml(null)).toHaveLength(1)
  })
  it('PUBLISH_ENTRY is the anonymous public feed', () => {
    expect(PUBLISH_ENTRY).toEqual({ provider: 'github', owner: 'JameSteven404', repo: 'sanovids-releases', releaseType: 'release' })
    expect(checkAppUpdateYml({ ...PUBLISH_ENTRY })).toEqual([])
    expect(PUBLIC_REPO).toBe('JameSteven404/sanovids-releases')
    expect(PRIVATE_REPO).toBe('JameSteven404/sanovids')
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

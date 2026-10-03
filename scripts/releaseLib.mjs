// Pure helpers of the release tooling (scripts/update-notes.mjs, scripts/publish-release.mjs, scripts/tidy-release.mjs,
// scripts/electron-build.mjs, scripts/buildInspect.mjs).
// No I/O here: every function takes text / buffers / plain objects and returns plain data, so
// scripts/__tests__/releaseLib.test.mjs covers all of it. User-facing strings are Vietnamese (the owner reads them).
//
// Two GitHub repos:
//   PRIVATE_REPO  JameSteven404/sanovids           source code + installers (history for the owner)
//   PUBLIC_REPO   JameSteven404/sanovids-releases  installers + latest.yml + blockmap + the public signing certificate:
//                                                  the auto-update feed the app reads anonymously
//                                                  (package.json build.publish → app-update.yml)
import { X509Certificate } from 'node:crypto'

export const OWNER = 'JameSteven404'
export const PRIVATE_REPO = `${OWNER}/sanovids`
export const PUBLIC_REPO_NAME = 'sanovids-releases'
export const PUBLIC_REPO = `${OWNER}/${PUBLIC_REPO_NAME}`
export const PUBLIC_RELEASES_URL = `https://github.com/${PUBLIC_REPO}/releases/latest`
/** The one and only package.json build.publish entry (no token, no private flag: the app reads a public repo). */
export const PUBLISH_ENTRY = Object.freeze({ provider: 'github', owner: OWNER, repo: PUBLIC_REPO_NAME, releaseType: 'release' })
/** The app keeps at most 8000 chars of notes (updateTypes UPDATE_NOTES_MAX); stay a little under it. */
export const NOTES_CAP = 7900

// ───────────────────────────── author / signing ─────────────────────────────
// Byte-identical (NFC) to package.json author.name, build.extraMetadata.author.name, build.copyright and
// build.win.signtoolOptions.publisherName (src/lib/__tests__/buildConfig.test.ts checks package.json).

/** Author and publisher of every official build: CompanyName, uninstall Publisher, signer, app-update.yml publisherName. */
export const AUTHOR = 'Nguyễn Giang Minh (Jame Steven)'
/** LegalCopyright of the exe / Setup / Portable (package.json build.copyright). Sano Group is a partner, never the author. */
export const COPYRIGHT_BUILD = '© 2026 Nguyễn Giang Minh (Jame Steven) · Đồng hành: Sano Group'
/**
 * SHA-1 thumbprint of the certificate that signs releases (= signtoolOptions.certificateSha1, one of package.json
 * sanovids.signers). Shown in the release notes and release/DOC-TOI.txt. Rotation (docs/SIGNING.md): change it in the
 * release that switches signing to the new certificate; publish-release refuses a mismatch with certificateSha1.
 */
export const SIGNER_THUMBPRINT = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
/** Public part of the signing certificate (build/signing/, no private key): uploaded with every release. */
export const SIGNING_CERT_FILE = 'SanoVids-NguyenGiangMinh.cer'
const THUMBPRINT = /^[0-9A-F]{40}$/

const SECTION_HEADER = /^## \[(\d+\.\d+\.\d+)\] — (\d{4}-\d{2}-\d{2})(?: — (.+))?$/
const LINK_REF = /^\[[^\]\n]+\]:\s*\S+/
const VERSION = /^\d+\.\d+\.\d+$/
const SHA256_HEX = /^[0-9a-f]{64}$/i

// ───────────────────────────── versions ─────────────────────────────

/** -1 | 0 | 1 on numeric x.y.z (anything after the third number is ignored). */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b).split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

/** Newest published (not draft, not pre-release) vX.Y.Z of a `gh api repos/<r>/releases` list, or null. */
export function newestPublishedVersion(releases) {
  let best = null
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || r.prerelease) continue
    const m = /^v(\d+\.\d+\.\d+)$/.exec(String(r.tag_name ?? ''))
    if (m && (best == null || compareVersions(m[1], best) > 0)) best = m[1]
  }
  return best
}

// ───────────────────────────── CHANGELOG / notes ─────────────────────────────

/**
 * The CHANGELOG.md section of `version`: header `## [x.y.z] — yyyy-mm-dd( — subtitle)`, body up to the next `## ` or
 * the link-reference block at the end. → { version, date, subtitle | null, body } | null
 */
export function extractChangelogSection(text, version) {
  if (typeof text !== 'string' || !VERSION.test(String(version))) return null
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_HEADER.exec(lines[i])
    if (!m || m[1] !== version) continue
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('## ') || LINK_REF.test(lines[j])) break
      body.push(lines[j])
    }
    return { version: m[1], date: m[2], subtitle: m[3] ? m[3].trim() : null, body: body.join('\n').trim() }
  }
  return null
}

/** Drops markdown link-reference lines (`[0.4.2]: https://…`). */
export function stripLinkRefs(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !LINK_REF.test(l))
    .join('\n')
}

/** Caps `text` at `max` chars: cut at the last line break before the cap and end with a "…" line. */
export function capText(text, max = NOTES_CAP) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  let cut = s.slice(0, Math.max(0, max - 2))
  const nl = cut.lastIndexOf('\n')
  if (nl > 0) cut = cut.slice(0, nl)
  return `${cut.trimEnd()}\n…`
}

/** An emoji (with its variation selector / ZWJ sequence) + a bold phrase at the start of a line: a CHANGELOG section title. */
const EMOJI_BOLD_TITLE = /^((?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:[️‍]|\p{Extended_Pictographic}|\p{Emoji_Presentation})*\s+)\*\*([^*\n]+?)\*\*(.*)$/u

/**
 * CHANGELOG section titles ("✨ **SanoVids tự cập nhật** (bản cài Setup)") → markdown headings, which is what the in-app
 * notes (lib/updateModel noteBlocks) show as headings. A short "(…)" after the bold part stays in the heading; a longer
 * text after it becomes the paragraph below. List items and other lines are untouched.
 */
export function boldTitlesToHeadings(text) {
  return String(text ?? '')
    .split('\n')
    .flatMap((line) => {
      const m = EMOJI_BOLD_TITLE.exec(line)
      if (!m) return [line]
      const title = `### ${m[1]}${m[2].trim()}`
      const rest = m[3].trim()
      if (!rest) return [title]
      if (/^\([^()\n]{1,60}\)$/.test(rest)) return [`${title} ${rest}`]
      return [title, rest.replace(/^[:—–-]\s*/, '')]
    })
    .join('\n')
}

/**
 * Text of build/release-notes.md (electron-builder copies it into latest.yml releaseNotes = the in-app "Có gì mới").
 * → { found, text } — LF line endings, ends with one newline. Missing section → "SanoVids <v>". Section titles become
 * headings (boldTitlesToHeadings).
 */
export function updateNotesText(changelogText, version) {
  const section = extractChangelogSection(changelogText, version)
  const body = section ? stripLinkRefs(section.body).trim() : ''
  if (!body) return { found: false, text: `SanoVids ${version}\n` }
  return { found: true, text: `${capText(boldTitlesToHeadings(body), NOTES_CAP)}\n` }
}

/** GitHub release title. */
export function releaseTitle(version, subtitle) {
  const sub = typeof subtitle === 'string' ? subtitle.trim() : ''
  return sub ? `SanoVids ${version} — ${sub}` : `SanoVids ${version}`
}

/** File names electron-builder produces for `version` (package.json nsis/portable artifactName). */
export function releaseFiles(version) {
  const setup = `SanoVids-Setup-${version}.exe`
  return { setup, portable: `SanoVids-Portable-${version}.exe`, blockmap: `${setup}.blockmap`, latestYml: 'latest.yml' }
}

/**
 * Assets of one GitHub release. Private: the two installers + the public signing certificate. Public: + latest.yml and
 * the Setup blockmap (the feed).
 */
export function assetsFor(audience, version) {
  const f = releaseFiles(version)
  if (audience === 'private') return [f.setup, f.portable, SIGNING_CERT_FILE]
  if (audience === 'public') return [f.setup, f.blockmap, f.latestYml, f.portable, SIGNING_CERT_FILE]
  throw new Error(`assetsFor: unknown audience "${audience}"`)
}

const PRIVATE_BLOB = `https://github.com/${PRIVATE_REPO}/blob/main/`
const MD_LINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g
const PRIVATE_URL = /^https:\/\/github\.com\/JameSteven404\/sanovids(?:[/?#].*)?$/i

/**
 * CHANGELOG body → release body for one audience. Private: relative links point at the private repo on GitHub.
 * Public: links into the private repo (relative or absolute) become plain text — public readers cannot open them.
 */
export function releaseBody(body, audience) {
  const text = stripLinkRefs(body).trim()
  return text.replace(MD_LINK, (all, bang, label, url) => {
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('#')
    if (audience === 'public') return relative || PRIVATE_URL.test(url) ? label : all
    return relative ? `${bang}[${label}](${PRIVATE_BLOB}${url.replace(/^\.?\//, '')})` : all
  })
}

const SETUP_USE = '**Khuyên dùng.** Cài vào máy, có icon Desktop/Start Menu, tự cập nhật các bản sau.'
const PORTABLE_USE = 'Chạy không cần cài (hợp chép USB). Không tự cập nhật — app chỉ báo có bản mới.'
/** Last paragraph of both release notes: who signed the installers and how to check it. */
export const SIGNING_NOTE =
  `Bản cài được ký số bởi **${AUTHOR}** — dấu vân tay chứng chỉ \`${SIGNER_THUMBPRINT}\`. ` +
  'Kiểm tra: chuột phải file → Properties → Digital Signatures. ' +
  `File \`${SIGNING_CERT_FILE}\` là chứng chỉ công khai (không chứa khoá).`
const NOTES_FOOTER = {
  private: `Cài đè lên bản cũ được, dự án và cài đặt giữ nguyên. Lịch sử đầy đủ: [CHANGELOG.md](https://github.com/${PRIVATE_REPO}/blob/main/CHANGELOG.md).\n\n${SIGNING_NOTE}`,
  public: `Cài đè lên bản cũ được, dự án và cài đặt giữ nguyên. \`latest.yml\` và \`.blockmap\` là file dùng cho việc tự cập nhật — không cần tải.\n\n${SIGNING_NOTE}`,
}

/**
 * GitHub release notes (format of v0.4.2): the CHANGELOG body, then a "⬇️ Tải về" table with SHA-256 of both
 * installers, then a footer. `sha256` = { [fileName]: hex }. Throws when a checksum is missing.
 */
export function buildReleaseNotes({ version, body, sha256, audience }) {
  if (!(audience in NOTES_FOOTER)) throw new Error(`buildReleaseNotes: unknown audience "${audience}"`)
  const f = releaseFiles(version)
  const row = (name, use) => {
    const sum = sha256?.[name]
    if (typeof sum !== 'string' || !SHA256_HEX.test(sum)) throw new Error(`buildReleaseNotes: no SHA-256 for ${name}`)
    return `| **${name}** | ${use} | \`${sum.toLowerCase()}\` |`
  }
  return (
    '\n' +
    releaseBody(body, audience) +
    '\n\n---\n\n### ⬇️ Tải về\n\n| File | Dùng khi | SHA-256 |\n|---|---|---|\n' +
    [row(f.setup, SETUP_USE), row(f.portable, PORTABLE_USE)].join('\n') +
    '\n\n' +
    NOTES_FOOTER[audience] +
    '\n'
  )
}

// ───────────────────────────── update metadata ─────────────────────────────

/**
 * latest.yml (parsed) against the Setup actually built. expected = { version, setupName, sha512 (base64), size,
 * notBefore? (ISO date: the release commit) }. → problem strings (empty = fine). Missing releaseNotes is not a
 * problem here (the caller warns).
 */
export function checkLatestYml(obj, { version, setupName, sha512, size, notBefore } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['latest.yml không đọc được (không phải YAML hợp lệ).']
  const p = []
  if (String(obj.version) !== version) p.push(`version trong latest.yml là "${obj.version}", cần "${version}".`)
  if (obj.path !== setupName) p.push(`path trong latest.yml là "${obj.path}", cần "${setupName}".`)
  if (obj.sha512 !== sha512) p.push('sha512 trong latest.yml không khớp file Setup.')
  const f = Array.isArray(obj.files) ? obj.files[0] : null
  if (!f || typeof f !== 'object') p.push('latest.yml không có danh sách files.')
  else {
    if (f.url !== setupName) p.push(`files[0].url là "${f.url}", cần "${setupName}".`)
    if (f.sha512 !== sha512) p.push('files[0].sha512 không khớp file Setup (file Setup đã bị build lại hoặc bị sửa).')
    if (f.size !== size) p.push(`files[0].size là ${f.size}, file Setup nặng ${size} byte.`)
  }
  const date = obj.releaseDate instanceof Date ? obj.releaseDate : new Date(String(obj.releaseDate ?? ''))
  if (Number.isNaN(date.getTime())) p.push('latest.yml không có releaseDate hợp lệ.')
  else if (notBefore && date.getTime() < new Date(notBefore).getTime()) {
    p.push(`releaseDate ${date.toISOString()} cũ hơn commit phát hành (${notBefore}): bản build cũ hơn commit, chạy lại npm run dist:win.`)
  }
  return p
}

/**
 * resources/app-update.yml (parsed) of the packaged app: must point at the public feed, anonymously, and carry the
 * publisherName of the signed build (electron-builder writes it from build.win.signtoolOptions.publisherName; the
 * updater's pinned signature check is installed either way, the field is the second lock).
 * expected.publisherName = AUTHOR (package.json build.win.signtoolOptions.publisherName). Compared after NFC.
 */
export function checkAppUpdateYml(obj, { publisherName } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['app-update.yml không đọc được.']
  const p = []
  if (obj.provider !== 'github') p.push(`provider là "${obj.provider}", cần "github".`)
  if (obj.owner !== OWNER) p.push(`owner là "${obj.owner}", cần "${OWNER}".`)
  if (obj.repo !== PUBLIC_REPO_NAME) p.push(`repo là "${obj.repo}", cần "${PUBLIC_REPO_NAME}" (repo công khai chứa bản cập nhật).`)
  if ('token' in obj) p.push('app-update.yml có token — không bao giờ được đưa token vào app.')
  if ('private' in obj) p.push('app-update.yml có "private" — app phải đọc repo công khai, không cần đăng nhập.')
  if ('channel' in obj) p.push('app-update.yml có channel — app sẽ tìm sai file cập nhật.')
  const want = typeof publisherName === 'string' ? publisherName.normalize('NFC') : ''
  const raw = obj.publisherName
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
    p.push('app-update.yml thiếu publisherName — app sẽ không kiểm tra chữ ký số của bản cập nhật.')
  } else if (!want) {
    p.push('Không biết publisherName cần có (package.json build.win.signtoolOptions.publisherName trống).')
  } else if (!list || list.length !== 1 || typeof list[0] !== 'string' || list[0].normalize('NFC') !== want) {
    p.push(`publisherName trong app-update.yml là ${JSON.stringify(raw)}, cần ["${want}"].`)
  }
  return p
}

// ───────────────────────────── signed build checks ─────────────────────────────

/** Is ELECTRON_BUILDER_OFFLINE set (any case of the name; '', '0', 'false', 'no', 'off' count as not set)? */
export function offlineEnvSet(env) {
  for (const [k, v] of Object.entries(env ?? {})) {
    if (k.toUpperCase() !== 'ELECTRON_BUILDER_OFFLINE' || v == null) continue
    if (!['', '0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase())) return true
  }
  return false
}

/**
 * Refusals of scripts/electron-build.mjs (release builds): → Vietnamese problem text, or null when the build may run.
 * - ELECTRON_BUILDER_OFFLINE set: electron-builder then signs WITHOUT an RFC 3161 timestamp and says nothing.
 * - no adjacent `--publish never`, or any other publish policy on the line (`--publish always`, `-p onTag`,
 *   `--publish=always`): a release build never publishes; npm run release:publish does that after its checks.
 */
export function buildArgsProblem(env, argv) {
  if (offlineEnvSet(env)) {
    return 'Biến môi trường ELECTRON_BUILDER_OFFLINE đang bật: electron-builder sẽ ký số KHÔNG có dấu thời gian (timestamp) mà không báo lỗi. Xoá biến đó rồi chạy lại.'
  }
  const args = Array.isArray(argv) ? argv.map(String) : []
  let never = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--publish' || a === '-p') {
      if (args[i + 1] !== 'never') {
        return `Tham số "${`${a} ${args[i + 1] ?? ''}`.trim()}" không được phép: bản build phát hành luôn dùng "--publish never".`
      }
      if (a === '--publish') never = true
    } else if (/^(--publish|-p)=/.test(a) && a !== '--publish=never') {
      return `Tham số "${a}" không được phép: bản build phát hành luôn dùng "--publish never".`
    }
  }
  if (!never) return 'Thiếu "--publish never": bản build phát hành không bao giờ tự đăng lên GitHub (đăng bằng npm run release:publish sau khi kiểm tra).'
  return null
}

/**
 * Release gate on one signature verdict (electron/signature.cjs checkFileSignature): the file must be signed by a
 * pinned certificate AND carry an RFC 3161 timestamp (without one the signature dies when the certificate expires).
 * → problem strings ([] = fine).
 */
export function checkSignatureVerdict(label, verdict) {
  if (!verdict || typeof verdict !== 'object') return [`${label}: không có kết quả kiểm tra chữ ký số.`]
  const thumb = typeof verdict.thumbprint === 'string' ? verdict.thumbprint : ''
  const who = verdict.signer ? `"${verdict.signer}"` : 'người khác'
  if (verdict.ok === true && verdict.status === 'signed') {
    if (verdict.timestamped === true) return []
    return [`${label} đã ký số nhưng thiếu dấu thời gian (timestamp): chữ ký sẽ hết hiệu lực khi chứng chỉ hết hạn. Build lại khi máy chủ timestamp chạy được.`]
  }
  switch (verdict.status) {
    case 'unsigned':
      return [`${label} chưa được ký số.`]
    case 'other-signer':
      return [`${label} được ký bởi ${who}${thumb ? ` (vân tay ${thumb})` : ''}, không phải chứng chỉ của tác giả (package.json sanovids.signers).`]
    case 'tampered':
      return [`${label} đã bị sửa sau khi ký (chữ ký số không khớp nội dung file).`]
    default: {
      const why =
        verdict.reason === 'no-pins'
          ? 'không có vân tay chứng chỉ nào để so (package.json sanovids.signers trống)'
          : verdict.reason === 'bad-chain'
            ? 'chuỗi chứng chỉ không hợp lệ'
            : 'không đọc được chữ ký số (PowerShell lỗi hoặc quá lâu)'
      return [`${label}: ${why}.`]
    }
  }
}

/** Fuse wire index → @electron/fuses FuseV1Options name. */
export const FUSE_NAMES = Object.freeze([
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
])
/**
 * Expected fuse wire of the packaged exe ('0' = 48 off, '1' = 49 on): package.json build.electronFuses. Cookie
 * encryption stays OFF on purpose; index 6 (V8 snapshot) is left at Electron's default (off); index 8+ (WasmTrapHandlers…)
 * is not managed by the tooling and ignored.
 */
export const EXPECTED_FUSE_WIRE = Object.freeze({ 0: 48, 1: 48, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 48 })

/** @electron/fuses getCurrentFuseWire() result → problem strings ([] = the wire is exactly EXPECTED_FUSE_WIRE on 0–7). */
export function checkFuseWire(wire) {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return ['Không đọc được fuse của file exe.']
  const p = []
  if (wire.version != null && String(wire.version) !== '1') p.push(`Fuse wire phiên bản "${wire.version}", cần "1".`)
  const state = (n) => (n === 48 ? 'tắt' : n === 49 ? 'bật' : n === 114 ? 'đã bị bỏ' : n == null ? 'không có' : `mã ${n}`)
  for (const [i, want] of Object.entries(EXPECTED_FUSE_WIRE)) {
    const got = wire[i]
    if (got !== want) p.push(`Fuse ${FUSE_NAMES[i]} đang ${state(got)}, cần ${state(want)}.`)
  }
  return p
}

/**
 * package.json packed inside app.asar against the repo's package.json: the release's name / productName / version,
 * the author, the exact signer pins (a test build's extraMetadata pins are UNIONED with the real one, so any extra pin
 * means a test build) and no baked test profile. → short Vietnamese fragments ([] = it is the release build).
 */
export function checkPackagedIdentity(inner, repoPkg) {
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return ['không đọc được package.json trong app']
  const repo = repoPkg && typeof repoPkg === 'object' ? repoPkg : {}
  const bad = []
  if (inner.name !== repo.name) bad.push(`name "${inner.name}" (cần "${repo.name}")`)
  if (inner.productName !== repo.productName) bad.push(`productName "${inner.productName}" (cần "${repo.productName}")`)
  if (inner.version !== repo.version) bad.push(`version "${inner.version}" (cần "${repo.version}")`)
  const author = typeof inner.author === 'string' ? inner.author : inner.author && typeof inner.author === 'object' ? inner.author.name : undefined
  if (author !== AUTHOR) bad.push(`tác giả "${author ?? ''}" (cần "${AUTHOR}")`)
  const want = repo.sanovids && Array.isArray(repo.sanovids.signers) ? repo.sanovids.signers : null
  const got = inner.sanovids && Array.isArray(inner.sanovids.signers) ? inner.sanovids.signers : null
  if (!want || !want.length) bad.push('package.json của repo không có sanovids.signers')
  else if (!got) bad.push('không có sanovids.signers (bản build trước 0.5.0, không kiểm tra chữ ký số bản cập nhật)')
  else if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
    bad.push(`sanovids.signers ${JSON.stringify(got)} (cần ${JSON.stringify(want)}: bản build thử nghiệm có thêm vân tay?)`)
  }
  if ('sanovidsTestProfileDir' in inner) bad.push('có sanovidsTestProfileDir (bản build thử nghiệm!)')
  return bad
}

/**
 * Windows VersionInfo of one file (scripts/buildInspect.mjs parseVersionInfoOutput: { companyName, legalCopyright, … })
 * → problem strings. expected = { company: AUTHOR, copyright: COPYRIGHT_BUILD }; exact strings (a CompanyName without
 * "(Jame Steven)" means electron-builder's author parsing won again: package.json build.extraMetadata.author).
 */
export function checkVersionInfo(label, info, { company, copyright } = {}) {
  if (!info || typeof info !== 'object') return [`${label}: không đọc được thông tin file (VersionInfo).`]
  const p = []
  if (info.companyName !== company) p.push(`${label}: CompanyName là ${JSON.stringify(info.companyName ?? null)}, cần "${company}".`)
  if (info.legalCopyright !== copyright) p.push(`${label}: LegalCopyright là ${JSON.stringify(info.legalCopyright ?? null)}, cần "${copyright}".`)
  return p
}

/** SHA-1 thumbprint (40 hex, upper case) of a certificate (DER or PEM), or null. */
export function certThumbprint(der) {
  try {
    return new X509Certificate(der).fingerprint.replace(/:/g, '').toUpperCase()
  } catch {
    return null
  }
}

/**
 * The public certificate uploaded with each release (build/signing/SanoVids-NguyenGiangMinh.cer): a certificate whose
 * SHA-1 thumbprint is one of the pins, and nothing that looks like a private key. → problem strings.
 */
export function checkCertFile(der, pins) {
  const list = (Array.isArray(pins) ? pins : []).map((x) => String(x).replace(/\s+/g, '').toUpperCase()).filter((x) => THUMBPRINT.test(x))
  if (!der || !der.length) return [`Không đọc được ${SIGNING_CERT_FILE}.`]
  if (Buffer.from(der).includes('PRIVATE KEY')) return [`${SIGNING_CERT_FILE} có chứa khoá riêng — KHÔNG BAO GIỜ đăng file này. Xuất lại chỉ phần công khai (.cer).`]
  const thumb = certThumbprint(der)
  if (!thumb) return [`${SIGNING_CERT_FILE} không phải chứng chỉ X.509 hợp lệ.`]
  if (!list.length) return ['package.json không có sanovids.signers để so với chứng chỉ.']
  if (!list.includes(thumb)) return [`${SIGNING_CERT_FILE} có vân tay ${thumb}, không nằm trong package.json sanovids.signers.`]
  return []
}

/** Commit sha a tag points at, from `git ls-remote --tags origin <tag> <tag>^{}` output (peeled if annotated). */
export function peeledTagSha(lsRemoteOutput, tag) {
  let plain = null
  let peeled = null
  for (const line of String(lsRemoteOutput ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{40,64})\s+(\S+)$/i.exec(line.trim())
    if (!m) continue
    if (m[2] === `refs/tags/${tag}^{}`) peeled = m[1].toLowerCase()
    else if (m[2] === `refs/tags/${tag}`) plain = m[1].toLowerCase()
  }
  return peeled ?? plain
}

// ───────────────────────────── asar ─────────────────────────────
// Layout: uint32 4 | uint32 headerPickleSize | uint32 payloadSize | uint32 jsonLength | JSON … | file data at
// 8 + headerPickleSize. Callers read the first 16 bytes, then asarHeaderBytes() bytes, never the whole archive.

/** Bytes to read from the start of the archive to get the whole JSON header (needs the first 16 bytes). */
export function asarHeaderBytes(prefix) {
  if (!prefix || prefix.length < 16) throw new Error('asar: need the first 16 bytes')
  return 16 + prefix.readUInt32LE(12)
}

/** Parsed JSON header ({ files: { … } }) from a buffer holding at least the header. */
export function readAsarHeader(buf) {
  if (!buf || buf.length < 16) throw new Error('asar: file too short')
  const len = buf.readUInt32LE(12)
  if (16 + len > buf.length) throw new Error('asar: header truncated')
  const header = JSON.parse(buf.toString('utf8', 16, 16 + len))
  if (!header || typeof header !== 'object' || typeof header.files !== 'object') throw new Error('asar: no files in header')
  return header
}

/** Offset of the file data area (header offsets are relative to it). */
export function asarDataOffset(buf) {
  if (!buf || buf.length < 8) throw new Error('asar: file too short')
  return 8 + buf.readUInt32LE(4)
}

/** Header node of `p` ('electron/updater.cjs', '/' or '\\'), or null. */
export function asarEntry(header, p) {
  let node = header
  for (const part of String(p).split(/[\\/]+/).filter(Boolean)) {
    const files = node && typeof node === 'object' ? node.files : null
    if (!files || typeof files !== 'object' || !Object.prototype.hasOwnProperty.call(files, part)) return null
    node = files[part]
  }
  return node === header ? null : node
}

export function asarHas(header, p) {
  return asarEntry(header, p) != null
}

/**
 * Runtime dependency closure of a package inside app.asar, resolved like Node does (nested node_modules first, then
 * every parent node_modules up to the root). readJson(path) → the parsed file inside the archive, or null (the caller
 * does the I/O). optionalDependencies may be missing. → list of problems ([] = every package `require` needs is there).
 * Guards against a build whose electron-updater loads `builder-util-runtime`, `js-yaml`, `semver`… that are not packed:
 * the app would then report "unsupported" and never update again.
 */
export function asarDependencyProblems(header, readJson, pkgName = 'electron-updater') {
  const problems = []
  const seen = new Set()
  const pkgDir = (dir) => `${dir}/package.json`
  const resolve = (fromDir, name) => {
    // <fromDir>/node_modules/<name>, then every ancestor node_modules folder: node_modules/a/node_modules/b →
    // …/b/node_modules/<name>, node_modules/a/node_modules/<name>, node_modules/<name>.
    const candidates = [`${fromDir}/node_modules/${name}`]
    const parts = fromDir.split('/')
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] === 'node_modules') candidates.push([...parts.slice(0, i + 1), name].join('/'))
    }
    return candidates.find((dir) => asarHas(header, pkgDir(dir))) ?? null
  }
  const visit = (dir, name, by) => {
    if (seen.has(dir)) return
    seen.add(dir)
    let pkg = null
    try {
      pkg = readJson(pkgDir(dir))
    } catch {
      pkg = null
    }
    if (!pkg || typeof pkg !== 'object') {
      problems.push(`Không đọc được ${pkgDir(dir)}${by ? ` (${by} cần)` : ''}.`)
      return
    }
    const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : []
    const optional = new Set(pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? Object.keys(pkg.optionalDependencies) : [])
    for (const dep of deps) {
      const found = resolve(dir, dep)
      if (found) visit(found, dep, name)
      else if (!optional.has(dep)) problems.push(`Thiếu ${dep} (${name} cần).`)
    }
  }
  const root = `node_modules/${pkgName}`
  if (!asarHas(header, pkgDir(root))) return [`Thiếu ${pkgDir(root)}.`]
  visit(root, pkgName, null)
  return problems
}

// ───────────────────────────── GitHub release state ─────────────────────────────

/**
 * Local files vs a GitHub release's assets. expected = [{ name, size, sha256 }]; remote = REST asset objects
 * ({ name, size, digest: 'sha256:…' | null, state }). → { missing, mismatched: [{ name, reason }], unverified, extra }
 * (unverified = same name and size but GitHub gave no digest: the caller downloads and hashes it).
 */
export function compareAssets(expected, remote) {
  const byName = new Map((Array.isArray(remote) ? remote : []).filter((a) => a && a.name).map((a) => [a.name, a]))
  const missing = []
  const mismatched = []
  const unverified = []
  for (const e of expected) {
    const r = byName.get(e.name)
    if (!r) {
      missing.push(e.name)
      continue
    }
    if (r.state != null && r.state !== 'uploaded') mismatched.push({ name: e.name, reason: `tải lên dở dang (trạng thái "${r.state}")` })
    else if (r.size !== e.size) mismatched.push({ name: e.name, reason: `kích thước ${r.size} ≠ ${e.size} byte` })
    else if (!r.digest) unverified.push(e.name)
    else if (String(r.digest).toLowerCase() !== `sha256:${String(e.sha256).toLowerCase()}`) mismatched.push({ name: e.name, reason: 'SHA-256 khác' })
  }
  const names = new Set(expected.map((e) => e.name))
  const extra = [...byName.keys()].filter((n) => !names.has(n))
  return { missing, mismatched, unverified, extra }
}

/**
 * Idempotent plan for one repo. state = { repo, tag, releases (every release whose tag_name is the tag), expected }.
 * → { action, steps, upload, clobber, compare?, message? }
 *   no release            → create: create-draft, upload, verify, publish
 *   draft                 → update-draft: edit-notes, upload (missing), clobber (mismatched), verify, publish
 *   published, matching   → skip
 *   published, missing    → repair: upload (missing), verify
 *   published, mismatched → stop (never overwrite a published file: users may be downloading it)
 */
export function planTarget({ repo, tag, releases, expected }) {
  const list = Array.isArray(releases) ? releases : []
  const names = expected.map((e) => e.name)
  const stop = (message, compare) => ({ action: 'stop', steps: [], upload: [], clobber: [], compare, message })
  if (list.length > 1) {
    return stop(`${repo} có ${list.length} bản phát hành cùng tag ${tag}. Vào trang Releases xoá bớt bản nháp thừa (giữ một bản) rồi chạy lại.`)
  }
  const rel = list[0]
  if (!rel) return { action: 'create', steps: ['create-draft', 'upload', 'verify', 'publish'], upload: names, clobber: [] }
  const compare = compareAssets(expected, rel.assets)
  if (rel.draft) {
    const steps = ['edit-notes']
    if (compare.missing.length) steps.push('upload')
    if (compare.mismatched.length) steps.push('clobber')
    steps.push('verify', 'publish')
    return { action: 'update-draft', steps, upload: compare.missing, clobber: compare.mismatched.map((m) => m.name), compare }
  }
  if (rel.prerelease) {
    return stop(`${tag} trên ${repo} đang là bản thử (pre-release) nên app không thấy. Bỏ đánh dấu pre-release trên GitHub (hoặc xoá bản đó) rồi chạy lại.`, compare)
  }
  if (compare.mismatched.length) {
    const why = compare.mismatched.map((m) => `${m.name}: ${m.reason}`).join('; ')
    return stop(
      `${tag} trên ${repo} ĐÃ ĐĂNG nhưng file khác bản build trên máy (${why}). Không ghi đè bản đã đăng vì máy người dùng có thể đang tải nó. ` +
        'Nếu bản build trên máy mới hơn: tăng số phiên bản trong package.json + CHANGELOG, tag lại, build và đăng bản mới.',
      compare,
    )
  }
  if (compare.missing.length) return { action: 'repair', steps: ['upload', 'verify'], upload: compare.missing, clobber: [], compare }
  if (compare.unverified.length) return { action: 'verify-only', steps: ['verify'], upload: [], clobber: [], compare }
  return { action: 'skip', steps: [], upload: [], clobber: [], compare }
}

// ───────────────────────────── gh argv ─────────────────────────────
// Every gh call goes through spawnSync with an args array (no shell). These builders are what --dry-run prints.

export function ghListReleasesArgs(repo) {
  return ['api', `repos/${repo}/releases?per_page=100`]
}

/** Private: the tag must already be on GitHub (--verify-tag). Public: the tag is created on `target` at publish. */
export function ghCreateDraftArgs({ repo, tag, title, notesFile, audience, target = 'main' }) {
  const where = audience === 'private' ? ['--verify-tag'] : ['--target', target]
  return ['release', 'create', tag, '-R', repo, '--draft', '--title', title, '--notes-file', notesFile, ...where]
}

export function ghEditNotesArgs({ repo, tag, title, notesFile }) {
  return ['release', 'edit', tag, '-R', repo, '--title', title, '--notes-file', notesFile]
}

/** --clobber only ever on drafts. */
export function ghUploadArgs({ repo, tag, files, clobber = false }) {
  return ['release', 'upload', tag, ...files, '-R', repo, ...(clobber ? ['--clobber'] : [])]
}

/** --prerelease=false: a draft someone marked pre-release would otherwise stay invisible to the app (allowPrerelease off). */
export function ghPublishArgs({ repo, tag }) {
  return ['release', 'edit', tag, '-R', repo, '--draft=false', '--prerelease=false', '--latest']
}

/** For printing only: `gh release create v0.5.0 -R … --title "SanoVids 0.5.0 — …"`. */
export function formatArgv(cmd, args) {
  return [cmd, ...args].map((a) => (/^[A-Za-z0-9_./\\:=@^{}+-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`)).join(' ')
}

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
// Sano Agent (SANO_AGENT below) has one more: JameSteven404/sano-agent-releases, its own public feed.
// The Mac build (Apple Silicon, ad hoc, experimental) joins the same releases: .dmg (+ the .zip, its blockmap and
// latest-mac.yml in the public feed), checked by the "macOS build" helpers below (scripts/mac-inspect.mjs on the Mac,
// scripts/fetch-mac-build.mjs and publish-release group (k) on Windows).
import { X509Certificate, createHash } from 'node:crypto'
import { createRequire } from 'node:module'

// The development-mode lock's pure rules (electron/devaccess-rules.cjs: no require, no I/O) — the same pin rules as
// the app.
const devAccessRules = createRequire(import.meta.url)('../electron/devaccess-rules.cjs')

export const OWNER = 'JameSteven404'
export const PRIVATE_REPO = `${OWNER}/sanovids`
export const PUBLIC_REPO_NAME = 'sanovids-releases'
export const PUBLIC_REPO = `${OWNER}/${PUBLIC_REPO_NAME}`
export const PUBLIC_RELEASES_URL = `https://github.com/${PUBLIC_REPO}/releases/latest`
/** The one and only package.json build.publish entry (no token, no private flag: the app reads a public repo). */
export const PUBLISH_ENTRY = Object.freeze({ provider: 'github', owner: OWNER, repo: PUBLIC_REPO_NAME, releaseType: 'release' })
/** The app keeps at most 8000 chars of notes (updateTypes UPDATE_NOTES_MAX); stay a little under it. */
export const NOTES_CAP = 7900

/**
 * The two products built from this repo. Every helper below that names files, repos or the product takes one (default
 * SanoVids, so SanoVids' own scripts and pins are unchanged). SANO_AGENT is pinned on its own and checked against
 * sano-agent/electron-builder.cjs by scripts/__tests__/releaseLib.test.mjs. Sano Agent (D220/D223): the SANO desktop
 * app, signed like SanoVids, public feed only (no private release, no Mac build), source tags sano-agent-vX.Y.Z.
 */
export const SANOVIDS = Object.freeze({
  productName: 'SanoVids',
  fileStem: 'SanoVids',
  publicRepoName: PUBLIC_REPO_NAME,
  sourceTagPrefix: 'v',
  changelog: 'CHANGELOG.md',
  releasesRepoDir: 'scripts/releases-repo',
  releaseDir: 'release',
  config: null,
  privateRelease: true,
  mac: true,
})
export const SANO_AGENT = Object.freeze({
  productName: 'Sano Agent',
  fileStem: 'SanoAgent',
  publicRepoName: 'sano-agent-releases',
  sourceTagPrefix: 'sano-agent-v',
  changelog: 'sano-agent/CHANGELOG.md',
  releasesRepoDir: 'sano-agent/releases-repo',
  releaseDir: 'release/sano-agent',
  config: 'sano-agent/electron-builder.cjs',
  /** electron-updater's cache folder (%LOCALAPPDATA%\<name>-updater): never SanoVids' own. */
  cacheDir: 'sano-agent-updater',
  /** The SANO address baked into the app (package.json sanoAgent.url, electron/hardening-rules sanoShell). */
  url: 'app://sano/',
  /** D240: the SANO web app packed in app.asar (scripts/build-sano.mjs), on top of REQUIRED_ASAR_FILES. */
  asarFiles: Object.freeze(['sano-dist/index.html', 'sano-dist/BUILD.json']),
  /** The SANO-AGENT commit sano-dist/ must be built from (checkSanoBuild). */
  sanoPin: 'sano-agent/sano.json',
  /** Its THIRD-PARTY-NOTICES.txt: SanoVids' notices plus SANO's packages (scripts/build-sano.mjs). */
  notices: 'build/license-third-party-sano-agent.txt',
  privateRelease: false,
  mac: false,
})
/** `--sano-agent` on the command line of update-notes / tidy-release / publish-release picks Sano Agent. */
export function productFromArgv(argv) {
  return Array.isArray(argv) && argv.includes('--sano-agent') ? SANO_AGENT : SANOVIDS
}
/**
 * The package.json a product's build packs (and its release is checked against): SanoVids' own, or for a product
 * with its own electron-builder config `cfg`, that config's extraMetadata over it and `build` = the config.
 */
export function effectivePackage(pkg, cfg) {
  return cfg ? { ...pkg, ...cfg.extraMetadata, build: cfg } : pkg
}

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

/**
 * Newest published (not draft, not pre-release) vX.Y.Z of a `gh api repos/<r>/releases` list, or null. With `below`,
 * only versions strictly older than it count (the release users run before this one).
 */
export function newestPublishedVersion(releases, below = null) {
  let best = null
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || r.prerelease) continue
    const m = /^v(\d+\.\d+\.\d+)$/.exec(String(r.tag_name ?? ''))
    if (!m || (below != null && compareVersions(m[1], below) >= 0)) continue
    if (best == null || compareVersions(m[1], best) > 0) best = m[1]
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
export function updateNotesText(changelogText, version, product = SANOVIDS) {
  const section = extractChangelogSection(changelogText, version)
  const body = section ? stripLinkRefs(section.body).trim() : ''
  if (!body) return { found: false, text: `${product.productName} ${version}\n` }
  return { found: true, text: `${capText(boldTitlesToHeadings(body), NOTES_CAP)}\n` }
}

/** GitHub release title. */
export function releaseTitle(version, subtitle, product = SANOVIDS) {
  const sub = typeof subtitle === 'string' ? subtitle.trim() : ''
  return sub ? `${product.productName} ${version} — ${sub}` : `${product.productName} ${version}`
}

/**
 * File names electron-builder produces for `version` (package.json nsis / portable / mac artifactName), plus the Mac
 * build's fixed companions (release/mac/): latest-mac.yml (the Mac feed), mac-check.json (scripts/mac-inspect.mjs on
 * the Mac) and mac-fetch.json (scripts/fetch-mac-build.mjs on Windows).
 */
export function releaseFiles(version, product = SANOVIDS) {
  const setup = `${product.fileStem}-Setup-${version}.exe`
  const mac = `${product.fileStem}-Mac-${version}-arm64`
  return {
    setup,
    portable: `${product.fileStem}-Portable-${version}.exe`,
    blockmap: `${setup}.blockmap`,
    latestYml: 'latest.yml',
    macDmg: `${mac}.dmg`,
    macZip: `${mac}.zip`,
    macZipBlockmap: `${mac}.zip.blockmap`,
    macYml: 'latest-mac.yml',
    macCheck: 'mac-check.json',
    macFetch: 'mac-fetch.json',
  }
}

/**
 * Assets of one GitHub release. Private: the two installers + the public signing certificate. Public: + latest.yml and
 * the Setup blockmap (the feed). With `mac`: private + the .dmg and mac-check.json; public + the .dmg, the .zip, its
 * blockmap and latest-mac.yml (never the .dmg blockmap).
 */
export function assetsFor(audience, version, { mac = false, product = SANOVIDS } = {}) {
  const f = releaseFiles(version, product)
  if (audience === 'private') return [f.setup, f.portable, ...(mac ? [f.macDmg, f.macCheck] : []), SIGNING_CERT_FILE]
  if (audience === 'public') return [f.setup, f.blockmap, f.latestYml, f.portable, ...(mac ? [f.macDmg, f.macZip, f.macZipBlockmap, f.macYml] : []), SIGNING_CERT_FILE]
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
/** The Mac row of the download table: experimental, ad hoc (no Apple signature), check-only updates. */
export const MAC_USE =
  '**Thử nghiệm.** Máy Mac chip Apple (M1 trở lên), macOS 13 trở lên. Chưa có chữ ký Apple: lần đầu mở (và mỗi bản mới) → Cài đặt hệ thống (System Settings) → Quyền riêng tư & Bảo mật (Privacy & Security) → Vẫn mở (Open Anyway). Không tự cập nhật — app chỉ báo có bản mới.'
/** The Mac sentence of the signing paragraph: never "signed" — compare the SHA-256 through another source. */
export const MAC_SIGNING_NOTE = 'Bản Mac chưa có chữ ký Apple; đối chiếu mã SHA-256 với tác giả qua một nguồn khác trang tải về.'
const NOTES_FOOTER_MAC = {
  private: `Cài đè lên bản cũ được, dự án và cài đặt giữ nguyên. Lịch sử đầy đủ: [CHANGELOG.md](https://github.com/${PRIVATE_REPO}/blob/main/CHANGELOG.md).\n\n${SIGNING_NOTE}\n\n${MAC_SIGNING_NOTE}`,
  public: `Cài đè lên bản cũ được, dự án và cài đặt giữ nguyên. \`latest.yml\`, \`latest-mac.yml\`, các file \`.blockmap\` và file \`.zip\` của bản Mac là file dùng cho việc kiểm tra / tự cập nhật — không cần tải.\n\n${SIGNING_NOTE}\n\n${MAC_SIGNING_NOTE}`,
}

/**
 * GitHub release notes (format of v0.4.2): the CHANGELOG body, then a "⬇️ Tải về" table with SHA-256 of both
 * installers (+ the Mac .dmg with `mac`), then a footer. `sha256` = { [fileName]: hex }. Throws when a checksum is
 * missing. Without `mac` the notes never mention a Mac build.
 */
export function buildReleaseNotes({ version, body, sha256, audience, mac = false, product = SANOVIDS }) {
  if (!(audience in NOTES_FOOTER)) throw new Error(`buildReleaseNotes: unknown audience "${audience}"`)
  const f = releaseFiles(version, product)
  const row = (name, use) => {
    const sum = sha256?.[name]
    if (typeof sum !== 'string' || !SHA256_HEX.test(sum)) throw new Error(`buildReleaseNotes: no SHA-256 for ${name}`)
    return `| **${name}** | ${use} | \`${sum.toLowerCase()}\` |`
  }
  const rows = [row(f.setup, SETUP_USE), row(f.portable, PORTABLE_USE), ...(mac ? [row(f.macDmg, MAC_USE)] : [])]
  return (
    '\n' +
    releaseBody(body, audience) +
    '\n\n---\n\n### ⬇️ Tải về\n\n| File | Dùng khi | SHA-256 |\n|---|---|---|\n' +
    rows.join('\n') +
    '\n\n' +
    (mac ? NOTES_FOOTER_MAC : NOTES_FOOTER)[audience] +
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

/** Problem text of an app-update.yml without publisherName (it does NOT switch the pinned verifier off). */
export const PUBLISHER_NAME_MISSING =
  'app-update.yml thiếu publisherName — lớp kiểm tra thứ hai của electron-updater bị mất: bản build không đúng cấu hình phát hành (build.win.signtoolOptions.publisherName).'

/**
 * resources/app-update.yml (parsed) of the packaged app: must point at the public feed, anonymously, and carry the
 * publisherName of the signed build (electron-builder writes it from build.win.signtoolOptions.publisherName). The
 * app's pinned verifier (electron/updater.cjs) runs whether the field is there or not; publisherName only turns on
 * electron-updater's own publisher check as a second lock, and its absence means the build did not use the release
 * configuration. expected.publisherName = AUTHOR. Compared after NFC.
 * platform 'mac': the same feed rules without publisherName (electron-builder writes it for Windows only, and the Mac
 * build never downloads an update anyway).
 */
export function checkAppUpdateYml(obj, { publisherName, platform = 'win', repo = PUBLIC_REPO_NAME, cacheDir } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['app-update.yml không đọc được.']
  const p = []
  if (obj.provider !== 'github') p.push(`provider là "${obj.provider}", cần "github".`)
  if (obj.owner !== OWNER) p.push(`owner là "${obj.owner}", cần "${OWNER}".`)
  if (obj.repo !== repo) p.push(`repo là "${obj.repo}", cần "${repo}" (repo công khai chứa bản cập nhật).`)
  // Sano Agent: its own electron-updater cache, so neither app deletes the other's pending installer.
  if (cacheDir !== undefined && obj.updaterCacheDirName !== cacheDir) p.push(`updaterCacheDirName là "${obj.updaterCacheDirName}", cần "${cacheDir}".`)
  if ('token' in obj) p.push('app-update.yml có token — không bao giờ được đưa token vào app.')
  if ('private' in obj) p.push('app-update.yml có "private" — app phải đọc repo công khai, không cần đăng nhập.')
  if ('channel' in obj) p.push('app-update.yml có channel — app sẽ tìm sai file cập nhật.')
  if (platform === 'mac') return p
  const want = typeof publisherName === 'string' ? publisherName.normalize('NFC') : ''
  const raw = obj.publisherName
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
    p.push(PUBLISHER_NAME_MISSING)
  } else if (!want) {
    p.push('Không biết publisherName cần có (package.json build.win.signtoolOptions.publisherName trống).')
  } else if (!list || list.length !== 1 || typeof list[0] !== 'string' || list[0].normalize('NFC') !== want) {
    p.push(`publisherName trong app-update.yml là ${JSON.stringify(raw)}, cần ["${want}"].`)
  }
  return p
}

// ───────────────────────────── macOS build ─────────────────────────────
// Made by GitHub Actions (.github/workflows/mac-build.yml → npm run dist:mac → scripts/mac-inspect.mjs writes
// mac-check.json), fetched onto the Windows machine by scripts/fetch-mac-build.mjs (mac-fetch.json: the run the owner
// tested) and checked again before publishing (scripts/publish-release.mjs group (k)). Ad hoc ("-"), not notarized:
// no text ever calls it signed by the author.

export const MAC_APP_ID = 'com.sanovids.app'
export const MAC_MIN_SYSTEM = '13.0'
/** Exactly these entitlements, both true (build/entitlements.mac.plist; disable-library-validation: ad hoc needs it). */
export const MAC_ENTITLEMENTS = Object.freeze({ 'com.apple.security.cs.allow-jit': true, 'com.apple.security.cs.disable-library-validation': true })
/** What SanoVids.app/Contents may hold (a file there, e.g. a top-level extraFiles entry, breaks codesign). */
export const MAC_CONTENTS = Object.freeze(['Info.plist', 'PkgInfo', 'MacOS', 'Frameworks', 'Resources', '_CodeSignature'])
/** Contents/Resources licence files (package.json build.mac.extraResources; LICENSE.txt clause 6). */
export const MAC_LICENSE_FILES = Object.freeze(['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html'])
/** Files app.asar must hold on every platform: without them the app does not start / update / check signatures. */
export const REQUIRED_ASAR_FILES = Object.freeze([
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/updater.cjs',
  'electron/updater-rules.cjs',
  'electron/signature.cjs',
  'electron/hardening-rules.cjs',
  'electron/keeplogin-rules.cjs',
  // the development-mode lock (DV): without it a release build cannot lock or unlock development mode
  'electron/devaccess.cjs',
  'electron/devaccess-rules.cjs',
  'node_modules/electron-updater/package.json',
])
/**
 * D240: the SANO web app in Sano Agent's app.asar (sano-dist/BUILD.json, written by scripts/build-sano.mjs) against the
 * commit pinned in sano-agent/sano.json. → a Vietnamese problem, or null when they match.
 */
export function checkSanoBuild(build, pin) {
  const commit = (o) => (o && typeof o === 'object' && typeof o.commit === 'string' && /^[0-9a-f]{40}$/.test(o.commit) ? o.commit : null)
  const want = commit(pin)
  const got = commit(build)
  if (!want) return 'sano-agent/sano.json không có commit SANO hợp lệ (40 ký tự hex).'
  if (!got) return 'sano-dist/BUILD.json trong app không có commit SANO: chạy lại npm run dist:sano-agent.'
  if (got !== want) return `SANO trong app build từ commit ${got.slice(0, 7)}, cần ${want.slice(0, 7)} (sano-agent/sano.json): chạy lại npm run dist:sano-agent.`
  return null
}
/** The checks scripts/mac-inspect.mjs records in mac-check.json (every one must be true to publish). */
export const MAC_CHECKS = Object.freeze([
  'codesign',
  'signature',
  'entitlements',
  'infoPlist',
  'asarIntegrity',
  'fuses',
  'noUnpacked',
  'contents',
  'appAsar',
  'appUpdateYml',
  'licenses',
  'arch',
  'dmg',
  'latestMacYml',
])
/** @electron/fuses' marker in Electron Framework (the fuse wire follows it: version byte, length byte, one byte per fuse). */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/
const COMMIT = /^[0-9a-f]{40}$/

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const decodeXml = (t) =>
  t.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]{1,6}|#\d{1,7});/gi, (_, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()]
    const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
    return n <= 0x10ffff ? String.fromCodePoint(n) : ''
  })

/**
 * An XML property list (Info.plist, the entitlements codesign prints) → plain JS: dict → object, array, string, integer
 * / real → number, true / false, date / data → their text. Comments ignored. Throws on anything else (a binary plist,
 * an unknown tag): callers report it as unreadable.
 */
export function parsePlistXml(text) {
  const s = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*<\?xml[^>]*\?>/, '')
    .replace(/^\s*<!DOCTYPE[^>]*>/i, '')
  const m = /^\s*<plist[^>]*>([\s\S]*)<\/plist>\s*$/.exec(s)
  if (!m) throw new Error('plist: not an XML property list')
  const src = m[1]
  let i = 0
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++
  }
  const value = () => {
    ws()
    const open = /^<([a-zA-Z]+)\s*(\/?)>/.exec(src.slice(i, i + 64))
    if (!open) throw new Error(`plist: unexpected content at ${i}`)
    const tag = open[1]
    i += open[0].length
    if (open[2]) {
      const empty = { true: true, false: false, string: '', dict: {}, array: [] }
      if (!(tag in empty)) throw new Error(`plist: unexpected <${tag}/>`)
      return empty[tag]
    }
    if (tag === 'dict') {
      const out = {}
      for (;;) {
        ws()
        if (src.startsWith('</dict>', i)) {
          i += 7
          return out
        }
        const k = /^<key>([\s\S]*?)<\/key>/.exec(src.slice(i))
        if (!k) throw new Error(`plist: a <dict> entry without <key> at ${i}`)
        i += k[0].length
        out[decodeXml(k[1])] = value()
      }
    }
    if (tag === 'array') {
      const out = []
      for (;;) {
        ws()
        if (src.startsWith('</array>', i)) {
          i += 8
          return out
        }
        out.push(value())
      }
    }
    if (!['string', 'integer', 'real', 'date', 'data'].includes(tag)) throw new Error(`plist: unknown <${tag}>`)
    const end = src.indexOf(`</${tag}>`, i)
    if (end < 0) throw new Error(`plist: <${tag}> not closed`)
    const raw = src.slice(i, end)
    i = end + tag.length + 3
    if (raw.includes('<')) throw new Error(`plist: markup inside <${tag}>`)
    if (tag === 'string') return decodeXml(raw)
    if (tag === 'integer') {
      if (!/^\s*-?\d+\s*$/.test(raw)) throw new Error('plist: bad <integer>')
      return Number(raw)
    }
    if (tag === 'real') {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error('plist: bad <real>')
      return n
    }
    return tag === 'data' ? raw.replace(/\s+/g, '') : raw.trim()
  }
  const out = value()
  ws()
  if (i !== src.length) throw new Error('plist: content after the root value')
  return out
}

/** Entitlements of the signed app (parsed) against MAC_ENTITLEMENTS: the same keys and values, nothing else. → problems. */
export function checkMacEntitlements(actual, expected = MAC_ENTITLEMENTS) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return ['Không đọc được entitlements của app.']
  const p = []
  for (const [k, v] of Object.entries(expected)) if (actual[k] !== v) p.push(`Entitlement ${k} là ${JSON.stringify(actual[k] ?? null)}, cần ${JSON.stringify(v)}.`)
  for (const k of Object.keys(actual)) if (!(k in expected)) p.push(`Entitlement lạ ${k}: chỉ được có ${Object.keys(expected).join(' và ')}.`)
  return p
}

/** The fuse wire of an Electron binary (same shape as @electron/fuses getCurrentFuseWire: { version, 0: 48|49, … }) or null. */
export function readFuseWire(buf) {
  if (!buf || typeof buf.indexOf !== 'function') return null
  const at = buf.indexOf(FUSE_SENTINEL)
  if (at < 0) return null
  const pos = at + FUSE_SENTINEL.length
  if (pos + 2 > buf.length) return null
  const len = buf[pos + 1]
  if (pos + 2 + len > buf.length) return null
  const out = { version: String(buf[pos]) }
  for (let i = 0; i < len; i++) out[i] = buf[pos + 2 + i]
  return out
}

/** Architecture of a Mach-O executable: 'arm64' | 'x86_64' | 'universal' | 'other' | null (not Mach-O). */
export function machOArch(buf) {
  if (!buf || buf.length < 8) return null
  if (buf.readUInt32BE(0) === 0xcafebabe || buf.readUInt32BE(0) === 0xcafebabf) return 'universal'
  if (buf.readUInt32LE(0) !== 0xfeedfacf) return null
  const cpu = buf.readUInt32LE(4)
  return cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x86_64' : 'other'
}

/** Hex sha256 of an asar archive's raw JSON header (what Info.plist ElectronAsarIntegrity holds), from a buffer. */
export function asarHeaderSha256Of(buf) {
  const total = asarHeaderBytes(buf)
  if (buf.length < total) throw new Error('asar: header truncated')
  return createHash('sha256').update(buf.subarray(16, total)).digest('hex')
}

/**
 * Contents/Info.plist (parsed) of the Mac app → problems: this app (bundle id, executable), this version, macOS 13+,
 * the build copyright, and the asar integrity entry (checked against the archive by checkMacAsarIntegrity).
 */
export function checkMacInfoPlist(info, { version, appId = MAC_APP_ID, executable = 'SanoVids', copyright = COPYRIGHT_BUILD, minimumSystemVersion = MAC_MIN_SYSTEM } = {}) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return ['Không đọc được Info.plist của app.']
  const p = []
  const want = (key, value) => {
    if (info[key] !== value) p.push(`Info.plist ${key} là ${JSON.stringify(info[key] ?? null)}, cần ${JSON.stringify(value)}.`)
  }
  want('CFBundleIdentifier', appId)
  want('CFBundleExecutable', executable)
  want('CFBundleShortVersionString', version)
  want('LSMinimumSystemVersion', minimumSystemVersion)
  const copy = typeof info.NSHumanReadableCopyright === 'string' ? info.NSHumanReadableCopyright.normalize('NFC') : info.NSHumanReadableCopyright
  if (copy !== copyright) p.push(`Info.plist NSHumanReadableCopyright là ${JSON.stringify(info.NSHumanReadableCopyright ?? null)}, cần "${copyright}".`)
  const integrity = info.ElectronAsarIntegrity
  if (!integrity || typeof integrity !== 'object' || !integrity['Resources/app.asar']) p.push('Info.plist không có ElectronAsarIntegrity cho Resources/app.asar: với fuse kiểm tra toàn vẹn asar đang bật, app sẽ không mở.')
  return p
}

/** Info.plist ElectronAsarIntegrity["Resources/app.asar"] = { algorithm: SHA256, hash: sha256 of the header }. → problems. */
export function checkMacAsarIntegrity(info, headerSha256) {
  const entry = info && typeof info === 'object' && info.ElectronAsarIntegrity && typeof info.ElectronAsarIntegrity === 'object' ? info.ElectronAsarIntegrity['Resources/app.asar'] : null
  if (!entry || typeof entry !== 'object') return ['Info.plist không có ElectronAsarIntegrity cho Resources/app.asar.']
  const p = []
  if (entry.algorithm !== 'SHA256') p.push(`ElectronAsarIntegrity dùng thuật toán "${entry.algorithm}", cần "SHA256".`)
  const want = String(headerSha256 ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(want)) p.push('Không tính được SHA-256 của header app.asar.')
  else if (String(entry.hash ?? '').toLowerCase() !== want) p.push(`Mã SHA-256 trong Info.plist (${String(entry.hash ?? '—').slice(0, 12)}…) khác header app.asar (${want.slice(0, 12)}…): app sẽ không mở.`)
  return p
}

/**
 * latest-mac.yml (parsed) against the zip actually built: the zip only (dmg.writeUpdateInfo is off), this version, its
 * sha512 and size, a releaseDate not older than the release commit, and no minimumSystemVersion (electron-updater
 * compares it with the Darwin KERNEL version, not the macOS one). expected = { version, zipName, sha512, size, notBefore? }.
 */
export function checkLatestMacYml(obj, { version, zipName, sha512, size, notBefore } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['latest-mac.yml không đọc được (không phải YAML hợp lệ).']
  const p = []
  if (String(obj.version) !== version) p.push(`version trong latest-mac.yml là "${obj.version}", cần "${version}".`)
  const files = Array.isArray(obj.files) ? obj.files : null
  if (!files || !files.length) p.push('latest-mac.yml không có danh sách files.')
  else {
    const f = files[0] && typeof files[0] === 'object' ? files[0] : {}
    if (f.url !== zipName) p.push(`files[0].url là "${f.url}", cần "${zipName}" (file zip đứng đầu).`)
    if (f.sha512 !== sha512) p.push('files[0].sha512 không khớp file zip của bản Mac.')
    if (f.size !== size) p.push(`files[0].size là ${f.size}, file zip nặng ${size} byte.`)
    if (files.length !== 1) p.push(`latest-mac.yml liệt kê ${files.length} file, chỉ được có file zip.`)
    if (files.some((x) => x && typeof x === 'object' && 'minimumSystemVersion' in x)) p.push('latest-mac.yml có minimumSystemVersion trong files: bỏ đi (electron-updater so nó với số phiên bản nhân Darwin).')
  }
  if ('path' in obj && obj.path !== zipName) p.push(`path trong latest-mac.yml là "${obj.path}", cần "${zipName}".`)
  if ('sha512' in obj && obj.sha512 !== sha512) p.push('sha512 trong latest-mac.yml không khớp file zip.')
  if ('minimumSystemVersion' in obj) p.push('latest-mac.yml có minimumSystemVersion: bỏ đi (electron-updater so nó với số phiên bản nhân Darwin, không phải macOS).')
  const date = obj.releaseDate instanceof Date ? obj.releaseDate : new Date(String(obj.releaseDate ?? ''))
  if (Number.isNaN(date.getTime())) p.push('latest-mac.yml không có releaseDate hợp lệ.')
  else if (notBefore && date.getTime() < new Date(notBefore).getTime()) {
    p.push(`releaseDate ${date.toISOString()} cũ hơn commit phát hành (${notBefore}): bản Mac được dựng trước commit này.`)
  }
  return p
}

/** The four packaged files mac-check.json lists, in order (latest-mac.yml last). */
export function macBuildFiles(version) {
  const f = releaseFiles(version)
  return [f.macDmg, f.macZip, f.macZipBlockmap, f.macYml]
}

/** Artifact name of a mac-build run (.github/workflows/mac-build.yml upload-artifact). */
export function macArtifactName(version, runNumber) {
  return `sanovids-mac-${version}-${runNumber}`
}

/** files = { [name]: { sha512, size } } → problems for `name` against a listed entry ({ name, sha512, size }). */
function sameFileEntry(entry, local, label) {
  if (!local) return [`Không có ${entry?.name ?? label} trên máy để so.`]
  const p = []
  if (!entry || entry.sha512 !== local.sha512) p.push(`${label}: SHA-512 của ${entry?.name ?? '?'} khác file trên máy.`)
  else if (Number.isFinite(entry.size) && entry.size !== local.size) p.push(`${label}: ${entry.name} nặng ${entry.size} byte theo danh sách, ${local.size} byte trên máy.`)
  return p
}

/**
 * mac-check.json (parsed; written by scripts/mac-inspect.mjs at the end of dist:mac) → problems. expected = { version,
 * commit (the release commit), files ({ [name]: { sha512, size } } of the local copies) }: this version, built from
 * exactly that commit on a clean tree, every check passed, and the four packaged files are these very bytes.
 */
export function checkMacCheck(check, { version, commit, files } = {}) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return ['mac-check.json không đọc được.']
  const p = []
  if (check.v !== 1) p.push(`mac-check.json phiên bản định dạng ${JSON.stringify(check.v ?? null)}, cần 1.`)
  if (check.version !== version) p.push(`mac-check.json là của bản ${JSON.stringify(check.version ?? null)}, cần ${version}.`)
  if (typeof check.commit !== 'string' || !COMMIT.test(check.commit)) p.push('mac-check.json không ghi commit đã dựng.')
  else if (commit && check.commit !== commit) p.push(`Bản Mac dựng từ commit ${check.commit.slice(0, 7)}, không phải commit phát hành ${String(commit).slice(0, 7)}.`)
  if (check.dirty !== false) p.push(`Bản Mac dựng từ cây làm việc ${check.dirty === true ? 'còn thay đổi chưa commit' : 'không rõ sạch hay không'} (dirty: ${JSON.stringify(check.dirty ?? null)}).`)
  if (check.source !== 'ci' && check.source !== 'local') p.push(`mac-check.json có source ${JSON.stringify(check.source ?? null)} (cần "ci" hoặc "local").`)
  if (check.source === 'ci') {
    const ci = check.ci && typeof check.ci === 'object' ? check.ci : null
    if (!ci || !Number.isSafeInteger(ci.runId) || ci.runId <= 0) p.push('mac-check.json (CI) không ghi lần chạy (runId).')
  }
  const checks = check.checks && typeof check.checks === 'object' ? check.checks : {}
  const failed = MAC_CHECKS.filter((k) => checks[k] !== true)
  if (failed.length) p.push(`mac-inspect chưa đạt: ${failed.join(', ')}.`)
  if (Array.isArray(check.problems) && check.problems.length) p.push(`mac-inspect báo lỗi: ${check.problems.slice(0, 3).join(' · ')}`)
  const names = macBuildFiles(version)
  const listed = Array.isArray(check.files) ? check.files : []
  if (listed.length !== names.length || listed.some((f, i) => !f || f.name !== names[i])) p.push(`mac-check.json phải liệt kê đúng ${names.join(', ')}.`)
  else if (files) for (const [i, name] of names.entries()) p.push(...sameFileEntry(listed[i], files[name], 'mac-check.json'))
  return p
}

/**
 * mac-fetch.json (parsed; written by scripts/fetch-mac-build.mjs) → problems: the files came from a successful RC run
 * (workflow_dispatch, rc, main) of exactly the release commit, the run mac-check.json names, and every fetched file
 * still has the recorded SHA-512. expected = { version, commit, check (mac-check.json), files ({ [name]: { sha512, size } }
 * of the five local files: the four of macBuildFiles + mac-check.json) }.
 */
export function checkMacFetch(fetch, { version, commit, check, files } = {}) {
  if (!fetch || typeof fetch !== 'object' || Array.isArray(fetch)) return ['Thiếu mac-fetch.json: bản Mac từ GitHub Actions phải được tải về bằng npm run mac:fetch -- --run <số lần chạy>.']
  const p = []
  if (fetch.v !== 1) p.push(`mac-fetch.json phiên bản định dạng ${JSON.stringify(fetch.v ?? null)}, cần 1.`)
  if (fetch.event !== 'workflow_dispatch' || fetch.rc !== true) p.push('Lần chạy này không phải bản RC (workflow_dispatch, rc = true): không bao giờ đăng bản dựng thử.')
  if (fetch.headBranch !== 'main') p.push(`Lần chạy dựng trên nhánh ${JSON.stringify(fetch.headBranch ?? null)}, không phải main.`)
  if (fetch.conclusion !== 'success') p.push('Lần chạy chưa thành công.')
  if (typeof fetch.headSha !== 'string' || (commit && fetch.headSha !== commit)) p.push(`Lần chạy dựng commit ${String(fetch.headSha ?? '—').slice(0, 7)}, không phải commit phát hành ${String(commit ?? '—').slice(0, 7)}.`)
  const runId = check && check.ci && typeof check.ci === 'object' ? check.ci.runId : undefined
  if (!Number.isSafeInteger(fetch.runId) || fetch.runId !== runId) p.push(`mac-fetch.json (lần chạy ${fetch.runId ?? '—'}) và mac-check.json (lần chạy ${runId ?? '—'}) không cùng một lần chạy.`)
  const runAttempt = check && check.ci && typeof check.ci === 'object' ? check.ci.runAttempt : undefined
  if (!Number.isSafeInteger(fetch.runAttempt) || fetch.runAttempt !== runAttempt) p.push(`mac-fetch.json (lần thử ${fetch.runAttempt ?? '—'}) và mac-check.json (lần thử ${runAttempt ?? '—'}) không cùng một lần thử.`)
  const names = [...macBuildFiles(version), releaseFiles(version).macCheck]
  const listed = Array.isArray(fetch.files) ? fetch.files : []
  if (listed.length !== names.length || listed.some((f, i) => !f || f.name !== names[i])) p.push(`mac-fetch.json phải liệt kê đúng ${names.join(', ')}.`)
  else if (files) for (const [i, name] of names.entries()) p.push(...sameFileEntry(listed[i], files[name], 'mac-fetch.json'))
  return p
}

/**
 * One run of `gh run list --workflow mac-build.yml --json …` → problems for publishing it: the requested run number,
 * finished and successful, started by hand (workflow_dispatch) as an RC (run-name "mac-build RC …"), on main, at
 * `headSha` (the tag's commit when the tag exists, else local main), and — when `attempt` is given — still at the attempt
 * you tested (a re-run keeps id, number and commit; gh downloads the latest attempt's artifact).
 */
export function checkMacRun(run, { runNumber, headSha, attempt } = {}) {
  if (!run || typeof run !== 'object') return [`Không thấy lần chạy mac-build #${runNumber}.`]
  const p = []
  if (run.number !== runNumber) p.push(`Lần chạy là #${run.number}, cần #${runNumber}.`)
  if (run.workflowName !== undefined && run.workflowName !== 'mac-build') p.push(`Lần chạy thuộc workflow "${run.workflowName}", cần "mac-build".`)
  if (run.event !== 'workflow_dispatch') p.push(`Lần chạy #${runNumber} do "${run.event}" khởi động, không phải chạy tay (workflow_dispatch): bản dựng thử không bao giờ được đăng.`)
  if (typeof run.displayTitle !== 'string' || !run.displayTitle.startsWith('mac-build RC ')) p.push(`Lần chạy #${runNumber} không phải bản RC (rc = true).`)
  if (run.status !== 'completed' || run.conclusion !== 'success') p.push(`Lần chạy #${runNumber} chưa xong hoặc không thành công (${run.status ?? '?'} / ${run.conclusion ?? '?'}).`)
  if (run.headBranch !== 'main') p.push(`Lần chạy #${runNumber} dựng trên nhánh "${run.headBranch}", không phải main.`)
  if (!COMMIT.test(String(headSha ?? ''))) p.push('Không biết commit cần đối chiếu (tag hoặc main trên máy).')
  else if (run.headSha !== headSha) p.push(`Lần chạy #${runNumber} dựng commit ${String(run.headSha ?? '—').slice(0, 7)}, khác ${String(headSha).slice(0, 7)} (tag / main trên máy: chạy git pull trên main).`)
  if (attempt !== undefined && run.attempt !== attempt) {
    p.push(`Lần chạy #${runNumber} đang ở lần thử ${run.attempt ?? '—'}, không phải lần thử ${attempt} bạn đã thử: thử bản của lần thử mới nhất rồi chạy npm run mac:fetch -- --run ${runNumber} --attempt ${run.attempt ?? '<n>'}.`)
  }
  return p
}

/**
 * Release without a Mac build: { level, text } | null. `hasMac` = release/mac holds the build, `partial` = only some of
 * its files, `newestPublicHasMac` = the newest public release has latest-mac.yml (Macs read it), `windowsOnly` = the
 * owner passed --khong-mac (an urgent Windows-only release).
 */
export function macReleaseRule({ hasMac, partial, newestPublicHasMac, windowsOnly }) {
  if (partial) return { level: 'fail', text: 'release/mac chỉ có một phần bản Mac: tải lại đủ bằng npm run mac:fetch -- --run <số lần chạy>, hoặc xoá hết để đăng bản chỉ có Windows.' }
  if (hasMac) return null
  if (newestPublicHasMac && !windowsOnly) {
    return { level: 'fail', text: 'Bản công khai mới nhất có bản Mac mà bản này không có (release/mac trống). Tải bản Mac đã thử về (npm run mac:fetch), hoặc chạy lại với --khong-mac nếu cố ý chỉ đăng Windows.' }
  }
  return { level: 'warn', text: 'Bản này chỉ có Windows — máy Mac không thấy bản mới (app Mac báo "chưa có bản cho Mac mới hơn").' }
}

/**
 * Independent look inside the Mac zip (jszip on Windows; the .dmg cannot be read there): layout of SanoVids.app,
 * Info.plist, app.asar (required files, the release's package.json, the asar integrity hash), the fuse wire of
 * Electron Framework, an arm64 executable, the feed (app-update.yml), the licence files byte-identical to the repo's,
 * the framework symlinks kept (zip -y). deps = { loadZip (JSZip.loadAsync), parseYaml, version, repoPkg, licenses
 * ({ [name]: Buffer } of MAC_LICENSE_FILES), productName }. → { problems, info }. Never throws.
 */
export async function inspectMacZip(buf, { loadZip, parseYaml, version, repoPkg, licenses = {}, productName = 'SanoVids' } = {}) {
  const problems = []
  const info = {}
  let zip
  try {
    zip = await loadZip(buf)
  } catch (e) {
    return { problems: [`Không đọc được file zip của bản Mac (${e?.message ?? e}).`], info }
  }
  const app = `${productName}.app/`
  const contentsDir = `${app}Contents/`
  const names = Object.keys(zip.files)
  const outside = names.filter((n) => !n.startsWith(app))
  if (outside.length) problems.push(`zip có file ngoài ${app}: ${outside.slice(0, 3).join(', ')}.`)
  const top = new Set(names.filter((n) => n.startsWith(contentsDir)).map((n) => n.slice(contentsDir.length).split('/')[0]).filter(Boolean))
  const extra = [...top].filter((c) => !MAC_CONTENTS.includes(c))
  if (extra.length) problems.push(`${productName}.app/Contents có mục lạ: ${extra.join(', ')} (chỉ được có ${MAC_CONTENTS.join(', ')}).`)
  for (const need of ['Info.plist', 'MacOS', 'Frameworks', 'Resources', '_CodeSignature']) if (!top.has(need)) problems.push(`${productName}.app/Contents thiếu ${need}.`)
  if (names.some((n) => n.startsWith(`${contentsDir}Resources/app.asar.unpacked`))) problems.push('Có Resources/app.asar.unpacked: mọi file phải nằm trong app.asar (được kiểm tra toàn vẹn).')
  const entry = (rel) => zip.file(contentsDir + rel)
  const read = async (rel) => {
    const e = entry(rel)
    return e ? Buffer.from(await e.async('nodebuffer')) : null
  }
  const isLink = (rel) => {
    const e = zip.files[contentsDir + rel]
    return !!e && typeof e.unixPermissions === 'number' && (e.unixPermissions & 0o170000) === 0o120000
  }
  try {
    // Info.plist
    let plist = null
    const plistBuf = await read('Info.plist')
    if (!plistBuf) problems.push('Thiếu Contents/Info.plist.')
    else {
      try {
        plist = parsePlistXml(plistBuf.toString('utf8'))
      } catch (e) {
        problems.push(`Không đọc được Info.plist (${e?.message ?? e}).`)
      }
      if (plist) problems.push(...checkMacInfoPlist(plist, { version, executable: productName }))
    }
    info.bundleId = plist?.CFBundleIdentifier
    // app.asar
    const asar = await read('Resources/app.asar')
    if (!asar) problems.push('Thiếu Contents/Resources/app.asar.')
    else {
      const header = readAsarHeader(asar)
      for (const f of REQUIRED_ASAR_FILES) if (!asarHas(header, f)) problems.push(`app.asar thiếu ${f}.`)
      const pkgEntry = asarEntry(header, 'package.json')
      if (!pkgEntry || pkgEntry.unpacked || typeof pkgEntry.size !== 'number') problems.push('Không đọc được package.json trong app.asar.')
      else {
        const start = asarDataOffset(asar) + Number(pkgEntry.offset)
        let inner = null
        try {
          inner = JSON.parse(asar.toString('utf8', start, start + pkgEntry.size))
        } catch {
          inner = null
        }
        const bad = checkPackagedIdentity(inner, repoPkg)
        if (bad.length) problems.push(`package.json trong app không phải bản phát hành ${version}: ${bad.join('; ')}.`)
      }
      const sha = asarHeaderSha256Of(asar)
      info.asarHeaderSha256 = sha
      if (plist) problems.push(...checkMacAsarIntegrity(plist, sha))
    }
    // fuses (the real binary; "Electron Framework.framework/Electron Framework" is a symlink to it)
    const framework = 'Frameworks/Electron Framework.framework/'
    const fw = await read(`${framework}Versions/A/Electron Framework`)
    if (!fw) problems.push('Thiếu Electron Framework (Versions/A).')
    else problems.push(...checkFuseWire(readFuseWire(fw)).map((t) => `Electron Framework: ${t}`))
    for (const link of [`${framework}Electron Framework`, `${framework}Versions/Current`]) {
      if (!isLink(link)) problems.push(`${link} không còn là symlink (zip không được nén bằng zip -y: chữ ký của app sẽ hỏng).`)
    }
    // the executable
    const exe = await read(`MacOS/${productName}`)
    const arch = exe ? machOArch(exe) : null
    info.arch = arch
    if (arch !== 'arm64') problems.push(`File chạy MacOS/${productName} là ${arch ?? 'không đọc được'}, cần arm64.`)
    // feed
    const yml = await read('Resources/app-update.yml')
    if (!yml) problems.push('Thiếu Contents/Resources/app-update.yml (app không kiểm tra được bản mới).')
    else {
      let feed = null
      try {
        feed = parseYaml(yml.toString('utf8'))
      } catch {
        feed = null
      }
      problems.push(...checkAppUpdateYml(feed, { platform: 'mac' }))
    }
    // licences
    for (const name of MAC_LICENSE_FILES) {
      const shipped = await read(`Resources/${name}`)
      const source = licenses[name]
      if (!shipped) problems.push(`Thiếu Contents/Resources/${name}.`)
      else if (source && !shipped.equals(source)) problems.push(`Contents/Resources/${name} khác bản trong repo.`)
    }
  } catch (e) {
    problems.push(`Không đọc hết được nội dung zip (${e?.message ?? e}).`)
  }
  return { problems, info }
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
 * With `signer` (SIGNER_THUMBPRINT), it must be signed by exactly that pinned certificate: during a rotation the pins
 * hold two thumbprints, and the gate still knows which one signs this release (checkRotation needs that).
 * `timestamp: false` skips the timestamp requirement (the caller warns instead). → problem strings ([] = fine).
 */
export function checkSignatureVerdict(label, verdict, { signer = null, timestamp = true } = {}) {
  if (!verdict || typeof verdict !== 'object') return [`${label}: không có kết quả kiểm tra chữ ký số.`]
  const thumb = typeof verdict.thumbprint === 'string' ? verdict.thumbprint : ''
  const who = verdict.signer ? `"${verdict.signer}"` : 'người khác'
  if (verdict.ok === true && verdict.status === 'signed') {
    const p = []
    const want = typeof signer === 'string' ? signer.replace(/\s+/g, '').toUpperCase() : ''
    if (want && thumb.toUpperCase() !== want) {
      p.push(`${label} được ký bằng chứng chỉ ${thumb || '—'}, không phải chứng chỉ ký của bản này (${want} = SIGNER_THUMBPRINT trong scripts/releaseLib.mjs).`)
    }
    if (timestamp && verdict.timestamped !== true) {
      p.push(`${label} đã ký số nhưng thiếu dấu thời gian (timestamp): chữ ký sẽ hết hiệu lực khi chứng chỉ hết hạn. Build lại khi máy chủ timestamp chạy được.`)
    }
    return p
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

const pinList = (raw) =>
  [...new Set((Array.isArray(raw) ? raw : []).map((x) => String(x).replace(/\s+/g, '').toUpperCase()).filter((x) => THUMBPRINT.test(x)))]

/**
 * "Ghim trước, ký sau" (docs/SIGNING.md §7): an installed app only accepts an update signed by a thumbprint IT pins,
 * so the certificate that signs this release must already be in sanovids.signers of the newest PUBLIC release before
 * it. prevVersion = that version (newestPublishedVersion(public releases, V); null = nothing published yet);
 * prevPkg = its package.json (`git show v<prev>:package.json`), null when unreadable; signer = SIGNER_THUMBPRINT;
 * tagPrefix = the product's source tag prefix (sourceTagPrefix: 'v', 'sano-agent-v'), as the texts name the tag.
 * → { level: 'ok' | 'fail', text }.
 */
export function checkRotation({ prevVersion, prevPkg, signer, tagPrefix = 'v' }) {
  const prevTag = `${tagPrefix}${prevVersion}`
  const want = String(signer ?? '').replace(/\s+/g, '').toUpperCase()
  if (!THUMBPRINT.test(want)) return { level: 'fail', text: 'Không biết chứng chỉ ký của bản này (SIGNER_THUMBPRINT trong scripts/releaseLib.mjs).' }
  if (!prevVersion) return { level: 'ok', text: 'Chưa có bản công khai nào trước bản này: không máy nào cần nhận chữ ký mới.' }
  if (!prevPkg || typeof prevPkg !== 'object' || Array.isArray(prevPkg)) {
    return {
      level: 'fail',
      text: `Không đọc được package.json của ${prevTag} (git show ${prevTag}:package.json; chạy git fetch origin --tags): không kiểm tra được quy tắc "ghim trước, ký sau".`,
    }
  }
  const raw = prevPkg.sanovids && typeof prevPkg.sanovids === 'object' ? prevPkg.sanovids.signers : undefined
  if (raw == null && compareVersions(prevVersion, '0.5.0') < 0) {
    return { level: 'ok', text: `${prevTag} có trước 0.5.0 (chưa tự cập nhật, chưa ghim chữ ký): người dùng cài tay bản này.` }
  }
  const prev = pinList(raw)
  if (prev.includes(want)) {
    return { level: 'ok', text: `Chứng chỉ ký ${want.slice(0, 8)}… đã được ghim trong ${prevTag} (bản công khai mới nhất): máy đang dùng bản đó nhận được bản này.` }
  }
  return {
    level: 'fail',
    text:
      `Bản này ký bằng chứng chỉ ${want}, nhưng ${prevTag} (bản công khai mới nhất) chỉ ghim ${prev.length ? prev.join(', ') : 'không chứng chỉ nào'}: ` +
      `mọi máy đang dùng ${prevTag} sẽ TỪ CHỐI bản cập nhật này. Quy tắc "ghim trước, ký sau" (docs/SIGNING.md mục 7): ` +
      'phát hành trước một bản vẫn ký bằng chứng chỉ cũ, có thêm chứng chỉ mới trong sanovids.signers, rồi mới đổi chứng chỉ ký.',
  }
}

/**
 * Electron's embedded asar integrity on Windows (fuse EnableEmbeddedAsarIntegrityValidation): the exe's resource
 * INTEGRITY / ELECTRONASAR (JSON written by electron-builder) must list exactly resources\app.asar, SHA256, and the
 * sha256 of the archive's raw JSON header. Missing or stale → the app exits at EVERY start on every machine, and an
 * auto-update cannot repair it. resourceTexts = every such resource as text; headerSha256 = hex. → problem strings.
 */
export function checkAsarIntegrity(resourceTexts, headerSha256) {
  const texts = Array.isArray(resourceTexts) ? resourceTexts : []
  const never = 'app sẽ không mở trên mọi máy'
  if (!texts.length) return [`File exe không có tài nguyên INTEGRITY/ELECTRONASAR: với fuse kiểm tra toàn vẹn asar đang bật, ${never}.`]
  if (texts.length > 1) return [`File exe có ${texts.length} tài nguyên INTEGRITY/ELECTRONASAR (cần đúng 1).`]
  let list = null
  try {
    list = JSON.parse(String(texts[0]))
  } catch {
    list = null
  }
  if (!Array.isArray(list) || list.length !== 1 || !list[0] || typeof list[0] !== 'object') {
    return [`Tài nguyên INTEGRITY/ELECTRONASAR không đúng dạng (cần đúng một mục cho resources\\app.asar): ${never}.`]
  }
  const item = list[0]
  const p = []
  if (String(item.file ?? '').toLowerCase() !== 'resources\\app.asar') p.push(`Tài nguyên INTEGRITY trỏ vào "${item.file}", cần "resources\\app.asar".`)
  if (item.alg !== 'SHA256') p.push(`Tài nguyên INTEGRITY dùng thuật toán "${item.alg}", cần "SHA256".`)
  const want = String(headerSha256 ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(want)) p.push('Không tính được SHA-256 của header app.asar.')
  else if (String(item.value ?? '').toLowerCase() !== want) {
    p.push(`Mã SHA-256 trong file exe (${String(item.value ?? '—').slice(0, 12)}…) khác header app.asar (${want.slice(0, 12)}…): ${never}.`)
  }
  return p
}

/**
 * win-unpacked must be what the installers carry: electron-builder writes win-unpacked first and the Setup / Portable
 * after it, so a file of win-unpacked newer than an installer means a later rebuild (e.g. `--dir` with another config)
 * replaced what the gate is about to check. unpacked / installers = [{ label, mtimeMs }]. → problem strings.
 */
export function checkBuildFreshness({ unpacked, installers }) {
  const p = []
  for (const u of Array.isArray(unpacked) ? unpacked : []) {
    for (const i of Array.isArray(installers) ? installers : []) {
      if (!Number.isFinite(u?.mtimeMs) || !Number.isFinite(i?.mtimeMs)) continue
      if (u.mtimeMs > i.mtimeMs) {
        p.push(`${u.label} trong win-unpacked mới hơn ${i.label}: thư mục win-unpacked không phải nội dung của bộ cài sẽ đăng. Build lại bằng npm run dist:win.`)
      }
    }
  }
  return p
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
  // The owner's unlock keys of development mode: exactly the repo's (a test build's extraMetadata keys are UNIONED in),
  // and never the test-build lock switch.
  const wantKeys = repo.sanovids && typeof repo.sanovids === 'object' ? repo.sanovids.devUnlockKeys : undefined
  const gotKeys = inner.sanovids && typeof inner.sanovids === 'object' ? inner.sanovids.devUnlockKeys : undefined
  if (JSON.stringify(gotKeys ?? null) !== JSON.stringify(wantKeys ?? null)) {
    bad.push(`sanovids.devUnlockKeys ${JSON.stringify(gotKeys ?? null)} (cần ${JSON.stringify(wantKeys ?? null)}: bản build thử nghiệm có thêm khoá mở khoá?)`)
  }
  const wantService = repo.sanovids && typeof repo.sanovids === 'object' ? repo.sanovids.devUnlockService : undefined
  const gotService = inner.sanovids && typeof inner.sanovids === 'object' ? inner.sanovids.devUnlockService : undefined
  if (gotService !== wantService) bad.push(`sanovids.devUnlockService ${JSON.stringify(gotService ?? null)} (cần ${JSON.stringify(wantService ?? null)})`)
  if ('sanovidsTestDevLock' in inner) bad.push('có sanovidsTestDevLock (bản build thử nghiệm!)')
  // SANO desktop: only Sano Agent bakes a SANO address (effectivePackage), exactly its own; SanoVids never one.
  if (JSON.stringify(inner.sanoAgent ?? null) !== JSON.stringify(repo.sanoAgent ?? null)) {
    bad.push(`sanoAgent ${JSON.stringify(inner.sanoAgent ?? null)} (cần ${JSON.stringify(repo.sanoAgent ?? null)})`)
  }
  return bad
}

/**
 * Release gate of the development-mode lock: the repo's package.json must pin the OWNER's unlock key(s) —
 * sanovids.devUnlockKeys, strict { kid 1–15, alg 'ed25519', key = 32-byte base64url }, no duplicate kid, never a
 * published test key (RFC 8032). Without one, a release build could never be unlocked (development mode lost for the
 * owner too): the owner runs scripts\owner\Tao khoa mo khoa.bat and sends the pin line. → Vietnamese problems ([] = ok).
 */
export function checkDevUnlockPins(repoPkg) {
  const sv = repoPkg && typeof repoPkg === 'object' && repoPkg.sanovids && typeof repoPkg.sanovids === 'object' ? repoPkg.sanovids : {}
  const raw = sv.devUnlockKeys
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    return ['Chưa ghim khoá mở khoá — chủ ứng dụng chạy scripts\\owner\\Tao khoa mo khoa.bat rồi gửi dòng ghim và mã kiểm tra (package.json sanovids.devUnlockKeys).']
  }
  const out = devAccessRules.pinProblems(raw)
  const extra = Object.keys(sv).filter((k) => !['signers', 'devUnlockKeys', 'devUnlockService'].includes(k))
  if (extra.length) out.push(`package.json sanovids có trường lạ: ${extra.join(', ')}.`)
  if (repoPkg && 'sanovidsTestDevLock' in repoPkg) out.push('package.json có sanovidsTestDevLock (chỉ dành cho bản build thử nghiệm).')
  return out
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

/**
 * The Setup as installed apps judge an update (electron/updater-rules.cjs installerIdentityProblem): its VersionInfo
 * ProductName is the app's productName, ProductVersion is exactly this release's version, and it is at least `minBytes`.
 * Otherwise every installed app downloads it and refuses it. → problem strings.
 */
export function checkInstallerIdentity(label, info, { productName, version, size, minBytes } = {}) {
  if (!info || typeof info !== 'object') return [`${label}: không đọc được thông tin file (VersionInfo).`]
  const p = []
  const refused = 'mọi app đã cài sẽ từ chối bản cập nhật này'
  if (info.productName !== productName) p.push(`${label}: ProductName là ${JSON.stringify(info.productName ?? null)}, cần "${productName}" (${refused}).`)
  if (info.productVersion !== version) p.push(`${label}: ProductVersion là ${JSON.stringify(info.productVersion ?? null)}, cần "${version}" (${refused}).`)
  if (!(typeof size === 'number' && Number.isFinite(size) && size >= minBytes)) {
    p.push(`${label}: chỉ ${typeof size === 'number' && size >= 0 ? size : '?'} byte, nhỏ hơn ${minBytes} byte của một bộ cài (${refused}).`)
  }
  return p
}

/** Electron's version in a package-lock.json text (lockfile v2/v3), or null. */
export function lockElectronVersion(text) {
  try {
    const v = JSON.parse(String(text)).packages?.['node_modules/electron']?.version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/**
 * Sano Agent opens SanoVids' data folder (D223): it ships the Electron of the newest public SanoVids, or one app's
 * Chromium would open a profile the other one has already migrated. ours / theirs = lockElectronVersion of this
 * checkout / of `git show v<sanovidsVersion>:package-lock.json`. → { level: 'ok' | 'fail', text }.
 */
export function checkSameElectron({ ours, theirs, sanovidsVersion }) {
  if (!sanovidsVersion) return { level: 'fail', text: 'Không biết bản SanoVids công khai mới nhất: không so được Electron (hai app dùng chung thư mục dữ liệu).' }
  if (!ours || !theirs) {
    return { level: 'fail', text: `Không đọc được Electron trong package-lock.json (của bản này hoặc của tag v${sanovidsVersion}; chạy git fetch origin --tags).` }
  }
  if (ours !== theirs) {
    return {
      level: 'fail',
      text: `Electron ${ours} khác Electron ${theirs} của SanoVids ${sanovidsVersion} (bản công khai mới nhất): hai app dùng chung thư mục dữ liệu, phát hành cả hai trên cùng một Electron.`,
    }
  }
  return { level: 'ok', text: `Cùng Electron ${ours} với SanoVids ${sanovidsVersion} (bản công khai mới nhất)` }
}

/**
 * Sano Agent is built from the commit of the newest public SanoVids (docs/SANO-DESKTOP.md §5): the same renderer code
 * and Electron open the shared data folder. head = HEAD; theirs = the commit of tag v<sanovidsVersion> (null when
 * unreadable). next = { version, local, remote }: SanoVids' tag v<Sano Agent's version> here and on GitHub. At HEAD
 * in both and not older than the newest public SanoVids, it passes: Sano Agent goes first and that SanoVids follows
 * (D236: SanoVids' final notice links to Sano Agent's download page). → { level: 'ok' | 'fail', text }.
 */
export function checkSameCommit({ head, theirs, sanovidsVersion, next = null }) {
  if (head && next && next.local === head && next.remote === head && compareVersions(next.version, sanovidsVersion) >= 0) {
    return { level: 'ok', text: `Tag v${next.version} của SanoVids trỏ vào HEAD ${head.slice(0, 7)} (cả trên GitHub): đăng Sano Agent trước, SanoVids ${next.version} sau (SANO-DESKTOP.md mục 6 bước 10)` }
  }
  if (!head || !theirs) return { level: 'fail', text: `Không đọc được commit của tag v${sanovidsVersion} hoặc HEAD (chạy git fetch origin --tags).` }
  if (head !== theirs) {
    return {
      level: 'fail',
      text: `SanoVids ${sanovidsVersion} (bản công khai mới nhất) build từ ${theirs.slice(0, 7)}, không phải HEAD ${head.slice(0, 7)}: ${next ? `đặt tag v${next.version} của SanoVids trên HEAD và push (đăng Sano Agent trước, SanoVids sau), hoặc ` : ''}phát hành SanoVids từ commit này trước (hai app dùng chung thư mục dữ liệu).`,
    }
  }
  return { level: 'ok', text: `Cùng commit ${head.slice(0, 7)} với SanoVids ${sanovidsVersion} (bản công khai mới nhất)` }
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
 *   published, missing    → repair: upload (missing), then edit-notes when `notes` (the notes this run would write) is
 *                           given and differs from the published body (e.g. the Mac row of files added now), verify
 *   published, mismatched → stop (never overwrite a published file: users may be downloading it)
 */
export function planTarget({ repo, tag, releases, expected, notes }) {
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
  if (compare.missing.length) {
    const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim()
    const notesDiffer = typeof notes === 'string' && norm(notes) !== norm(rel.body)
    return { action: 'repair', steps: notesDiffer ? ['upload', 'edit-notes', 'verify'] : ['upload', 'verify'], upload: compare.missing, clobber: [], compare }
  }
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

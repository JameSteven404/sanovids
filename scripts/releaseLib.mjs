// Pure helpers of the release tooling (scripts/update-notes.mjs, scripts/publish-release.mjs).
// No I/O here: every function takes text / buffers / plain objects and returns plain data, so
// scripts/__tests__/releaseLib.test.mjs covers all of it. User-facing strings are Vietnamese (the owner reads them).
//
// Two GitHub repos:
//   PRIVATE_REPO  JameSteven404/sanovids           source code + installers (history for the owner)
//   PUBLIC_REPO   JameSteven404/sanovids-releases  installers + latest.yml + blockmap: the auto-update feed the app
//                                                  reads anonymously (package.json build.publish → app-update.yml)

export const OWNER = 'JameSteven404'
export const PRIVATE_REPO = `${OWNER}/sanovids`
export const PUBLIC_REPO_NAME = 'sanovids-releases'
export const PUBLIC_REPO = `${OWNER}/${PUBLIC_REPO_NAME}`
export const PUBLIC_RELEASES_URL = `https://github.com/${PUBLIC_REPO}/releases/latest`
/** The one and only package.json build.publish entry (no token, no private flag: the app reads a public repo). */
export const PUBLISH_ENTRY = Object.freeze({ provider: 'github', owner: OWNER, repo: PUBLIC_REPO_NAME, releaseType: 'release' })
/** The app keeps at most 8000 chars of notes (updateTypes UPDATE_NOTES_MAX); stay a little under it. */
export const NOTES_CAP = 7900

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

/** Assets of one GitHub release. Private: the two installers. Public: + latest.yml and the Setup blockmap (the feed). */
export function assetsFor(audience, version) {
  const f = releaseFiles(version)
  if (audience === 'private') return [f.setup, f.portable]
  if (audience === 'public') return [f.setup, f.blockmap, f.latestYml, f.portable]
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
const NOTES_FOOTER = {
  private: `Cài đè lên bản cũ được, dự án và cài đặt giữ nguyên. Lịch sử đầy đủ: [CHANGELOG.md](https://github.com/${PRIVATE_REPO}/blob/main/CHANGELOG.md).`,
  public: 'Cài đè lên bản cũ được, dự án và cài đặt giữ nguyên. `latest.yml` và `.blockmap` là file dùng cho việc tự cập nhật — không cần tải.',
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

/** resources/app-update.yml (parsed) of the packaged app: must point at the public feed, anonymously. */
export function checkAppUpdateYml(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['app-update.yml không đọc được.']
  const p = []
  if (obj.provider !== 'github') p.push(`provider là "${obj.provider}", cần "github".`)
  if (obj.owner !== OWNER) p.push(`owner là "${obj.owner}", cần "${OWNER}".`)
  if (obj.repo !== PUBLIC_REPO_NAME) p.push(`repo là "${obj.repo}", cần "${PUBLIC_REPO_NAME}" (repo công khai chứa bản cập nhật).`)
  if ('token' in obj) p.push('app-update.yml có token — không bao giờ được đưa token vào app.')
  if ('private' in obj) p.push('app-update.yml có "private" — app phải đọc repo công khai, không cần đăng nhập.')
  if ('publisherName' in obj) p.push('app-update.yml có publisherName — bản chưa ký số sẽ bị từ chối cập nhật.')
  if ('channel' in obj) p.push('app-update.yml có channel — app sẽ tìm sai file cập nhật.')
  return p
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

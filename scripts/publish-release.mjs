// Publishes the build in release/ as GitHub releases, in two repos:
//   1. private JameSteven404/sanovids           source repo: both installers (the tag vX.Y.Z must already be pushed)
//   2. public  JameSteven404/sanovids-releases  the auto-update feed: Setup, Setup blockmap, latest.yml, Portable
// Usage:
//   npm run release:check    (= --dry-run)  read-only: every check, both release notes, the exact plan (gh argv)
//   npm run release:publish                 checks, then draft → upload → verify → publish (private first, public LAST)
// Idempotent: run it again after any failure. It never deletes a release or an asset, never overwrites a published
// file and only uses --clobber on drafts. Pure logic lives in scripts/releaseLib.mjs (tested); git / gh run through
// spawnSync with an args array (no shell). See docs/UPDATES.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import {
  PRIVATE_REPO,
  PUBLIC_REPO,
  PUBLISH_ENTRY,
  asarDataOffset,
  asarEntry,
  asarHas,
  asarHeaderBytes,
  assetsFor,
  buildReleaseNotes,
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
  releaseFiles,
  releaseTitle,
} from './releaseLib.mjs'

const DRY = process.argv.includes('--dry-run')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(root, 'release')
const buildDir = path.join(releaseDir, '_build')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const V = String(pkg.version)
const TAG = `v${V}`
const FILES = releaseFiles(V)
const rel = (p) => path.relative(root, p)
const exists = (p) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
const short = (sha) => (sha ? String(sha).slice(0, 7) : '—')
const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

// ───────────────────────────── checklist ─────────────────────────────

const results = []
const ok = (group, text) => results.push({ level: 'ok', group, text })
const warn = (group, text) => results.push({ level: 'warn', group, text })
const fail = (group, text) => results.push({ level: 'fail', group, text })

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...opts })
  // stdout keeps its leading spaces: `git status --porcelain` lines start with them.
  return { code: r.error ? -1 : (r.status ?? -1), out: String(r.stdout ?? '').trimEnd(), err: String(r.stderr ?? r.error?.message ?? '').trim() }
}
const git = (args) => run('git', args)
const gh = (args) => run('gh', args)

async function hashFile(file) {
  const h256 = createHash('sha256')
  const h512 = createHash('sha512')
  let size = 0
  for await (const chunk of fs.createReadStream(file)) {
    h256.update(chunk)
    h512.update(chunk)
    size += chunk.length
  }
  return { sha256: h256.digest('hex'), sha512: h512.digest('base64'), size }
}

function readReleases(repo) {
  const r = gh(ghListReleasesArgs(repo))
  if (r.code !== 0) return null
  try {
    const list = JSON.parse(r.out)
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

function sameJson(a, b) {
  const norm = (o) => JSON.stringify(Object.keys(o ?? {}).sort().reduce((acc, k) => ({ ...acc, [k]: o[k] }), {}))
  return norm(a) === norm(b)
}

// ───────────────────────────── (a) CHANGELOG ─────────────────────────────

let changelog = ''
try {
  changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
} catch {
  changelog = ''
}
const section = extractChangelogSection(changelog, V)
if (section && section.body) ok('Ghi chú', `CHANGELOG.md có mục [${V}] — ${section.date}${section.subtitle ? ` — ${section.subtitle}` : ''}`)
else fail('Ghi chú', `CHANGELOG.md chưa có mục "## [${V}] — yyyy-mm-dd — tiêu đề" (ghi chú phát hành lấy từ đây).`)
if (new RegExp(`^\\[${V.replace(/\./g, '\\.')}\\]:\\s*\\S+`, 'm').test(changelog)) ok('Ghi chú', `CHANGELOG.md có dòng liên kết [${V}]`)
else warn('Ghi chú', `CHANGELOG.md thiếu dòng liên kết cuối file: [${V}]: https://github.com/${PUBLIC_REPO}/releases/tag/${TAG}`)

// ───────────────────────────── (b) git ─────────────────────────────

if (DRY) warn('Git', 'Xem trước: không chạy git fetch, dùng thông tin trên máy (origin/main có thể đã cũ).')
else {
  const f = git(['fetch', 'origin', '--tags'])
  if (f.code !== 0) fail('Git', `git fetch origin lỗi: ${f.err.split('\n')[0]}`)
}
const status = git(['status', '--porcelain'])
if (status.code !== 0) fail('Git', 'Không đọc được git status.')
else {
  const lines = status.out.split(/\r?\n/).filter((l) => l.trim())
  const tracked = lines.filter((l) => !l.startsWith('??'))
  const untracked = lines.length - tracked.length
  if (tracked.length) fail('Git', `Còn ${tracked.length} file đã sửa chưa commit (${tracked.slice(0, 4).map((l) => l.slice(3)).join(', ')}${tracked.length > 4 ? ', …' : ''}).`)
  else ok('Git', 'Không còn thay đổi chưa commit')
  if (untracked) warn('Git', `Có ${untracked} file mới chưa theo dõi (không được đăng, chỉ để bạn biết).`)
}
const head = git(['rev-parse', 'HEAD']).out
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
const commitDate = git(['show', '-s', '--format=%cI', 'HEAD']).out || null
const tagLocal = git(['rev-parse', '-q', '--verify', `refs/tags/${TAG}^{commit}`])
if (tagLocal.code !== 0 || !tagLocal.out) fail('Git', `Chưa có tag ${TAG}. Tạo trên commit phát hành: git tag -a ${TAG} -m "SanoVids ${V}" rồi git push origin ${TAG}.`)
else if (tagLocal.out !== head) fail('Git', `Tag ${TAG} trỏ vào ${short(tagLocal.out)}, không phải commit đang đứng (HEAD ${short(head)}).`)
else ok('Git', `Tag ${TAG} = HEAD (${short(head)})`)
const lsRemote = git(['ls-remote', '--tags', 'origin', `refs/tags/${TAG}`, `refs/tags/${TAG}^{}`])
const remoteTag = lsRemote.code === 0 ? peeledTagSha(lsRemote.out, TAG) : null
if (lsRemote.code !== 0) fail('Git', `Không hỏi được GitHub về tag ${TAG} (mất mạng?).`)
else if (!remoteTag) fail('Git', `Chưa push tag ${TAG} lên GitHub: git push origin ${TAG}`)
else if (remoteTag !== head) fail('Git', `Tag ${TAG} trên GitHub trỏ vào ${short(remoteTag)}, khác HEAD ${short(head)}.`)
else ok('Git', `Tag ${TAG} đã có trên GitHub`)
const anc = git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
if (anc.code === 0) ok('Git', 'Commit phát hành đã nằm trong origin/main')
else if (anc.code === 1) fail('Git', 'Commit phát hành chưa có trong origin/main: merge vào main (và push) trước.')
else fail('Git', 'Không kiểm tra được origin/main.')
if (branch !== 'main') warn('Git', `Đang ở ${branch === 'HEAD' ? 'một commit (detached)' : `nhánh ${branch}`}, không phải main.`)

// ───────────────────────────── (c) files ─────────────────────────────

const pick = (name) => [path.join(buildDir, name), path.join(releaseDir, name)].find(exists) ?? null
const paths = {
  [FILES.setup]: exists(path.join(releaseDir, FILES.setup)) ? path.join(releaseDir, FILES.setup) : null,
  [FILES.portable]: exists(path.join(releaseDir, FILES.portable)) ? path.join(releaseDir, FILES.portable) : null,
  [FILES.blockmap]: pick(FILES.blockmap),
  [FILES.latestYml]: pick(FILES.latestYml),
}
for (const [name, p] of Object.entries(paths)) {
  if (p) ok('File', `${rel(p)} (${size(fs.statSync(p).size)})`)
  else fail('File', `Thiếu ${name} trong release/ (hoặc release/_build/). Chạy npm run dist:win.`)
}
console.log(`Đang tính mã kiểm tra các file ${V}…`)
const hashes = {}
for (const [name, p] of Object.entries(paths)) if (p) hashes[name] = await hashFile(p)
const setupHash = hashes[FILES.setup]

// ───────────────────────────── (d) latest.yml ─────────────────────────────

let latestBytes = null
if (paths[FILES.latestYml]) {
  latestBytes = fs.readFileSync(paths[FILES.latestYml])
  let obj = null
  try {
    obj = loadYaml(latestBytes.toString('utf8'))
  } catch {
    obj = null
  }
  if (!setupHash) fail('latest.yml', 'Không kiểm tra được vì thiếu file Setup.')
  else {
    const problems = checkLatestYml(obj, { version: V, setupName: FILES.setup, sha512: setupHash.sha512, size: setupHash.size, notBefore: commitDate })
    for (const p of problems) fail('latest.yml', p)
    if (!problems.length) ok('latest.yml', `Khớp ${FILES.setup} (phiên bản, SHA-512, kích thước, ngày build sau commit)`)
  }
  if (obj && typeof obj === 'object' && obj.releaseNotes) ok('latest.yml', `Có ghi chú phát hành cho app (${String(obj.releaseNotes).length} ký tự)`)
  else warn('latest.yml', 'Chưa có ghi chú phát hành (build/release-notes.md): hộp "Cập nhật SanoVids" sẽ thiếu phần "Có gì mới".')
}

// ───────────────────────────── (e) blockmap ─────────────────────────────

if (paths[FILES.blockmap]) {
  try {
    const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(paths[FILES.blockmap])).toString('utf8'))
    if (Array.isArray(map?.files) && map.files.length) ok('Blockmap', `${FILES.blockmap} đọc được (để máy người dùng chỉ tải phần thay đổi)`)
    else fail('Blockmap', `${FILES.blockmap} không có danh sách files.`)
  } catch {
    fail('Blockmap', `${FILES.blockmap} hỏng (không giải nén được).`)
  }
}

// ───────────────────────────── (f) app-update.yml (hard fail) ─────────────────────────────

const resourcesDir = [path.join(buildDir, 'win-unpacked', 'resources'), path.join(releaseDir, 'win-unpacked', 'resources')].find((d) =>
  exists(path.join(d, 'app-update.yml')),
)
if (!resourcesDir) fail('Nguồn cập nhật', 'Không thấy win-unpacked/resources/app-update.yml trong release/_build. Chạy npm run dist:win.')
else {
  let feed = null
  try {
    feed = loadYaml(fs.readFileSync(path.join(resourcesDir, 'app-update.yml'), 'utf8'))
  } catch {
    feed = null
  }
  const problems = checkAppUpdateYml(feed)
  for (const p of problems) fail('Nguồn cập nhật', `${p} Đăng bản này thì máy người dùng sẽ KHÔNG BAO GIỜ nhận được bản sau.`)
  if (!problems.length) ok('Nguồn cập nhật', `app-update.yml trỏ vào ${PUBLIC_REPO} (công khai, không token)`)
}

// ───────────────────────────── (g) app.asar ─────────────────────────────

const asarPath = resourcesDir ? path.join(resourcesDir, 'app.asar') : null
if (asarPath && exists(asarPath)) {
  let fd = null
  try {
    fd = fs.openSync(asarPath, 'r')
    const prefix = Buffer.alloc(16)
    fs.readSync(fd, prefix, 0, 16, 0)
    const headBuf = Buffer.alloc(asarHeaderBytes(prefix))
    fs.readSync(fd, headBuf, 0, headBuf.length, 0)
    const header = readAsarHeader(headBuf)
    for (const p of ['electron/updater.cjs', 'node_modules/electron-updater/package.json']) {
      if (asarHas(header, p)) ok('app.asar', `Có ${p}`)
      else fail('app.asar', `Thiếu ${p}: bản build này không tự cập nhật được.`)
    }
    const entry = asarEntry(header, 'package.json')
    if (!entry || entry.unpacked || typeof entry.size !== 'number') fail('app.asar', 'Không đọc được package.json trong app.asar.')
    else {
      const buf = Buffer.alloc(entry.size)
      fs.readSync(fd, buf, 0, entry.size, asarDataOffset(headBuf) + Number(entry.offset))
      const inner = JSON.parse(buf.toString('utf8'))
      const bad = []
      if (inner.name !== 'sanovids') bad.push(`name "${inner.name}"`)
      if (inner.productName !== 'SanoVids') bad.push(`productName "${inner.productName}"`)
      if (inner.version !== V) bad.push(`version "${inner.version}"`)
      if ('sanovidsTestProfileDir' in inner) bad.push('có sanovidsTestProfileDir (bản build thử nghiệm!)')
      if (bad.length) fail('app.asar', `package.json trong app không phải bản phát hành ${V}: ${bad.join(', ')}.`)
      else ok('app.asar', `package.json trong app: sanovids / SanoVids / ${V}`)
    }
  } catch (e) {
    fail('app.asar', `Không đọc được app.asar (${e?.message ?? e}).`)
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
} else if (resourcesDir) fail('app.asar', 'Thiếu win-unpacked/resources/app.asar.')

// ───────────────────────────── (h) package.json ─────────────────────────────

const publish = pkg.build?.publish
const publishList = Array.isArray(publish) ? publish : publish ? [publish] : []
if (sameJson(publishList[0], PUBLISH_ENTRY)) ok('package.json', `build.publish = github / ${PUBLISH_ENTRY.owner} / ${PUBLISH_ENTRY.repo}`)
else fail('package.json', `build.publish[0] phải đúng là ${JSON.stringify(PUBLISH_ENTRY)}.`)
if (publishList.some((p) => p && typeof p === 'object' && ('token' in p || 'private' in p))) fail('package.json', 'build.publish có token / private.')
if (pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, 'release')) {
  fail('package.json', 'Có script tên "release": electron-builder sẽ tự đăng bản khi chạy nó. Đổi tên script đó.')
}

// ───────────────────────────── (i) GitHub ─────────────────────────────

let ghReady = false
let publicBranch = 'main'
let privateReleases = null
let publicReleases = null
if (gh(['--version']).code !== 0) fail('GitHub', 'Chưa cài GitHub CLI (gh): https://cli.github.com')
else if (gh(['auth', 'status']).code !== 0) fail('GitHub', 'GitHub CLI chưa đăng nhập: chạy gh auth login.')
else {
  ghReady = true
  ok('GitHub', 'GitHub CLI đã đăng nhập')
  const view = gh(['repo', 'view', PUBLIC_REPO, '--json', 'visibility,defaultBranchRef'])
  let info = null
  try {
    info = view.code === 0 ? JSON.parse(view.out) : null
  } catch {
    info = null
  }
  if (!info) fail('GitHub', `Chưa có repo ${PUBLIC_REPO} (hoặc không xem được). Tạo repo CÔNG KHAI, có README, rồi chạy lại.`)
  else {
    if (info.visibility === 'PUBLIC') ok('GitHub', `${PUBLIC_REPO} là repo công khai`)
    else fail('GitHub', `${PUBLIC_REPO} đang là ${info.visibility}: app chỉ đọc được repo công khai.`)
    if (info.defaultBranchRef?.name) {
      publicBranch = info.defaultBranchRef.name
      ok('GitHub', `${PUBLIC_REPO} có nhánh mặc định ${publicBranch}`)
    } else fail('GitHub', `${PUBLIC_REPO} chưa có nhánh nào: thêm một README rồi chạy lại.`)
    publicReleases = readReleases(PUBLIC_REPO)
    if (!publicReleases) fail('GitHub', `Không đọc được Releases của ${PUBLIC_REPO}.`)
    else {
      const newest = newestPublishedVersion(publicReleases)
      if (newest && compareVersions(newest, V) > 0) fail('GitHub', `${PUBLIC_REPO} đã có bản mới hơn (${newest}): người dùng sẽ không nhận ${V}.`)
      else if (newest && compareVersions(newest, V) === 0) warn('GitHub', `${TAG} đã đăng trên ${PUBLIC_REPO}: chỉ kiểm tra / bổ sung file còn thiếu.`)
      else ok('GitHub', `Bản công khai mới nhất hiện tại: ${newest ?? 'chưa có'} (< ${V})`)
    }
  }
  privateReleases = readReleases(PRIVATE_REPO)
  if (!privateReleases) fail('GitHub', `Không đọc được Releases của ${PRIVATE_REPO}.`)
}

// ───────────────────────────── notes + plan ─────────────────────────────

const notesDir = DRY ? path.join(os.tmpdir(), 'sanovids-release-check') : path.join(buildDir, 'publish')
const notesFiles = { private: path.join(notesDir, 'notes-private.md'), public: path.join(notesDir, 'notes-public.md') }
const title = releaseTitle(V, section?.subtitle ?? null)
const haveSums = Boolean(hashes[FILES.setup] && hashes[FILES.portable])
if (section?.body && haveSums) {
  const sha256 = Object.fromEntries(Object.entries(hashes).map(([n, h]) => [n, h.sha256]))
  fs.mkdirSync(notesDir, { recursive: true })
  for (const audience of ['private', 'public']) {
    fs.writeFileSync(notesFiles[audience], buildReleaseNotes({ version: V, body: section.body, sha256, audience }), 'utf8')
  }
  ok('Ghi chú GitHub', `${DRY ? notesFiles.private : rel(notesFiles.private)} · ${DRY ? notesFiles.public : rel(notesFiles.public)}`)
} else fail('Ghi chú GitHub', 'Chưa tạo được ghi chú GitHub (thiếu mục CHANGELOG hoặc file cài đặt).')

const targets = [
  { audience: 'private', repo: PRIVATE_REPO, releases: privateReleases, target: 'main' },
  { audience: 'public', repo: PUBLIC_REPO, releases: publicReleases, target: publicBranch },
].map((t) => {
  const expected = assetsFor(t.audience, V).map((name) => ({ name, path: paths[name], size: hashes[name]?.size ?? -1, sha256: hashes[name]?.sha256 ?? '' }))
  const matching = (t.releases ?? []).filter((r) => r && r.tag_name === TAG)
  const plan = planTarget({ repo: t.repo, tag: TAG, releases: matching, expected })
  return { ...t, expected, plan, known: Array.isArray(t.releases), notesFile: DRY ? notesFiles[t.audience] : rel(notesFiles[t.audience]) }
})
for (const t of targets) if (t.plan.action === 'stop') fail('Kế hoạch', t.plan.message)

// ───────────────────────────── report ─────────────────────────────

const SYMBOL = { ok: '✓', warn: '⚠', fail: '✗' }
console.log(`\nSanoVids ${V} — kiểm tra trước khi đăng${DRY ? ' (XEM TRƯỚC: không đăng, không sửa gì)' : ''}\n`)
let lastGroup = ''
for (const r of results) {
  if (r.group !== lastGroup) {
    console.log(`  ${r.group}`)
    lastGroup = r.group
  }
  console.log(`    ${SYMBOL[r.level]} ${r.text}`)
}

function stepArgv(t, step) {
  const filesOf = (names) => names.map((n) => (paths[n] ? rel(paths[n]) : n))
  switch (step) {
    case 'create-draft':
      return [ghCreateDraftArgs({ repo: t.repo, tag: TAG, title, notesFile: t.notesFile, audience: t.audience, target: t.target })]
    case 'edit-notes':
      return [ghEditNotesArgs({ repo: t.repo, tag: TAG, title, notesFile: t.notesFile })]
    case 'upload':
      return t.plan.upload.length ? [ghUploadArgs({ repo: t.repo, tag: TAG, files: filesOf(t.plan.upload) })] : []
    case 'clobber':
      return t.plan.clobber.length ? [ghUploadArgs({ repo: t.repo, tag: TAG, files: filesOf(t.plan.clobber), clobber: true })] : []
    default:
      return []
  }
}

const ACTION_TEXT = {
  create: 'chưa có bản → tạo bản nháp, tải file lên, kiểm tra, đăng',
  'update-draft': 'đã có bản nháp → cập nhật ghi chú, tải file còn thiếu / khác, kiểm tra, đăng',
  repair: 'đã đăng nhưng thiếu file → tải bổ sung, kiểm tra',
  'verify-only': 'đã đăng → chỉ kiểm tra lại file',
  skip: 'đã đăng đủ và khớp → bỏ qua',
  stop: 'DỪNG',
}
console.log('\n  Kế hoạch (theo đúng thứ tự)')
let n = 0
for (const t of targets) {
  n += 1
  console.log(`    ${n}. ${t.repo}: ${ACTION_TEXT[t.plan.action]}${t.known ? '' : ' (chưa đọc được Releases: giả sử chưa có bản nào)'}`)
  for (const step of t.plan.steps) for (const argv of stepArgv(t, step)) console.log(`         ${formatArgv('gh', argv)}`)
}
const toPublish = targets.filter((t) => t.plan.steps.includes('publish'))
const toVerify = targets.filter((t) => t.plan.steps.includes('verify'))
if (toVerify.length) console.log(`    ${++n}. Kiểm tra lại trên GitHub: tên, kích thước, SHA-256 từng file (${toVerify.map((t) => t.repo).join(', ')})`)
for (const t of toPublish) {
  console.log(`    ${++n}. Đăng ${t.audience === 'public' ? 'bản CÔNG KHAI (cuối cùng — từ lúc này máy người dùng thấy bản mới)' : 'bản riêng'}:`)
  console.log(`         ${formatArgv('gh', ghPublishArgs({ repo: t.repo, tag: TAG }))}`)
}
console.log(`    ${++n}. Kiểm tra như máy người dùng (không đăng nhập): /releases/latest = ${TAG}, latest.yml giống hệt file trên máy, releases.atom có ${TAG}`)

const failures = results.filter((r) => r.level === 'fail').length
const warnings = results.filter((r) => r.level === 'warn').length
if (DRY) {
  console.log(`\nXem trước xong: ${failures} lỗi ✗, ${warnings} lưu ý ⚠. Không đăng, không sửa gì trên GitHub.`)
  process.exit(failures ? 1 : 0)
}
if (failures) {
  console.log(`\n✗ ${failures} lỗi — CHƯA ĐĂNG GÌ. Sửa các dòng ✗ rồi chạy lại.`)
  process.exit(1)
}
if (!ghReady) process.exit(1)

// ───────────────────────────── execute ─────────────────────────────

function mustGh(args, what) {
  console.log(`  → ${formatArgv('gh', args)}`)
  const r = gh(args)
  if (r.code !== 0) {
    console.error(`\n✗ ${what} lỗi:\n${r.err || r.out}\n\nChưa có gì được đăng công khai. Chạy lại lệnh (an toàn, làm tiếp từ chỗ dừng).`)
    process.exit(1)
  }
  return r
}

console.log('\nĐang thực hiện…')
for (const t of targets) {
  for (const step of t.plan.steps) for (const argv of stepArgv(t, step)) mustGh(argv, `${t.repo}: ${step}`)
}

async function downloadSha256(repo, asset) {
  const tmp = path.join(os.tmpdir(), `sanovids-verify-${process.pid}-${asset.id}`)
  try {
    const fd = fs.openSync(tmp, 'w')
    let r
    try {
      r = spawnSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`], {
        cwd: root,
        stdio: ['ignore', fd, 'pipe'],
        shell: false,
        windowsHide: true,
      })
    } finally {
      fs.closeSync(fd)
    }
    if (r.error || r.status !== 0) return null
    return (await hashFile(tmp)).sha256
  } finally {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
  }
}

let verifyProblems = 0
for (const t of toVerify) {
  const list = (readReleases(t.repo) ?? []).filter((r) => r && r.tag_name === TAG)
  if (list.length !== 1) {
    console.error(`  ✗ ${t.repo}: không thấy đúng một bản ${TAG} sau khi tải lên.`)
    verifyProblems += 1
    continue
  }
  const cmp = compareAssets(t.expected, list[0].assets)
  for (const name of cmp.missing) {
    console.error(`  ✗ ${t.repo}: thiếu ${name}`)
    verifyProblems += 1
  }
  for (const m of cmp.mismatched) {
    console.error(`  ✗ ${t.repo}: ${m.name} — ${m.reason}`)
    verifyProblems += 1
  }
  for (const name of cmp.unverified) {
    const asset = list[0].assets.find((a) => a.name === name)
    const sum = asset ? await downloadSha256(t.repo, asset) : null
    const want = t.expected.find((e) => e.name === name)?.sha256
    if (sum && sum === want) console.log(`  ✓ ${t.repo}: ${name} (tải về kiểm tra: SHA-256 khớp)`)
    else {
      console.error(`  ✗ ${t.repo}: ${name} — ${sum ? 'SHA-256 khác' : 'không tải về kiểm tra được'}`)
      verifyProblems += 1
    }
  }
  if (!cmp.missing.length && !cmp.mismatched.length) console.log(`  ✓ ${t.repo}: ${t.expected.length} file khớp`)
}
if (verifyProblems) {
  console.error('\n✗ Kiểm tra sau khi tải lên chưa đạt. Bản nháp vẫn là nháp (người dùng chưa thấy). Chạy lại lệnh để tải lại.')
  process.exit(1)
}

// Private first, public LAST: the public release is what every installed app sees.
for (const t of [...toPublish].sort((a, b) => (a.audience === 'public') - (b.audience === 'public'))) {
  mustGh(ghPublishArgs({ repo: t.repo, tag: TAG }), `${t.repo}: đăng bản`)
}

// ───────────────────────────── anonymous check ─────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function anonymousCheck() {
  const base = `https://github.com/${PUBLIC_REPO}/releases`
  let last = ''
  for (let i = 1; i <= 5; i++) {
    try {
      const latest = await fetch(`${base}/latest`, { headers: { Accept: 'application/json' } })
      const tag = latest.ok ? (await latest.json())?.tag_name : null
      const yml = await fetch(`${base}/latest/download/latest.yml`)
      const ymlBytes = yml.ok ? Buffer.from(await yml.arrayBuffer()) : null
      const atom = await fetch(`${base}.atom`)
      const atomText = atom.ok ? await atom.text() : ''
      const okTag = tag === TAG
      const okYml = Boolean(ymlBytes && latestBytes && ymlBytes.equals(latestBytes))
      const okAtom = atomText.includes(`/releases/tag/${TAG}`)
      if (okTag && okYml && okAtom) return { ok: true }
      last = `latest=${tag ?? '—'} latest.yml=${okYml ? 'khớp' : 'khác'} atom=${okAtom ? 'có' : 'chưa có'} ${TAG}`
    } catch (e) {
      last = String(e?.message ?? e)
    }
    if (i < 5) await sleep(10_000)
  }
  return { ok: false, last }
}

console.log('\nKiểm tra như máy người dùng (không đăng nhập)…')
const anon = await anonymousCheck()
if (!anon.ok) {
  console.error(
    `\n⚠ Đã đăng, nhưng sau 5 lần thử máy ngoài chưa thấy đúng ${TAG} (${anon.last}).\n` +
      `  Mở https://github.com/${PUBLIC_REPO}/releases/latest kiểm tra bằng mắt; GitHub đôi khi chậm vài phút. Chạy lại lệnh để kiểm tra tiếp.`,
  )
  process.exit(1)
}
console.log(`\n✓ Đã đăng SanoVids ${V}. Máy đã cài bản Setup sẽ tự nhận bản này trong vòng vài giờ (khi mở app hoặc 4 giờ một lần).`)
console.log(`  Trang tải về: https://github.com/${PUBLIC_REPO}/releases/latest`)

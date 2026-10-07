// Inspects the macOS build right after electron-builder made it (last step of `npm run dist:mac`, on a Mac only: the
// GitHub Actions runner of .github/workflows/mac-build.yml). Writes release/mac/mac-check.json and exits 1 when any
// check fails (the build is then broken and never uploaded):
//   codesign      `codesign --verify --deep --strict` passes on SanoVids.app
//   signature     ad hoc ("Signature=adhoc", flags adhoc + runtime, Identifier=com.sanovids.app, no Team ID): electron-
//                 builder may otherwise pick a keychain identity whose name merely contains "-"
//   entitlements  exactly allow-jit + disable-library-validation, both true (compared by meaning, not bytes: codesign
//                 stores the plist without the repo file's comments)
//   infoPlist     bundle id, executable, version, macOS 13+, copyright, ElectronAsarIntegrity present
//   asarIntegrity ElectronAsarIntegrity["Resources/app.asar"].hash = sha256 of the archive's header
//   fuses         the fuse wire of Electron Framework = releaseLib.EXPECTED_FUSE_WIRE (one slice: arm64 only)
//   noUnpacked    no Resources/app.asar.unpacked
//   contents      Contents/ holds only Info.plist, PkgInfo, MacOS, Frameworks, Resources, _CodeSignature
//   appAsar       the required electron/*.cjs, and the release's package.json (checkPackagedIdentity: no test pins / profile)
//   appUpdateYml  the public feed, anonymous (no publisherName required on macOS)
//   licenses      the four licence files in Contents/Resources, byte-identical to their sources
//   arch          `lipo -archs` of the executable = arm64
//   dmg           `hdiutil verify`; the app inside the read-only mounted DMG, the app inside the zip and the built app
//                 have the same tree hash (paths, modes, contents, symlink targets), and the DMG's app verifies too
//   latestMacYml  latest-mac.yml lists only the zip, with its sha512 / size, and no minimumSystemVersion
// mac-check.json = { v: 1, version, commit, dirty, source: 'ci' | 'local', ci, files: [the 4 fixed files with sha512 /
// size], checks, problems }. Never calls `git` outside CI: on a fresh Mac /usr/bin/git is Apple's stub that opens the
// Command Line Tools installer — the commit is read from .git directly (readGitCommit); a local build only learns
// whether its tree is clean when the Command Line Tools are installed (`xcode-select -p`), else dirty: null (refused by
// publish-release). Pure helpers are exported for scripts/__tests__/macInspect.test.mjs (they run on Windows too).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import {
  MAC_APP_ID,
  MAC_CHECKS,
  MAC_CONTENTS,
  MAC_LICENSE_FILES,
  REQUIRED_ASAR_FILES,
  FUSE_SENTINEL,
  asarDataOffset,
  asarEntry,
  asarHas,
  asarHeaderBytes,
  asarHeaderSha256Of,
  checkAppUpdateYml,
  checkFuseWire,
  checkLatestMacYml,
  checkMacAsarIntegrity,
  checkMacEntitlements,
  checkMacInfoPlist,
  checkPackagedIdentity,
  macBuildFiles,
  parsePlistXml,
  readAsarHeader,
  readFuseWire,
  releaseFiles,
} from './releaseLib.mjs'

const COMMIT = /^[0-9a-f]{40}$/

// ───────────────────────────── pure helpers (tested) ─────────────────────────────

/**
 * The commit HEAD points at, read from .git without running git: HEAD holds a sha (detached) or "ref: refs/…" (then the
 * loose ref file, else packed-refs). A `.git` FILE ("gitdir: …", worktrees / submodules) is followed, with its
 * commondir for the refs. → 40-hex sha | null. fsLike = { readFileSync, statSync } (node:fs). Never throws.
 */
export function readGitCommit(repoRoot, fsLike = fs) {
  try {
    let gitDir = path.join(repoRoot, '.git')
    if (fsLike.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(String(fsLike.readFileSync(gitDir, 'utf8')))
      if (!m) return null
      gitDir = path.resolve(repoRoot, m[1])
    }
    let commonDir = gitDir
    try {
      const c = String(fsLike.readFileSync(path.join(gitDir, 'commondir'), 'utf8')).trim()
      if (c) commonDir = path.resolve(gitDir, c)
    } catch {
      // not a linked worktree
    }
    const head = String(fsLike.readFileSync(path.join(gitDir, 'HEAD'), 'utf8')).trim()
    if (COMMIT.test(head)) return head
    const ref = /^ref:\s*(refs\/[^\s]+)$/.exec(head)
    if (!ref || ref[1].includes('..')) return null
    for (const dir of [gitDir, commonDir]) {
      try {
        const sha = String(fsLike.readFileSync(path.join(dir, ...ref[1].split('/')), 'utf8')).trim()
        if (COMMIT.test(sha)) return sha
      } catch {
        // not a loose ref here
      }
    }
    const packed = String(fsLike.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8'))
    for (const line of packed.split(/\r?\n/)) {
      const m = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim())
      if (m && m[2] === ref[1]) return m[1]
    }
    return null
  } catch {
    return null
  }
}

/**
 * Where this build ran (env = process.env): GitHub Actions → { source: 'ci', ci: { runId, runNumber, runAttempt, event,
 * ref, rc, repository, sha } } (rc = SANOVIDS_MAC_RC "true", set by the workflow from its rc input); else
 * { source: 'local', ci: null }.
 */
export function ciContext(env = {}) {
  if (env.GITHUB_ACTIONS !== 'true') return { source: 'local', ci: null }
  const int = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null)
  return {
    source: 'ci',
    ci: {
      runId: int(env.GITHUB_RUN_ID),
      runNumber: int(env.GITHUB_RUN_NUMBER),
      runAttempt: int(env.GITHUB_RUN_ATTEMPT),
      event: typeof env.GITHUB_EVENT_NAME === 'string' ? env.GITHUB_EVENT_NAME : null,
      ref: typeof env.GITHUB_REF === 'string' ? env.GITHUB_REF : null,
      rc: env.SANOVIDS_MAC_RC === 'true',
      repository: typeof env.GITHUB_REPOSITORY === 'string' ? env.GITHUB_REPOSITORY : null,
      sha: COMMIT.test(String(env.GITHUB_SHA ?? '')) ? env.GITHUB_SHA : null,
    },
  }
}

/** `codesign -dv --verbose=4` output (it writes to stderr) → { signature, identifier, teamId, flags: [] }. */
export function parseCodesignDetails(text) {
  const s = String(text ?? '')
  const field = (name) => {
    const m = new RegExp(`^${name}=(.*)$`, 'm').exec(s)
    return m ? m[1].trim() : null
  }
  const flags = /^CodeDirectory\b.*\bflags=0x[0-9a-f]+\(([^)]*)\)/im.exec(s)
  return {
    signature: field('Signature'),
    identifier: field('Identifier'),
    teamId: field('TeamIdentifier'),
    flags: flags ? flags[1].split(',').map((f) => f.trim()).filter(Boolean) : [],
  }
}

/** The ad-hoc signature electron-builder must have made (mac.identity "-") → problems. */
export function checkCodesignDetails(d, { identifier = MAC_APP_ID } = {}) {
  if (!d || typeof d !== 'object') return ['Không đọc được thông tin chữ ký (codesign -dv).']
  const p = []
  if (d.signature !== 'adhoc') p.push(`Chữ ký là ${JSON.stringify(d.signature)}, cần "adhoc" (mac.identity "-": electron-builder có thể đã chọn nhầm một danh tính trong keychain).`)
  if (!d.flags.includes('adhoc')) p.push(`CodeDirectory thiếu cờ adhoc (cờ: ${d.flags.join(', ') || '—'}).`)
  if (!d.flags.includes('runtime')) p.push(`CodeDirectory thiếu cờ runtime: hardened runtime chưa bật (cờ: ${d.flags.join(', ') || '—'}).`)
  if (d.identifier !== identifier) p.push(`Identifier là ${JSON.stringify(d.identifier)}, cần "${identifier}".`)
  if (d.teamId && d.teamId !== 'not set') p.push(`TeamIdentifier là "${d.teamId}": bản ad-hoc không có Team ID.`)
  return p
}

/** The entitlements plist `codesign -d --entitlements - --xml` printed (stdout, maybe with a header line) → object. Throws. */
export function entitlementsFromCodesign(stdout) {
  const s = String(stdout ?? '')
  const at = s.search(/<\?xml|<plist/)
  if (at < 0) throw new Error('codesign không in entitlements dạng XML')
  return parsePlistXml(s.slice(at))
}

/**
 * Tree hash of a folder from its entries [{ path (POSIX, relative), type: 'dir' | 'file' | 'link', mode, sha256?,
 * target? }]: sha256 of the sorted lines "<type> <mode & 0o777 in octal> <path> <sha256 | target>". Same bytes,
 * permissions and symlinks → same hash, whatever the order the entries were listed in.
 */
export function treeHashOf(entries) {
  const lines = (Array.isArray(entries) ? entries : []).map((e) => {
    const mode = ((Number(e.mode) || 0) & 0o777).toString(8)
    const what = e.type === 'file' ? e.sha256 : e.type === 'link' ? `-> ${e.target}` : ''
    return `${e.type} ${mode} ${e.path} ${what}`
  })
  lines.sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** mac-check.json content (v 1). */
export function buildMacCheck({ version, commit, dirty, source, ci, files, checks, problems }) {
  return {
    v: 1,
    version,
    commit: COMMIT.test(String(commit ?? '')) ? commit : null,
    dirty: dirty === true || dirty === false ? dirty : null,
    source,
    ci: source === 'ci' ? ci : null,
    files,
    checks: Object.fromEntries(MAC_CHECKS.map((k) => [k, checks?.[k] === true])),
    problems: Array.isArray(problems) ? problems : [],
  }
}

// ───────────────────────────── the inspection (macOS only) ─────────────────────────────

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, ...opts })
  return { code: r.error ? -1 : (r.status ?? -1), out: String(r.stdout ?? ''), err: String(r.stderr ?? r.error?.message ?? '') }
}

function hashFile(file) {
  const h512 = createHash('sha512')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
  let size = 0
  try {
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) {
      h512.update(buf.subarray(0, n))
      size += n
    }
  } finally {
    fs.closeSync(fd)
  }
  return { sha512: h512.digest('base64'), size }
}

/** Every entry under `dir` for treeHashOf (symlinks are never followed). */
function treeEntries(dir) {
  const out = []
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name
      const full = path.join(dir, r)
      const st = fs.lstatSync(full)
      if (st.isSymbolicLink()) out.push({ path: r, type: 'link', mode: st.mode, target: fs.readlinkSync(full) })
      else if (st.isDirectory()) {
        out.push({ path: r, type: 'dir', mode: st.mode })
        walk(r)
      } else out.push({ path: r, type: 'file', mode: st.mode, sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex') })
    }
  }
  walk('')
  return out
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('mac-inspect: chỉ chạy trên macOS (bước cuối của npm run dist:mac).')
    process.exit(1)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const V = String(pkg.version)
  const productName = pkg.build?.productName ?? pkg.productName ?? 'SanoVids'
  const outDir = path.join(root, 'release', 'mac')
  const appPath = path.join(outDir, 'mac-arm64', `${productName}.app`)
  const contents = path.join(appPath, 'Contents')
  const F = releaseFiles(V)
  const checks = {}
  const problems = []
  /** Runs one check: its problems are recorded, the check passes when there are none (or fails on a throw). */
  const check = async (key, fn) => {
    try {
      const p = (await fn()) ?? []
      problems.push(...p.map((t) => `${key}: ${t}`))
      checks[key] = p.length === 0
    } catch (e) {
      problems.push(`${key}: ${e?.message ?? e}`)
      checks[key] = false
    }
  }
  if (!fs.existsSync(appPath)) problems.push(`Không thấy ${path.relative(root, appPath)}.`)

  await check('codesign', () => {
    const r = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    return r.code === 0 ? [] : [`codesign --verify không đạt: ${(r.err || r.out).trim().split('\n').slice(-3).join(' · ')}`]
  })
  await check('signature', () => checkCodesignDetails(parseCodesignDetails(run('codesign', ['-dv', '--verbose=4', appPath]).err), { identifier: MAC_APP_ID }))
  await check('entitlements', () => {
    let r = run('codesign', ['-d', '--entitlements', '-', '--xml', appPath])
    if (!/<plist/.test(r.out)) r = run('codesign', ['-d', '--entitlements', ':-', appPath])
    return checkMacEntitlements(entitlementsFromCodesign(r.out))
  })
  let info = null
  await check('infoPlist', () => {
    const r = run('plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')])
    if (r.code !== 0) return [`plutil không đọc được Info.plist: ${r.err.trim()}`]
    info = JSON.parse(r.out)
    return checkMacInfoPlist(info, { version: V, executable: productName })
  })
  const asarPath = path.join(contents, 'Resources', 'app.asar')
  let asarBuf = null
  try {
    asarBuf = fs.readFileSync(asarPath)
  } catch {
    asarBuf = null
  }
  await check('asarIntegrity', () => (asarBuf ? checkMacAsarIntegrity(info, asarHeaderSha256Of(asarBuf)) : ['Thiếu Resources/app.asar.']))
  await check('fuses', () => {
    const fw = fs.readFileSync(path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework'))
    const p = checkFuseWire(readFuseWire(fw))
    if (fw.indexOf(FUSE_SENTINEL) !== fw.lastIndexOf(FUSE_SENTINEL)) p.push('Electron Framework có hơn một lát cắt (universal?): chỉ dựng arm64.')
    return p
  })
  await check('noUnpacked', () => (fs.existsSync(path.join(contents, 'Resources', 'app.asar.unpacked')) ? ['Có Resources/app.asar.unpacked.'] : []))
  await check('contents', () => {
    const names = fs.readdirSync(contents).filter((n) => n !== '.DS_Store')
    const p = names.filter((n) => !MAC_CONTENTS.includes(n)).map((n) => `Contents có mục lạ: ${n}.`)
    for (const need of ['Info.plist', 'MacOS', 'Frameworks', 'Resources', '_CodeSignature']) if (!names.includes(need)) p.push(`Contents thiếu ${need}.`)
    return p
  })
  await check('appAsar', () => {
    if (!asarBuf) return ['Thiếu Resources/app.asar.']
    const header = readAsarHeader(asarBuf.subarray(0, asarHeaderBytes(asarBuf)))
    const p = REQUIRED_ASAR_FILES.filter((f) => !asarHas(header, f)).map((f) => `app.asar thiếu ${f}.`)
    const e = asarEntry(header, 'package.json')
    if (!e || e.unpacked || typeof e.size !== 'number') return [...p, 'Không đọc được package.json trong app.asar.']
    const start = asarDataOffset(asarBuf) + Number(e.offset)
    const bad = checkPackagedIdentity(JSON.parse(asarBuf.toString('utf8', start, start + e.size)), pkg)
    if (bad.length) p.push(`package.json trong app không phải bản phát hành ${V}: ${bad.join('; ')}.`)
    return p
  })
  await check('appUpdateYml', () => checkAppUpdateYml(loadYaml(fs.readFileSync(path.join(contents, 'Resources', 'app-update.yml'), 'utf8')), { platform: 'mac' }))
  await check('licenses', () => {
    const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
    const sources = {
      'LICENSE.txt': path.join(root, 'LICENSE.txt'),
      'THIRD-PARTY-NOTICES.txt': path.join(root, 'build', 'license-third-party.txt'),
      'LICENSE.electron.txt': path.join(electronDist, 'LICENSE'),
      'LICENSES.chromium.html': path.join(electronDist, 'LICENSES.chromium.html'),
    }
    const p = []
    for (const name of MAC_LICENSE_FILES) {
      const shipped = path.join(contents, 'Resources', name)
      if (!fs.existsSync(shipped)) p.push(`Thiếu Contents/Resources/${name}.`)
      else if (!fs.readFileSync(shipped).equals(fs.readFileSync(sources[name]))) p.push(`Contents/Resources/${name} khác ${path.relative(root, sources[name])}.`)
    }
    return p
  })
  await check('arch', () => {
    const r = run('lipo', ['-archs', path.join(contents, 'MacOS', productName)])
    return r.code === 0 && r.out.trim() === 'arm64' ? [] : [`lipo -archs: ${JSON.stringify(r.out.trim() || r.err.trim())}, cần "arm64".`]
  })
  await check('dmg', async () => {
    const dmgPath = path.join(outDir, F.macDmg)
    const zipPath = path.join(outDir, F.macZip)
    const p = []
    const verify = run('hdiutil', ['verify', dmgPath])
    if (verify.code !== 0) return [`hdiutil verify không đạt: ${verify.err.trim().split('\n').slice(-2).join(' · ')}`]
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanovids-mac-inspect-'))
    const mnt = path.join(tmp, 'dmg')
    const unzipped = path.join(tmp, 'zip')
    fs.mkdirSync(mnt)
    let attached = false
    try {
      const att = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmgPath])
      if (att.code !== 0) return [`hdiutil attach không được: ${att.err.trim()}`]
      attached = true
      const dmgApp = path.join(mnt, `${productName}.app`)
      const v = run('codesign', ['--verify', '--deep', '--strict', dmgApp])
      if (v.code !== 0) p.push(`App trong DMG không qua codesign --verify: ${v.err.trim().split('\n').slice(-1)[0]}`)
      const x = run('ditto', ['-x', '-k', zipPath, unzipped])
      if (x.code !== 0) return [...p, `Không giải nén được ${F.macZip}: ${x.err.trim()}`]
      const built = treeHashOf(treeEntries(appPath))
      if (treeHashOf(treeEntries(dmgApp)) !== built) p.push('App trong DMG khác app vừa dựng (tree hash).')
      if (treeHashOf(treeEntries(path.join(unzipped, `${productName}.app`))) !== built) p.push('App trong zip khác app vừa dựng (tree hash).')
    } finally {
      if (attached) run('hdiutil', ['detach', mnt, '-force'])
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    return p
  })
  // The four packaged files, by their fixed names (never a glob).
  const files = []
  for (const name of macBuildFiles(V)) {
    const p = path.join(outDir, name)
    if (!fs.existsSync(p)) {
      problems.push(`files: thiếu ${name}.`)
      continue
    }
    files.push({ name, ...hashFile(p) })
  }
  const zipEntry = files.find((f) => f.name === F.macZip)
  await check('latestMacYml', () =>
    zipEntry ? checkLatestMacYml(loadYaml(fs.readFileSync(path.join(outDir, F.macYml), 'utf8')), { version: V, zipName: F.macZip, sha512: zipEntry.sha512, size: zipEntry.size }) : ['Thiếu file zip.'],
  )

  // Where and from what it was built.
  const { source, ci } = ciContext(process.env)
  const commit = readGitCommit(root)
  let dirty = null
  if (source === 'ci') {
    if (!commit || commit !== ci.sha) problems.push(`commit: .git chỉ ${commit ?? '—'}, GITHUB_SHA là ${ci.sha ?? '—'}.`)
    const st = run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })
    dirty = st.code === 0 ? st.out.trim() !== '' : null
  } else if (run('xcode-select', ['-p']).code === 0) {
    const st = run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })
    dirty = st.code === 0 ? st.out.trim() !== '' : null
  }
  if (dirty !== false) problems.push(`dirty: cây làm việc ${dirty === true ? 'còn thay đổi chưa commit' : 'không kiểm tra được (cài Xcode Command Line Tools: xcode-select --install)'}.`)

  const report = buildMacCheck({ version: V, commit, dirty, source, ci, files, checks, problems })
  fs.writeFileSync(path.join(outDir, F.macCheck), JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(`mac-inspect: ${V} commit ${commit ? commit.slice(0, 7) : '—'} (${source}${ci ? `, run ${ci.runNumber}${ci.rc ? ' RC' : ''}` : ''})`)
  for (const k of MAC_CHECKS) console.log(`  ${report.checks[k] ? '✓' : '✗'} ${k}`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  for (const f of files) console.log(`  ${f.name}  ${f.size} B`)
  if (problems.length || MAC_CHECKS.some((k) => !report.checks[k])) {
    console.error(`mac-inspect: ${problems.length} lỗi — bản dựng Mac này không dùng được.`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

// Brings the Mac build of ONE GitHub Actions run onto this Windows machine: `npm run mac:fetch -- --run <number>`.
//   1. --run is required: the run number of the RC you tested ("mac-build #12" on the Actions page) — never "the latest".
//   2. `gh run list` (private repo, workflow mac-build.yml) finds that run; it must be a manual RC (workflow_dispatch,
//      run-name "mac-build RC …"), completed and successful, on main, at the commit of tag v<version> when the tag
//      exists, else at local main (releaseLib.checkMacRun).
//   3. `gh run download` of its artifact sanovids-mac-<version>-<number> into a temporary folder under release/mac.
//   4. mac-check.json must say: this version, that commit, built by that very run (CI, RC), a clean tree, every check
//      passed, and the SHA-512 / size of each packaged file (releaseLib.checkMacCheck + checkFetchedCheck). Only then
//      the five files replace release/mac's.
//   5. release/mac/mac-fetch.json (macFetchRecord) — publish-release group (k) requires it: the published Mac files are
//      the bytes of the run you tested — and the .dmg's SHA-256 is printed (compare with `shasum -a 256` on the Mac).
// Run it right after the RC run finished (artifacts are kept 3 days). Network: GitHub through gh only; nothing is
// published or deleted on GitHub. git / gh run through spawnSync with an args array (no shell).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRIVATE_REPO, checkMacCheck, checkMacRun, macArtifactName, macBuildFiles, releaseFiles } from './releaseLib.mjs'

/** The workflow file in the private repo (.github/workflows/mac-build.yml). */
export const MAC_WORKFLOW = 'mac-build.yml'
const RUN_FIELDS = 'databaseId,number,attempt,event,status,conclusion,headBranch,headSha,displayTitle,workflowName'

// ───────────────────────────── pure helpers (tested) ─────────────────────────────

/** argv (after the script) → { run } | { error }. --run <n> / --run=<n>, a positive integer, nothing else. */
export function parseFetchArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : []
  let run = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const m = /^--run(?:=(.*))?$/.exec(a)
    if (m) {
      const v = m[1] !== undefined ? m[1] : args[++i]
      if (!/^[1-9]\d{0,9}$/.test(String(v ?? ''))) return { error: `--run cần số lần chạy (ví dụ --run 12), không phải "${v ?? ''}".` }
      run = Number(v)
    } else return { error: `Tham số lạ: ${a}` }
  }
  if (run === null) return { error: 'Thiếu --run <số lần chạy>: ghi đúng số của lần chạy RC bạn đã thử ("mac-build #12" ở trang Actions). Không tự chọn lần chạy mới nhất.' }
  return { run }
}

/** gh argv: the runs of the workflow (newest first). */
export function ghRunListArgs(repo = PRIVATE_REPO) {
  return ['run', 'list', '-R', repo, '--workflow', MAC_WORKFLOW, '--limit', '200', '--json', RUN_FIELDS]
}

/** gh argv: one artifact of one run into `dir`. */
export function ghRunDownloadArgs({ repo = PRIVATE_REPO, runId, name, dir }) {
  return ['run', 'download', String(runId), '-R', repo, '-n', name, '-D', dir]
}

/**
 * mac-check.json of the downloaded artifact against the run it came from → problems: written by GitHub Actions for this
 * very run (run id), as an RC started by hand.
 */
export function checkFetchedCheck(check, run) {
  if (!check || typeof check !== 'object') return ['mac-check.json không đọc được.']
  const p = []
  const ci = check.ci && typeof check.ci === 'object' ? check.ci : null
  if (check.source !== 'ci' || !ci) p.push('mac-check.json không phải của GitHub Actions (source "ci").')
  else {
    if (ci.runId !== run?.databaseId) p.push(`mac-check.json ghi lần chạy ${ci.runId ?? '—'}, artifact lấy từ lần chạy ${run?.databaseId ?? '—'}.`)
    if (ci.event !== 'workflow_dispatch' || ci.rc !== true) p.push('mac-check.json không phải của một bản RC chạy tay (workflow_dispatch, rc = true).')
  }
  return p
}

/** release/mac/mac-fetch.json: the run and the SHA-512 of each fetched file (the four packaged ones + mac-check.json). */
export function macFetchRecord(run, files, now = new Date()) {
  return {
    v: 1,
    runId: run.databaseId,
    runNumber: run.number,
    runAttempt: run.attempt,
    event: run.event,
    rc: true,
    headBranch: run.headBranch,
    headSha: run.headSha,
    conclusion: run.conclusion,
    fetchedAt: now.toISOString(),
    files: files.map((f) => ({ name: f.name, sha512: f.sha512, size: f.size })),
  }
}

// ───────────────────────────── the fetch ─────────────────────────────

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.error ? -1 : (r.status ?? -1), out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? r.error?.message ?? '').trim() }
}

function hashFile(file) {
  const h256 = createHash('sha256')
  const h512 = createHash('sha512')
  const data = fs.readFileSync(file)
  h256.update(data)
  h512.update(data)
  return { sha256: h256.digest('hex'), sha512: h512.digest('base64'), size: data.length }
}

/** Stops the fetch: thrown, so the temporary folder is still removed (main's caller prints it and exits 1). */
function die(text) {
  throw new Error(text)
}

async function main() {
  const args = parseFetchArgs(process.argv.slice(2))
  if (args.error) die(args.error)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const V = String(pkg.version)
  const F = releaseFiles(V)
  // The commit the RC must have built: the tag's when it exists, else local main.
  const tag = run('git', ['rev-parse', '-q', '--verify', `refs/tags/v${V}^{commit}`])
  const main = run('git', ['rev-parse', '-q', '--verify', 'refs/heads/main^{commit}'])
  const headSha = tag.code === 0 && tag.out ? tag.out : main.code === 0 ? main.out : ''
  console.log(`Bản ${V}: lần chạy phải dựng commit ${headSha ? headSha.slice(0, 7) : '—'} (${tag.code === 0 && tag.out ? `tag v${V}` : 'main trên máy'})`)

  if (run('gh', ['--version']).code !== 0) die('Chưa cài GitHub CLI (gh): https://cli.github.com')
  const list = run('gh', ghRunListArgs())
  if (list.code !== 0) die(`Không đọc được danh sách lần chạy mac-build (${list.err.split('\n')[0]}). Đã gh auth login chưa?`)
  let runs = []
  try {
    runs = JSON.parse(list.out)
  } catch {
    runs = []
  }
  const found = (Array.isArray(runs) ? runs : []).find((r) => r && r.number === args.run)
  const runProblems = checkMacRun(found, { runNumber: args.run, headSha })
  if (runProblems.length) die(`Không dùng được lần chạy mac-build #${args.run}:\n  - ${runProblems.join('\n  - ')}`)

  const macDir = path.join(root, 'release', 'mac')
  const tmp = path.join(macDir, `.fetch-${found.databaseId}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  try {
    const name = macArtifactName(V, found.number)
    console.log(`Đang tải artifact ${name} của lần chạy #${found.number}…`)
    const dl = run('gh', ghRunDownloadArgs({ runId: found.databaseId, name, dir: tmp }))
    if (dl.code !== 0) die(`gh run download lỗi (${dl.err.split('\n')[0]}). Artifact chỉ giữ 3 ngày.`)
    const names = [...macBuildFiles(V), F.macCheck]
    const missing = names.filter((n) => !fs.existsSync(path.join(tmp, n)))
    if (missing.length) die(`Artifact thiếu ${missing.join(', ')}.`)
    const hashes = Object.fromEntries(names.map((n) => [n, hashFile(path.join(tmp, n))]))
    let check = null
    try {
      check = JSON.parse(fs.readFileSync(path.join(tmp, F.macCheck), 'utf8'))
    } catch {
      check = null
    }
    const problems = [...checkFetchedCheck(check, found), ...checkMacCheck(check, { version: V, commit: headSha, files: hashes })]
    if (problems.length) die(`Bản Mac của lần chạy #${found.number} không dùng được:\n  - ${problems.join('\n  - ')}`)
    // Only now: the five files replace release/mac's, then the record of where they came from.
    fs.mkdirSync(macDir, { recursive: true })
    for (const n of names) {
      fs.rmSync(path.join(macDir, n), { force: true })
      fs.renameSync(path.join(tmp, n), path.join(macDir, n))
    }
    const record = macFetchRecord(
      found,
      names.map((n) => ({ name: n, ...hashes[n] })),
    )
    fs.writeFileSync(path.join(macDir, F.macFetch), JSON.stringify(record, null, 2) + '\n', 'utf8')
    console.log(`\n✓ Đã tải bản Mac ${V} của lần chạy #${found.number} (commit ${found.headSha.slice(0, 7)}) vào release/mac.`)
    console.log(`  SHA-256 của ${F.macDmg}: ${hashes[F.macDmg].sha256}`)
    console.log('  So trên Mac (nếu muốn): shasum -a 256 ~/Downloads/' + F.macDmg)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((e) => {
    console.error(`\n✗ ${e?.message ?? e}`)
    process.exit(1)
  })
}

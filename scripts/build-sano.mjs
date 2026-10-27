// Builds SANO's web app for Sano Agent (D240, TH-43 phương án D): the SANO-AGENT commit pinned in sano-agent/sano.json,
// taken from a local checkout (env SANO_REPO), into sano-dist/ (gitignored). Only the Sano Agent build packs that folder
// (sano-agent/electron-builder.cjs) and electron/main.cjs serves it at app://sano/. `git archive` takes only the files
// the web build reads (never knowledge/, context/ or the server), and SANO builds with its own lockfile in a temp
// folder: it uses Vite 7 / lucide-react 0.577, not this repo's. Never writes into dist/ (vite build empties it, and all
// of it is served at app://bdp).
// Also writes build/license-third-party-sano-agent.txt (gitignored): SanoVids' notices plus SANO's runtime packages,
// shipped as THIRD-PARTY-NOTICES.txt next to Sano Agent's exe.
// Usage: node scripts/build-sano.mjs (npm run build:sano; npm run dist:sano-agent runs it). Needs git, npm and network.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { bareImports, collectPackages, packageNameOf, renderNotices } from './third-party-notices.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SANO_PIN = 'sano-agent/sano.json'
export const SANO_DIST = 'sano-dist'
export const SANO_NOTICES = 'build/license-third-party-sano-agent.txt'
/** Everything `npm ci && npm run build` (tsc -b && vite build) of SANO reads. */
export const SANO_BUILD_FILES = Object.freeze(['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'public', 'web', 'shared'])
/** SANO folders the page bundles: their bare imports are the licence roots. */
const SANO_WEB_DIRS = ['web', 'shared']
/** Bundler packages whose runtime helpers end up in SANO's build (Vite 7 and its Rollup). */
const SANO_BUNDLER_RUNTIME = ['vite', 'rollup']
// shortcut: the default is Minh's checkout of SANO PR #68; set SANO_REPO on any other machine.
const DEFAULT_SANO_REPO = 'E:/SANO-AGENT-wt-docker'

function check(result, what) {
  if (result.error || result.status !== 0) throw new Error(`${what} lỗi (${result.error ? result.error.message : `mã thoát ${result.status}`})`)
}

/** The zip of `git archive` → files under `dir` (never outside it). */
async function unzip(bytes, dir) {
  const zip = await JSZip.loadAsync(bytes)
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const file = path.resolve(dir, name)
    if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error(`zip có ${name} nằm ngoài thư mục build`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, await entry.async('nodebuffer'))
  }
}

/** SanoVids' notices plus the packages SANO's page bundles (from SANO's own node_modules in `src`), with the BOM. */
function sanoAgentNotices(src) {
  const roots = new Set()
  for (const dir of SANO_WEB_DIRS) {
    for (const rel of fs.readdirSync(path.join(src, dir), { recursive: true })) {
      if (!/\.(?:[cm]?[jt]sx?|css)$/i.test(rel) || /\.(?:test|spec)\./i.test(rel)) continue
      for (const spec of bareImports(fs.readFileSync(path.join(src, dir, rel), 'utf8'))) {
        const name = packageNameOf(spec)
        if (name) roots.add(name)
      }
    }
  }
  const sano = collectPackages(src, [...roots].sort(), SANO_BUNDLER_RUNTIME)
  if (sano.missing.length) throw new Error(`SANO cần gói chưa cài: ${sano.missing.join(', ')}`)
  const byKey = new Map([...collectPackages(ROOT).packages, ...sano.packages].map((p) => [`${p.name}@${p.version}`, p]))
  const packages = [...byKey.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1))
  return `\ufeff${renderNotices(packages)}`
}

async function main() {
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, SANO_PIN), 'utf8'))
  if (!/^[0-9a-f]{40}$/.test(String(pin.commit))) throw new Error(`${SANO_PIN}: "commit" phải là mã commit đủ 40 ký tự hex`)
  const repo = path.resolve(process.env.SANO_REPO || DEFAULT_SANO_REPO)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sano-build-'))
  try {
    const zipFile = path.join(tmp, 'sano.zip')
    // The pinned commit itself, whatever that checkout has checked out or changed.
    check(spawnSync('git', ['-C', repo, 'archive', '--format=zip', '-o', zipFile, pin.commit, '--', ...SANO_BUILD_FILES], { stdio: 'inherit' }), `git archive ${pin.commit} trong ${repo}`)
    const src = path.join(tmp, 'src')
    await unzip(fs.readFileSync(zipFile), src)
    // SANO's own lockfile and build script; no install scripts (its web build needs none).
    for (const command of ['npm ci --ignore-scripts --no-audit --no-fund', 'npm run build']) {
      console.log(`build-sano: ${command}`)
      check(spawnSync(command, { cwd: src, shell: true, stdio: 'inherit' }), command)
    }
    const out = path.join(src, 'dist')
    if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error('SANO build không ra dist/index.html')
    // The SANO-AGENT repo is private: a source map would ship its source in a public installer.
    const maps = fs.readdirSync(out, { recursive: true }).filter((f) => /\.map$/i.test(f))
    if (maps.length) throw new Error(`SANO build có source map (${maps.join(', ')}): tắt build.sourcemap của SANO`)
    const { version } = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
    const notices = sanoAgentNotices(src)
    const dest = path.join(ROOT, SANO_DIST)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(out, dest, { recursive: true })
    fs.writeFileSync(path.join(ROOT, ...SANO_NOTICES.split('/')), notices, 'utf8')
    // Last: release:check:sano-agent compares this commit with the pin.
    fs.writeFileSync(path.join(dest, 'BUILD.json'), `${JSON.stringify({ commit: pin.commit, version }, null, 2)}\n`)
    console.log(`build-sano: SANO ${version} (${pin.commit.slice(0, 7)}) → ${SANO_DIST}/, ${SANO_NOTICES}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-sano: ${e && e.message ? e.message : e}`)
    process.exit(1)
  })
}

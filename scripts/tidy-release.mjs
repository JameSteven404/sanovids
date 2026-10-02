// Keeps release/ tidy after `npm run dist:win`:
//   release/SanoVids-Setup-<current>.exe, SanoVids-Portable-<current>.exe   ← the newest installers, nothing else
//   release/ban-cu/<version>/…                                             ← every older version's installers
//   release/_build/…                                                       ← electron-builder by-products
//                                                                            (win-unpacked, latest.yml, blockmap…)
// Safe to run any time; files that are locked (e.g. the unpacked app still running) are left where they are.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(root, 'release')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const OLD_DIR = 'ban-cu'
const BUILD_DIR = '_build'
const INSTALLER = /^SanoVids-(Setup|Portable)-(\d+\.\d+\.\d+)\.exe(\.blockmap)?$/
const BY_PRODUCTS = ['win-unpacked', 'latest.yml', 'builder-debug.yml', 'builder-effective-config.yaml', '.icon-ico']

if (!fs.existsSync(releaseDir)) {
  console.log('tidy-release: no release/ folder, nothing to do')
  process.exit(0)
}

function move(from, to) {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })
    fs.renameSync(from, to)
    return true
  } catch (e) {
    console.warn(`tidy-release: could not move ${path.relative(root, from)} (${e.code ?? e.message}) — left in place`)
    return false
  }
}

let moved = 0
for (const name of fs.readdirSync(releaseDir)) {
  const from = path.join(releaseDir, name)
  const m = INSTALLER.exec(name)
  if (m) {
    const [, , v, blockmap] = m
    if (v !== version) moved += move(from, path.join(releaseDir, OLD_DIR, v, name)) ? 1 : 0
    else if (blockmap) moved += move(from, path.join(releaseDir, BUILD_DIR, name)) ? 1 : 0
    continue
  }
  if (BY_PRODUCTS.includes(name)) moved += move(from, path.join(releaseDir, BUILD_DIR, name)) ? 1 : 0
}

// Older versions' blockmaps sitting in _build from previous runs belong with their installers.
const buildDir = path.join(releaseDir, BUILD_DIR)
if (fs.existsSync(buildDir)) {
  for (const name of fs.readdirSync(buildDir)) {
    const m = INSTALLER.exec(name)
    if (m && m[2] !== version) moved += move(path.join(buildDir, name), path.join(releaseDir, OLD_DIR, m[2], name)) ? 1 : 0
  }
}

fs.writeFileSync(
  path.join(releaseDir, 'DOC-TOI.txt'),
  [
    `SanoVids ${version} — file cài đặt`,
    '',
    `SanoVids-Setup-${version}.exe     Bộ cài (khuyên dùng): tạo icon ở Desktop / Start Menu, cài đè bản cũ được.`,
    `SanoVids-Portable-${version}.exe  Bấm là chạy, không cần cài (hợp chép USB).`,
    '',
    `${OLD_DIR}\\<phiên bản>\\   Các bản cũ (để thử lại khi cần).`,
    `${BUILD_DIR}\\              File phụ của quá trình build (win-unpacked…) — không cần đụng tới.`,
    '',
    'Lịch sử phiên bản: CHANGELOG.md · Tải trên GitHub: https://github.com/JameSteven404/sanovids/releases',
    '',
  ].join('\r\n'),
)
console.log(`tidy-release: ${moved} item(s) moved; newest installers (${version}) stay in release/`)

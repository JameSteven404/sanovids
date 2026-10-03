// Keeps release/ tidy after `npm run dist:win`:
//   release/SanoVids-Setup-<current>.exe, SanoVids-Portable-<current>.exe   ← the newest installers, nothing else
//   release/ban-cu/<version>/…                                             ← every older version's installers
//   release/_build/…                                                       ← electron-builder by-products
//                                                                            (win-unpacked, latest.yml, blockmap…)
// latest.yml and the current Setup blockmap stay in release/_build: scripts/publish-release.mjs uploads them to the
// public feed repo (auto-update). build/release-notes.md (scripts/update-notes.mjs) stays in build/, never in release/.
// Warns loudly when the packaged app-update.yml does not point at the public feed (installs would never update).
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
const FEED_OWNER = 'JameSteven404'
const FEED_REPO = 'sanovids-releases'
const RELEASES_URL = `https://github.com/${FEED_OWNER}/${FEED_REPO}/releases/latest`

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
    `SanoVids-Setup-${version}.exe     Bộ cài (khuyên dùng): tạo icon ở Desktop / Start Menu, cài đè bản cũ được, TỰ CẬP NHẬT các bản sau.`,
    `SanoVids-Portable-${version}.exe  Bấm là chạy, không cần cài (hợp chép USB). Bản này không tự cập nhật.`,
    '',
    `${OLD_DIR}\\<phiên bản>\\   Các bản cũ (để thử lại khi cần).`,
    `${BUILD_DIR}\\              File phụ của quá trình build (win-unpacked…) và file cập nhật (latest.yml, .blockmap) dùng khi đăng bản — không cần đụng tới.`,
    '',
    `Lịch sử phiên bản: CHANGELOG.md · Tải bản mới: ${RELEASES_URL}`,
    'Đăng bản mới: npm run release:publish (xem trước: npm run release:check)',
    '',
  ].join('\r\n'),
)
console.log(`tidy-release: ${moved} item(s) moved; newest installers (${version}) stay in release/`)

// The feed baked into the app (package.json build.publish → resources/app-update.yml). A build without it strands
// everyone who installs it, so shout — but do not fail: test builds may point elsewhere on purpose.
const feedFile = [path.join(buildDir, 'win-unpacked'), path.join(releaseDir, 'win-unpacked')]
  .map((dir) => path.join(dir, 'resources', 'app-update.yml'))
  .find((file) => fs.existsSync(file))
let feedText = ''
try {
  feedText = feedFile ? fs.readFileSync(feedFile, 'utf8') : ''
} catch {
  feedText = ''
}
const feedOk =
  /^provider:\s*github\s*$/m.test(feedText) &&
  new RegExp(`^owner:\\s*${FEED_OWNER}\\s*$`, 'm').test(feedText) &&
  new RegExp(`^repo:\\s*${FEED_REPO}\\s*$`, 'm').test(feedText) &&
  !/^(token|private|publisherName|channel):/m.test(feedText)
if (!feedOk) {
  const bar = '!'.repeat(78)
  const where = feedFile ? path.relative(root, feedFile) : 'release/_build/win-unpacked/resources/app-update.yml'
  console.warn(
    [
      '',
      bar,
      `!! WARNING: ${where} ${feedFile ? 'does NOT point at' : 'is missing — no'} the public update feed`,
      `!!   (provider github, owner ${FEED_OWNER}, repo ${FEED_REPO}; no token / private / publisherName / channel).`,
      '!!   Installs of this build would NEVER receive updates. Check package.json build.publish and rebuild.',
      '!!   Do not publish it (npm run release:check refuses it too).',
      bar,
      '',
    ].join('\n'),
  )
}

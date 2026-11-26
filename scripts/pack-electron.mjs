// Packaging wrapper for dist:win / dist:mac. Obfuscates the Electron main-process files (electron/*.cjs) in place,
// runs scripts/electron-build.mjs (which keeps the --publish never / timestamp guards), then ALWAYS restores the
// original sources — including on crash or Ctrl+C, so the working tree is never left obfuscated.
//
// Why in place (not a staging copy): the files are packed into app.asar and that asar's header hash is embedded in
// the signed exe (ASAR integrity fuse). So the obfuscated bytes must be what electron-builder reads at pack time.
// Normal dev (`electron .`, npm run desktop) never runs this script, so source stays readable there.
//
// Opt out with SANOVIDS_NO_MAIN_OBF=1 (renderer obfuscation is separate, via `vite build --mode release`).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAIN_OPTIONS, obfuscate } from './obfuscate.mjs'

const root = path.resolve(fileURLToPath(import.meta.url), '../..')
const electronDir = path.join(root, 'electron')
const backups = new Map() // absolute path -> original source text

function restore() {
  for (const [file, src] of backups) {
    try {
      fs.writeFileSync(file, src)
    } catch (e) {
      console.error(`pack-electron: KHÔNG khôi phục được ${file} — chạy "git checkout -- electron/" để lấy lại bản gốc. (${e?.message ?? e})`)
    }
  }
  backups.clear()
}

// Backstops: restore even if the process is killed or exits unexpectedly.
process.on('exit', restore)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(1) })

// preload.cjs passes functions (inPage, docs) to contextBridge.executeInMainWorld, which serializes them with
// .toString() and runs them in the page world WITHOUT their module closure. String-array / control-flow transforms
// add references to top-level obfuscator helpers that don't exist there → ReferenceError that breaks sanoDesktop at
// startup. So preload stays un-obfuscated (it's bridge glue; low value to obfuscate anyway).
const SKIP = new Set(['preload.cjs'])

function obfuscateMain() {
  const files = fs.readdirSync(electronDir).filter((f) => f.endsWith('.cjs') && !SKIP.has(f)).map((f) => path.join(electronDir, f))
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    backups.set(file, src)
    fs.writeFileSync(file, obfuscate(src, MAIN_OPTIONS))
  }
  console.log(`pack-electron: đã làm rối ${files.length} file main process.`)
}

function run() {
  return new Promise((resolve) => {
    const build = path.join(root, 'scripts', 'electron-build.mjs')
    const child = spawn(process.execPath, [build, ...process.argv.slice(2)], { stdio: 'inherit', shell: false })
    child.on('error', (e) => { console.error(`pack-electron: không chạy được electron-build (${e?.message ?? e}).`); resolve(1) })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

async function main() {
  const skip = process.env.SANOVIDS_NO_MAIN_OBF === '1'
  try {
    if (skip) console.log('pack-electron: SANOVIDS_NO_MAIN_OBF=1 — bỏ qua làm rối main process.')
    else obfuscateMain()
    const code = await run()
    process.exit(code)
  } finally {
    restore()
  }
}

main()

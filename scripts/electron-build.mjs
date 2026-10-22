// Runs electron-builder for release builds (npm run dist:win: `node scripts/electron-build.mjs --win nsis portable
// --publish never`) with the guarantees signed releases need:
//   - ELECTRON_BUILDER_DISABLE_BUILD_CACHE=true: electron-builder's exe cache key ignores electron fuses, so a cached
//     exe could ship with stale fuses;
//   - refuses ELECTRON_BUILDER_OFFLINE: electron-builder then signs WITHOUT an RFC 3161 timestamp and says nothing;
//   - refuses a command line without the adjacent pair `--publish never` (or with any other publish policy).
// The refusal logic is releaseLib.buildArgsProblem (tested in scripts/__tests__/releaseLib.test.mjs). Exits with
// electron-builder's exit code.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildArgsProblem } from './releaseLib.mjs'

export function releaseBuildProblem(env, args) {
  return Object.keys(env).some((k) => k.toUpperCase() === 'SANOVIDS_PERF')
    ? 'SANOVIDS_PERF không được phép trong bản phát hành.'
    : buildArgsProblem(env, args)
}

function main() {
  const args = process.argv.slice(2)
  const problem = buildArgsProblem(process.env, args) || releaseBuildProblem(process.env, args)
  if (problem) {
    console.error(`electron-build: ${problem}`)
    process.exit(1)
  }

  const require = createRequire(import.meta.url)
  const cli = require.resolve('electron-builder/cli.js')
  // Windows env names are case-insensitive: drop any other spelling before forcing the cache off.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'ELECTRON_BUILDER_DISABLE_BUILD_CACHE'))
  env.ELECTRON_BUILDER_DISABLE_BUILD_CACHE = 'true'

  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', shell: false, env })
  child.on('error', (e) => {
    console.error(`electron-build: không chạy được electron-builder (${e?.message ?? e}).`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

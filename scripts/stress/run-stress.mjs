#!/usr/bin/env node
// Long headless stress soak of SanoVids ("Test giới hạn", command line). No network: the simulated canvasapp only.
//
//   node scripts/stress/run-stress.mjs [--scenarios monkey,queue-flood | all] [--each] [--seed 7f3a91c2]
//        [--steps 2000] [--minutes 10] [--tier S|M|L|XL|XXL|OVER] [--faults none|sometimes|storm]
//        [--check 25] [--keep-going] [--replay path/to/report.json] [--shrink] [--out .stress/reports]
//
// Options map to the STRESS_* env variables read by src/devtools/stress/__tests__/soak.stress.ts (env variables
// set by the caller work too). Exit code: 0 = every run passed, ≠ 0 = a failure (see the report files).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

const FLAGS = {
  '--scenarios': 'STRESS_SCENARIOS',
  '--seed': 'STRESS_SEED',
  '--steps': 'STRESS_STEPS',
  '--minutes': 'STRESS_MINUTES',
  '--tier': 'STRESS_TIER',
  '--faults': 'STRESS_FAULTS',
  '--check': 'STRESS_CHECK',
  '--replay': 'STRESS_REPLAY',
  '--out': 'STRESS_OUT',
}
const SWITCHES = { '--each': 'STRESS_EACH', '--keep-going': 'STRESS_KEEP_GOING', '--shrink': 'STRESS_SHRINK' }

const env = { ...process.env }
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--help' || a === '-h') {
    console.log('Xem đầu tệp scripts/stress/run-stress.mjs để biết các tuỳ chọn.')
    process.exit(0)
  }
  const [flag, inline] = a.split('=', 2)
  if (flag in SWITCHES) env[SWITCHES[flag]] = '1'
  else if (flag in FLAGS) {
    const value = inline ?? args[++i]
    if (value === undefined) {
      console.error(`Thiếu giá trị cho ${flag}`)
      process.exit(2)
    }
    env[FLAGS[flag]] = value
  } else {
    console.error(`Tuỳ chọn không rõ: ${a}`)
    process.exit(2)
  }
}

// node_modules may live in a parent folder (a git worktree nested in the main checkout): look upwards like Node does.
function findVitest(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'node_modules/vitest/vitest.mjs')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return null
  }
}
const vitest = findVitest(root)
if (!vitest) {
  console.error('Không tìm thấy vitest (chạy `npm install` trước).')
  process.exit(2)
}
const child = spawn(process.execPath, [vitest, 'run', '--config', resolve(here, 'vitest.stress.config.mts')], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))

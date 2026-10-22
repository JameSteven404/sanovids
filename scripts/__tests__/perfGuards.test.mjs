import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPerfHarness } from '../buildInspect.mjs'
import { releaseBuildProblem } from '../electron-build.mjs'
import { parseArgs, perfBuildConfig } from '../perf/run-perf.mjs'
import viteConfig from '../../vite.config.ts'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const scratchRoot = path.join(root, '.perf')
await mkdir(scratchRoot, { recursive: true })
const scratch = await mkdtemp(path.join(scratchRoot, 'guards-'))
afterAll(async () => {
  const resolved = await realpath(scratch), parent = await realpath(scratchRoot)
  if (!resolved.startsWith(parent + path.sep) || !path.basename(resolved).startsWith('guards-')) throw new Error('Unsafe test cleanup')
  await rm(resolved, { recursive: true, force: true })
})
describe('release performance guards', () => {
  it('refuses every presence of SANOVIDS_PERF before starting electron-builder', () => {
    for (const value of ['1', '0', 'false', '']) for (const key of ['SANOVIDS_PERF', 'sanovids_perf'])
      expect(releaseBuildProblem({ [key]: value }, ['--publish', 'never'])).toContain('SANOVIDS_PERF')
    expect(releaseBuildProblem({}, ['--publish', 'never'])).toBeNull()
  })
  it('finds the marker in a lazy JS chunk inside an actual asar and fails closed on missing archives', async () => {
    const asar = require('@electron/asar')
    const input = path.join(scratch, 'app')
    await mkdir(path.join(input, 'dist/assets'), { recursive: true })
    await writeFile(path.join(input, 'dist/assets/lazy.js'), 'console.log("sanovids-perf-harness")')
    const archive = path.join(scratch, 'bad.asar')
    await asar.createPackage(input, archive)
    expect(inspectPerfHarness(archive).join(' ')).toContain('lazy.js')
    await writeFile(path.join(input, 'dist/assets/lazy.js'), 'console.log("release")')
    const clean = path.join(scratch, 'clean.asar')
    await asar.createPackage(input, clean)
    expect(inspectPerfHarness(clean)).toEqual([])
    expect(inspectPerfHarness(path.join(scratch, 'missing.asar'))).not.toEqual([])
  })
  it('disables probes in normal builds and isolates profiling builds', async () => {
    const old = process.env.SANOVIDS_PERF
    delete process.env.SANOVIDS_PERF
    try {
      for (const mode of ['production', 'perf']) {
        const config = await viteConfig({ mode, command: 'build' })
        expect(config.define.__SANOVIDS_PERF__).toBe(mode === 'perf')
        expect(config.build.outDir).toBe(mode === 'perf' ? '.perf/dist' : 'dist')
        expect(config.resolve.alias.length).toBe(mode === 'perf' ? 1 : 0)
        if (mode === 'perf') expect(config.resolve.alias[0].replacement).toBe('react-dom/profiling')
      }
      process.env.SANOVIDS_PERF = '1'
      expect((await viteConfig({ mode: 'development', command: 'serve' })).build.outDir).toBe('.perf/dist')
    } finally { if (old === undefined) delete process.env.SANOVIDS_PERF; else process.env.SANOVIDS_PERF = old }
  })
  it('builds only an unsigned test identity with a baked isolated profile and no release feed', () => {
    const original = { win: { forceCodeSigning: true, signtoolOptions: { certificateSha1: 'never-use' } }, directories: { output: 'release' } }
    const config = perfBuildConfig(original, 'E:\\scratch\\profile')
    expect(config.appId).toBe('com.sanovids.test.perf')
    expect(config.extraMetadata.sanovidsTestProfileDir).toBe('E:\\scratch\\profile')
    expect(config.win.signExecutable).toBe(false)
    expect(config.win.signtoolOptions).toBeUndefined()
    expect(config.publish).toBeNull()
    expect(config.directories.output).toBe('.perf/exe')
    expect(original.win.forceCodeSigning).toBe(true)
    expect(parseArgs(['--target', 'exe', '--size', 'XL', '--runs', '3', '--headed', '--trace'])).toMatchObject({ target: 'exe', size: 'XL', runs: 3, headed: true, trace: true })
    expect(() => parseArgs(['--runs', '0'])).toThrow()
    expect(() => parseArgs(['--target', 'release'])).toThrow()
  })
  it('tree-shakes the harness from real production chunks but retains it in perf chunks', async () => {
    const old = process.env.SANOVIDS_PERF
    delete process.env.SANOVIDS_PERF
    try {
      for (const mode of ['production', 'perf']) {
        const output = await build({ root, mode, configLoader: 'native', logLevel: 'silent', build: { outDir: path.join(scratch, mode), write: false } })
        const chunks = (Array.isArray(output) ? output : [output]).flatMap((o) => o.output ?? []).filter((f) => f.type === 'chunk')
        expect(chunks.some((f) => f.code.includes('sanovids-perf-harness'))).toBe(mode === 'perf')
        if (mode === 'production') {
          expect(chunks.some((f) => f.code.includes('bdp:perf:manifest'))).toBe(false)
          expect(chunks.flatMap((f) => Object.keys(f.modules)).filter((id) => /src[\\/]perf[\\/](?!probe\.ts)/.test(id))).toEqual([])
        }
      }
    } finally { if (old === undefined) delete process.env.SANOVIDS_PERF; else process.env.SANOVIDS_PERF = old }
  }, 120000)
})

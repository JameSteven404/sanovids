// scripts/build-sano.mjs (D240): what it takes from the SANO repo and where it writes. The build itself (git archive,
// npm ci, vite build of SANO) needs a SANO checkout and network: npm run build:sano.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SANO_BUILD_FILES, SANO_DIST, SANO_NOTICES, SANO_PIN } from '../build-sano.mjs'
import { SANO_AGENT } from '../releaseLib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = fs.readFileSync(path.join(root, 'scripts', 'build-sano.mjs'), 'utf8')

describe('build-sano', () => {
  it('takes only the files of SANO’s web build: never knowledge/, context/, the server or secrets', () => {
    expect([...SANO_BUILD_FILES]).toEqual(['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'login.html', 'public', 'web', 'shared'])
    expect(src).toContain("'archive', '--format=zip', '-o', zipFile, pin.commit, '--', ...SANO_BUILD_FILES]")
    // its own lockfile, no install scripts; a source map would ship the private source
    expect(src).toContain("'npm ci --ignore-scripts --no-audit --no-fund', 'npm run build'")
    expect(src).toMatch(/if \(maps\.length\) throw new Error/)
  })

  it('writes sano-dist/ (never dist/) and the notices the release checks read; both stay out of Git', () => {
    expect([SANO_PIN, SANO_DIST, SANO_NOTICES]).toEqual([SANO_AGENT.sanoPin, 'sano-dist', SANO_AGENT.notices])
    expect(src).toContain('const dest = path.join(ROOT, SANO_DIST)')
    expect(src).not.toContain("path.join(ROOT, 'dist')")
    // BUILD.json last: release:check:sano-agent compares its commit with the pin
    expect(src.lastIndexOf("'BUILD.json'")).toBeGreaterThan(src.indexOf('fs.cpSync(out, dest, { recursive: true })'))
    const ignored = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')
    expect(ignored).toContain('sano-dist/')
    expect(ignored).toContain(SANO_NOTICES)
  })
})

// Unit tests of the pure parts of scripts/mac-inspect.mjs (the inspection itself runs only on a Mac, as the last step of
// npm run dist:mac): reading the commit from .git without git, the CI context, codesign's ad-hoc details, entitlements
// compared by meaning, the tree hash that compares the app in the DMG / the zip / the build, and mac-check.json.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { buildMacCheck, checkCodesignDetails, ciContext, entitlementsFromCodesign, parseCodesignDetails, readGitCommit, treeHashOf } from '../mac-inspect.mjs'
import { MAC_CHECKS, checkMacCheck, checkMacEntitlements, macBuildFiles } from '../releaseLib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sanovids-macinspect-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** A fake repository folder with the given files under .git (or a .git FILE when `gitFile` is set). */
function repo(name, files, gitFile) {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
  }
  if (gitFile) fs.writeFileSync(path.join(dir, '.git'), gitFile)
  return dir
}

describe('readGitCommit (no git: on a fresh Mac /usr/bin/git opens an installer)', () => {
  it('HEAD → loose ref, HEAD → packed-refs, detached HEAD', () => {
    expect(readGitCommit(repo('loose', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${A}\n` }))).toBe(A)
    expect(readGitCommit(repo('packed', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/dev\n${A} refs/heads/main\n^${B}\n` }))).toBe(A)
    expect(readGitCommit(repo('detached', { '.git/HEAD': `${B}\n` }))).toBe(B)
    // a loose ref wins over packed-refs (git's own order)
    expect(readGitCommit(repo('both', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': A, '.git/packed-refs': `${B} refs/heads/main\n` }))).toBe(A)
  })

  it('a .git file (worktree) is followed, with commondir for the refs', () => {
    const common = repo('main-repo', { '.git/packed-refs': `${B} refs/heads/feature\n`, '.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n', '.git/worktrees/wt/commondir': '../..\n' })
    const wt = repo('wt', {}, `gitdir: ${path.join(common, '.git', 'worktrees', 'wt')}\n`)
    expect(readGitCommit(wt)).toBe(B)
  })

  it('anything odd → null (never throws)', () => {
    expect(readGitCommit(path.join(scratch, 'nowhere'))).toBeNull()
    expect(readGitCommit(repo('noref', { '.git/HEAD': 'ref: refs/heads/gone\n' }))).toBeNull()
    expect(readGitCommit(repo('garbage', { '.git/HEAD': 'hello\n' }))).toBeNull()
    expect(readGitCommit(repo('traversal', { '.git/HEAD': 'ref: refs/../../etc\n' }))).toBeNull()
    expect(readGitCommit(repo('short', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': 'abc\n' }))).toBeNull()
    // this very checkout reads like git does (a sha or null, never an exception)
    const own = readGitCommit(root)
    expect(own === null || /^[0-9a-f]{40}$/.test(own)).toBe(true)
  })
})

describe('ciContext', () => {
  it('GitHub Actions: the run, the event, rc from the workflow input; elsewhere a local build', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '4242', GITHUB_RUN_NUMBER: '12', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'JameSteven404/sanovids', GITHUB_SHA: A, SANOVIDS_MAC_RC: 'true' }
    expect(ciContext(env)).toEqual({
      source: 'ci',
      ci: { runId: 4242, runNumber: 12, runAttempt: 1, event: 'workflow_dispatch', ref: 'refs/heads/main', rc: true, repository: 'JameSteven404/sanovids', sha: A },
    })
    expect(ciContext({ ...env, SANOVIDS_MAC_RC: 'false', GITHUB_EVENT_NAME: 'push' }).ci).toMatchObject({ rc: false, event: 'push' })
    expect(ciContext({ ...env, GITHUB_RUN_ID: 'x', GITHUB_SHA: 'nope' }).ci).toMatchObject({ runId: null, sha: null })
    expect(ciContext({})).toEqual({ source: 'local', ci: null })
    expect(ciContext({ GITHUB_ACTIONS: 'false' })).toEqual({ source: 'local', ci: null })
  })
})

describe('codesign: an ad-hoc signature with the hardened runtime', () => {
  // `codesign -dv --verbose=4` of an electron-builder ad-hoc build (stderr)
  const ADHOC = `Executable=/Users/runner/work/sanovids/release/mac/mac-arm64/SanoVids.app/Contents/MacOS/SanoVids
Identifier=com.sanovids.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10002(adhoc,runtime) hashes=27+7 location=embedded
Hash type=sha256 size=32
CandidateCDHash sha256=0123456789abcdef0123456789abcdef01234567
Signature=adhoc
Info.plist entries=34
TeamIdentifier=not set
Runtime Version=14.0.0
Sealed Resources version=2 rules=13 files=95
Internal requirements count=0 size=12`

  it('parses and accepts the real thing', () => {
    const d = parseCodesignDetails(ADHOC)
    expect(d).toEqual({ signature: 'adhoc', identifier: 'com.sanovids.app', teamId: 'not set', flags: ['adhoc', 'runtime'] })
    expect(checkCodesignDetails(d)).toEqual([])
  })

  it('refuses a keychain identity picked by mistake, no hardened runtime, another bundle id', () => {
    const devId = ADHOC.replace('Signature=adhoc', 'Authority=Developer ID Application: Someone (ABCDE12345)').replace('flags=0x10002(adhoc,runtime)', 'flags=0x10000(runtime)').replace('TeamIdentifier=not set', 'TeamIdentifier=ABCDE12345')
    expect(checkCodesignDetails(parseCodesignDetails(devId))).toHaveLength(3)
    expect(checkCodesignDetails(parseCodesignDetails(ADHOC.replace('flags=0x10002(adhoc,runtime)', 'flags=0x2(adhoc)')))[0]).toMatch(/runtime/)
    expect(checkCodesignDetails(parseCodesignDetails(ADHOC.replace('Identifier=com.sanovids.app', 'Identifier=com.github.Electron')))).toHaveLength(1)
    expect(checkCodesignDetails(parseCodesignDetails(''))).toHaveLength(4)
    expect(checkCodesignDetails(null)).toHaveLength(1)
  })
})

describe('entitlements compared by meaning (codesign stores the plist without the repo file’s comments)', () => {
  it('the stored plist matches the commented repo file; one key more fails', () => {
    const stored = `Executable=/x/SanoVids.app/Contents/MacOS/SanoVids
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>`
    expect(checkMacEntitlements(entitlementsFromCodesign(stored))).toEqual([])
    expect(checkMacEntitlements(entitlementsFromCodesign(fs.readFileSync(path.join(root, 'build', 'entitlements.mac.plist'), 'utf8')))).toEqual([])
    const more = stored.replace('</dict>', '<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict>')
    expect(checkMacEntitlements(entitlementsFromCodesign(more))[0]).toMatch(/allow-unsigned-executable-memory/)
    expect(() => entitlementsFromCodesign('Executable=/x\n(no entitlements)')).toThrow()
  })
})

describe('treeHashOf (app in the DMG = app in the zip = the built app)', () => {
  const entries = [
    { path: 'Contents', type: 'dir', mode: 0o40755 },
    { path: 'Contents/MacOS/SanoVids', type: 'file', mode: 0o100755, sha256: 'a'.repeat(64) },
    { path: 'Contents/Frameworks/Electron Framework.framework/Versions/Current', type: 'link', mode: 0o120755, target: 'A' },
  ]
  it('ignores listing order, sees contents, permissions and symlink targets', () => {
    const h = treeHashOf(entries)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(treeHashOf([...entries].reverse())).toBe(h)
    expect(treeHashOf([entries[0], { ...entries[1], sha256: 'b'.repeat(64) }, entries[2]])).not.toBe(h)
    expect(treeHashOf([entries[0], { ...entries[1], mode: 0o100644 }, entries[2]])).not.toBe(h)
    expect(treeHashOf([entries[0], entries[1], { ...entries[2], target: 'B' }])).not.toBe(h)
    expect(treeHashOf([entries[0], entries[1]])).not.toBe(h)
    // a symlink replaced by a copy (a zip made without -y) is another tree
    expect(treeHashOf([entries[0], entries[1], { path: entries[2].path, type: 'dir', mode: 0o40755 }])).not.toBe(h)
  })
})

describe('mac-check.json', () => {
  it('buildMacCheck writes what publish-release (k) reads; every check is listed', () => {
    const files = macBuildFiles('0.6.0').map((name, i) => ({ name, sha512: `${'x'.repeat(86)}==`, size: i + 1 }))
    const ci = { runId: 4242, runNumber: 12, runAttempt: 1, event: 'workflow_dispatch', ref: 'refs/heads/main', rc: true }
    const all = Object.fromEntries(MAC_CHECKS.map((k) => [k, true]))
    const report = buildMacCheck({ version: '0.6.0', commit: A, dirty: false, source: 'ci', ci, files, checks: all, problems: [] })
    expect(Object.keys(report)).toEqual(['v', 'version', 'commit', 'dirty', 'source', 'ci', 'files', 'checks', 'problems'])
    expect(Object.keys(report.checks)).toEqual([...MAC_CHECKS])
    const local = Object.fromEntries(files.map((f) => [f.name, { sha512: f.sha512, size: f.size }]))
    expect(checkMacCheck(report, { version: '0.6.0', commit: A, files: local })).toEqual([])
    // a missing check is false, never true; odd values are normalised
    const partial = buildMacCheck({ version: '0.6.0', commit: 'nope', dirty: 'yes', source: 'local', ci, files, checks: { codesign: true }, problems: 'x' })
    expect(partial).toMatchObject({ commit: null, dirty: null, ci: null, problems: [] })
    expect(Object.values(partial.checks).filter(Boolean)).toHaveLength(1)
    expect(checkMacCheck(partial, { version: '0.6.0', commit: A, files: local }).length).toBeGreaterThanOrEqual(3)
  })
})

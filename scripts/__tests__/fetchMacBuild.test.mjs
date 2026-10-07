// Unit tests of scripts/fetch-mac-build.mjs (npm run mac:fetch): the required --run, the gh argv, the run and the
// downloaded mac-check.json it accepts, and the mac-fetch.json record publish-release group (k) then demands. No gh, no
// network: the impure part only runs from the command line.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAC_WORKFLOW, checkFetchedCheck, ghRunDownloadArgs, ghRunListArgs, macFetchRecord, parseFetchArgs } from '../fetch-mac-build.mjs'
import { MAC_CHECKS, PRIVATE_REPO, checkMacFetch, checkMacRun, macArtifactName, macBuildFiles } from '../releaseLib.mjs'

const V = '0.6.0'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const sha512 = (s) => createHash('sha512').update(s).digest('base64')
const RUN = { databaseId: 4242, number: 12, attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', headBranch: 'main', headSha: A, displayTitle: 'mac-build RC · main', workflowName: 'mac-build' }
const FIVE = [...macBuildFiles(V), 'mac-check.json']
const files = FIVE.map((name, i) => ({ name, sha512: sha512(name), size: 100 + i, sha256: 'f'.repeat(64) }))
const local = Object.fromEntries(files.map((f) => [f.name, { sha512: f.sha512, size: f.size }]))
const check = {
  v: 1,
  version: V,
  commit: A,
  dirty: false,
  source: 'ci',
  ci: { runId: 4242, runNumber: 12, runAttempt: 1, event: 'workflow_dispatch', ref: 'refs/heads/main', rc: true },
  files: files.slice(0, 4).map(({ name, sha512: s, size }) => ({ name, sha512: s, size })),
  checks: Object.fromEntries(MAC_CHECKS.map((k) => [k, true])),
  problems: [],
}

describe('--run is required (the run you tested, never "the latest")', () => {
  it('accepts --run N and --run=N only', () => {
    expect(parseFetchArgs(['--run', '12'])).toEqual({ run: 12 })
    expect(parseFetchArgs(['--run=7'])).toEqual({ run: 7 })
    expect(parseFetchArgs([]).error).toMatch(/Thiếu --run/)
    expect(parseFetchArgs(['--run']).error).toMatch(/--run cần số/)
    for (const bad of [['--run', '0'], ['--run', '-3'], ['--run', 'latest'], ['--run', '1.5'], ['--run=']]) expect(parseFetchArgs(bad).error, bad.join(' ')).toMatch(/--run cần số/)
    expect(parseFetchArgs(['--run', '12', '--latest']).error).toMatch(/Tham số lạ/)
    expect(parseFetchArgs(null).error).toMatch(/Thiếu --run/)
  })
})

describe('gh argv (args array, no shell)', () => {
  it('lists the workflow runs of the private repo, downloads one named artifact', () => {
    expect(MAC_WORKFLOW).toBe('mac-build.yml')
    expect(ghRunListArgs()).toEqual(['run', 'list', '-R', PRIVATE_REPO, '--workflow', 'mac-build.yml', '--limit', '200', '--json', 'databaseId,number,attempt,event,status,conclusion,headBranch,headSha,displayTitle,workflowName'])
    expect(ghRunDownloadArgs({ runId: 4242, name: macArtifactName(V, 12), dir: 'release/mac/.fetch-4242' })).toEqual([
      'run',
      'download',
      '4242',
      '-R',
      PRIVATE_REPO,
      '-n',
      'sanovids-mac-0.6.0-12',
      '-D',
      'release/mac/.fetch-4242',
    ])
  })
})

describe('the run: a manual RC on main at the expected commit, finished and green', () => {
  it('refuses push / smoke runs, another commit, a failed run, a missing run', () => {
    expect(checkMacRun(RUN, { runNumber: 12, headSha: A })).toEqual([])
    expect(checkMacRun({ ...RUN, event: 'push', displayTitle: 'mac-build thử · mac-ci/x', headBranch: 'mac-ci/x' }, { runNumber: 12, headSha: A })).toHaveLength(3)
    expect(checkMacRun({ ...RUN, displayTitle: 'mac-build thử · main' }, { runNumber: 12, headSha: A })).toHaveLength(1) // dispatched without rc
    expect(checkMacRun(RUN, { runNumber: 12, headSha: B })).toHaveLength(1)
    expect(checkMacRun({ ...RUN, conclusion: 'cancelled' }, { runNumber: 12, headSha: A })).toHaveLength(1)
    expect(checkMacRun(undefined, { runNumber: 12, headSha: A })).toHaveLength(1)
  })

  it('the downloaded mac-check.json must come from that very run, as an RC', () => {
    expect(checkFetchedCheck(check, RUN)).toEqual([])
    expect(checkFetchedCheck({ ...check, ci: { ...check.ci, runId: 1 } }, RUN)[0]).toMatch(/lần chạy 1/)
    expect(checkFetchedCheck({ ...check, ci: { ...check.ci, rc: false } }, RUN)).toHaveLength(1)
    expect(checkFetchedCheck({ ...check, ci: { ...check.ci, event: 'push' } }, RUN)).toHaveLength(1)
    expect(checkFetchedCheck({ ...check, source: 'local', ci: null }, RUN)).toHaveLength(1)
    expect(checkFetchedCheck(null, RUN)).toHaveLength(1)
  })
})

describe('mac-fetch.json → publish-release (k)', () => {
  it('the record of the run passes checkMacFetch with the same bytes, fails when a file is swapped afterwards', () => {
    const record = macFetchRecord(RUN, files, new Date('2026-10-10T08:00:00Z'))
    expect(record).toEqual({
      v: 1,
      runId: 4242,
      runNumber: 12,
      runAttempt: 1,
      event: 'workflow_dispatch',
      rc: true,
      headBranch: 'main',
      headSha: A,
      conclusion: 'success',
      fetchedAt: '2026-10-10T08:00:00.000Z',
      files: files.map(({ name, sha512: s, size }) => ({ name, sha512: s, size })),
    })
    const ctx = { version: V, commit: A, check, files: local }
    expect(checkMacFetch(record, ctx)).toEqual([])
    const swapped = { ...local, 'SanoVids-Mac-0.6.0-arm64.dmg': { sha512: sha512('another dmg'), size: 100 } }
    expect(checkMacFetch(record, { ...ctx, files: swapped })[0]).toMatch(/SHA-512 của SanoVids-Mac-0\.6\.0-arm64\.dmg khác file trên máy/)
    // fetched for the right run, but the tag moved to another commit since
    expect(checkMacFetch(record, { ...ctx, commit: B })).toHaveLength(1)
  })
})

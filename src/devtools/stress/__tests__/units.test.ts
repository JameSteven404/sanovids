// Unit tests of the stress tester's building blocks (rng, corpus, generator, invariants, report) + static guards on
// its sources (safety rules of the task: no network targets, no dev-mode reset, no perf-harness import, no vitest in
// app code, only allowed bare imports).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRng, parseSeed, randomSeed, at } from '../rng'
import { cpLength, textOfLength, edgeName } from '../corpus'
import { generateProject, TIER_SIZE, imageIdOf } from '../synth'
import { allowlistBreach, checkProject, checkStructural, isSubsequence, videoTokens, checkMigrate } from '../invariants'
import { summaryText, toMarkdown, toJSON, reportFileName } from '../report'
import { SCENARIOS, SCENARIO_BY_ID } from '../scenarios'
import { ACTION_BY_ID } from '../actions'
import { checkExplicitRewrite, expectedFilmTake, expectedNodeFull, expectedPlayerOp, fillKeyProblem, replaceKeyProblem, transportMismatches } from '../featureActions'
import { groupKeyOf, groupOf, planFill, planReplace } from '../../../core/placeholders'
import { nodeFullKey, transportKey } from '../../../core/transportKeys'
import type { Asset, Project, Take } from '../../../core/types'
import type { StressReport } from '../types'

describe('rng', () => {
  it('parses seeds', () => {
    expect(parseSeed(' 7F3A91C2 ')).toBe('7f3a91c2')
    expect(parseSeed('xyz')).toBeNull()
    expect(parseSeed(12)).toBeNull()
    expect(parseSeed(randomSeed())).not.toBeNull()
  })
  it('is deterministic per seed and label', () => {
    const a = createRng('0badf00d')
    const b = createRng('0badf00d')
    const xs = Array.from({ length: 20 }, () => a.raw())
    expect(Array.from({ length: 20 }, () => b.raw())).toEqual(xs)
    const f1 = createRng('0badf00d').fork('server')
    const f2 = createRng('0badf00d').fork('server')
    const f3 = createRng('0badf00d').fork('corpus')
    expect(f1.raw()).toBe(f2.raw())
    expect(createRng('0badf00d').fork('server').raw()).not.toBe(f3.raw())
  })
  it('weighted never picks weight ≤ 0', () => {
    const r = createRng('00c0ffee')
    for (let i = 0; i < 500; i++) expect([1, 3]).toContain(r.weighted([0, 2, -1, 5]))
    expect(r.weighted([0, 0])).toBe(-1)
    expect(at([], 3)).toBeUndefined()
    expect(at(['a', 'b'], -3)).toBe('b')
  })
})

describe('corpus', () => {
  it('textOfLength gives exactly n code points (trimmed)', () => {
    const r = createRng('12345678')
    for (const n of [1, 10, 999, 1000, 1001, 5000]) expect(cpLength(textOfLength(r, n))).toBe(n)
  })
  it('edge names are strings (possibly hostile)', () => {
    const r = createRng('12345678')
    for (let i = 0; i < 100; i++) expect(typeof edgeName(r)).toBe('string')
  })
})

describe('synth', () => {
  it('generates the tier size with valid, unique ids', () => {
    const g = generateProject(createRng('a1b2c3d4'), 'a1b2c3d4', 'S', 'generated')
    expect(g.project.scenes).toHaveLength(TIER_SIZE.S.scenes)
    expect(g.project.assets).toHaveLength(TIER_SIZE.S.assets)
    expect(g.takes.length).toBeGreaterThan(0)
    expect(checkProject(g.project, g.takes).filter((v) => v.severity === 'error')).toEqual([])
    for (const id of g.imageIds) expect(id).toMatch(/^[A-Za-z0-9_-]{1,60}$/)
    expect(imageIdOf('a1b2c3d4', 1)).toMatch(/^[A-Za-z0-9_-]{1,60}$/)
    expect(checkMigrate(JSON.parse(JSON.stringify(g.project))).filter((v) => v.severity === 'error')).toEqual([])
  })
  it('is deterministic', () => {
    const a = generateProject(createRng('a1b2c3d4'), 'a1b2c3d4', 'S', 'legacy-video')
    const b = generateProject(createRng('a1b2c3d4'), 'a1b2c3d4', 'S', 'legacy-video')
    expect(JSON.stringify(b.project.scenes)).toBe(JSON.stringify(a.project.scenes))
  })
})

describe('invariants', () => {
  const base = (): Project => {
    const p = generateProject(createRng('5eed5eed'), '5eed5eed', 'S', 'generated').project
    const [a1, a2] = p.assets
    const assets = p.assets.map((a, i) => (i === 0 ? { ...a, imageIds: ['i1'] } : i === 1 ? { ...a, imageIds: ['i2'] } : a))
    const scenes = p.scenes.map((s, i) => (i === 0 ? { ...s, refs: [a1.id, a2.id], prompt: 'Mở @image_1 rồi @image_2 kết' } : s))
    return { ...p, assets, scenes, settings: { ...p.settings, autoRenumber: true } }
  }
  const withScene0 = (p: Project, patch: Partial<Project['scenes'][number]>): Project => ({ ...p, scenes: p.scenes.map((s, i) => (i === 0 ? { ...s, ...patch } : s)) })

  it('P3: a token that now names another picture is caught', () => {
    const p = base()
    const swapped = withScene0(p, { refs: [...p.scenes[0].refs].reverse() })
    expect(checkStructural(p, swapped, 'test').map((v) => v.invariant)).toContain('P3')
  })
  it('P3: renumbered tokens that follow the pictures pass', () => {
    const p = base()
    const ok = withScene0(p, { refs: [...p.scenes[0].refs].reverse(), prompt: 'Mở @image_2 rồi @image_1 kết' })
    expect(checkStructural(p, ok, 'test')).toEqual([])
  })
  it('X1: lost prompt text is caught', () => {
    const p = base()
    const lost = withScene0(p, { prompt: 'Mở @image_1 kết' })
    expect(checkStructural(p, lost, 'test').map((v) => v.invariant)).toContain('X1')
  })
  it('X2: changed @video tokens are a warning (error when strict)', () => {
    const p = withScene0(base(), { prompt: 'Mở @image_1 rồi @image_2 kết @video_1' })
    const q = withScene0(p, { prompt: 'Mở @image_1 rồi @image_2 kết video' })
    expect(checkStructural(p, q, 'test').find((v) => v.invariant === 'X2')?.severity).toBe('warning')
    expect(checkStructural(p, q, 'test', true).find((v) => v.invariant === 'X2')?.severity).toBe('error')
    expect(videoTokens('a @video_1 b @VIDEO_?2')).toEqual(['@video_1', '@VIDEO_?2'])
  })
  it('P1 / P2: order gaps and dangling refs are caught', () => {
    const p = base()
    const gap = { ...p, scenes: p.scenes.map((s, i) => (i === 3 ? { ...s, order: 99 } : s)) }
    expect(checkProject(gap, []).map((v) => v.invariant)).toContain('P1')
    const dangling = withScene0(p, { refs: ['ast_missing'] })
    expect(checkProject(dangling, []).map((v) => v.invariant)).toContain('P2')
  })
  it('isSubsequence', () => {
    expect(isSubsequence('ace', 'abcde')).toBe(true)
    expect(isSubsequence('aec', 'abcde')).toBe(false)
  })
})

describe('S2 on the request log (allowlistBreach)', () => {
  const stream = '/api/video-jobs/j1/stream'
  it('a request refused as outside the allowlist is a breach', () => {
    const seen = new Set<string>()
    expect(allowlistBreach({ fault: 'not-allowed', endpoint: null, path: '/api/admin' }, seen)).toBe(true)
    // the video stream asked through canvasapp:request (never allowed there) is one too
    expect(allowlistBreach({ fault: 'not-allowed', endpoint: 'job-stream', path: stream }, seen)).toBe(true)
    expect(allowlistBreach({ fault: null, endpoint: 'jobs', path: '/api/video-jobs' }, seen)).toBe(false)
  })
  it('the gateway refusing an injected redirect to plain http of that download is not — once per redirect', () => {
    const seen = new Set<string>()
    expect(allowlistBreach({ fault: 'http-redirect', endpoint: 'job-stream', path: stream }, seen)).toBe(false)
    expect(allowlistBreach({ fault: 'not-allowed', endpoint: 'job-stream', path: stream }, seen)).toBe(false)
    expect(allowlistBreach({ fault: 'not-allowed', endpoint: 'job-stream', path: stream }, seen)).toBe(true)
    // another path's redirect excuses nothing here
    expect(allowlistBreach({ fault: 'http-redirect', endpoint: 'job-stream', path: '/api/video-jobs/j2/stream' }, seen)).toBe(false)
    expect(allowlistBreach({ fault: 'not-allowed', endpoint: 'job-stream', path: stream }, seen)).toBe(true)
  })
  it('...also when modifiers fired with the redirect (the server joins the labels: "slow 3000ms + http-redirect")', () => {
    const seen = new Set<string>()
    expect(allowlistBreach({ fault: 'slow 3000ms + http-redirect', endpoint: 'job-stream', path: stream }, seen)).toBe(false)
    expect(allowlistBreach({ fault: 'not-allowed', endpoint: 'job-stream', path: stream }, seen)).toBe(false)
    expect(allowlistBreach({ fault: 'not-allowed', endpoint: 'job-stream', path: stream }, seen)).toBe(true)
    // a label that only looks like it does not count
    expect(allowlistBreach({ fault: 'http-redirect-ish', endpoint: 'job-stream', path: stream }, seen)).toBe(false)
    expect(allowlistBreach({ fault: 'not-allowed', endpoint: 'job-stream', path: stream }, seen)).toBe(true)
  })
})

describe('scenarios & report', () => {
  it('explicit fills may replace token labels, but never prose or the number of tokens', () => {
    expect(checkExplicitRewrite('ệ @image_?2(Lumi) 👩‍👩‍👧‍👦', 'ệ @image_1 👩‍👩‍👧‍👦')).toBe(true)
    expect(checkExplicitRewrite('ệ @image_?2(Lumi) cuối', '@image_1 cuối')).toBe(false)
    expect(checkExplicitRewrite('ệ @image_?2(Lumi) cuối', 'ệ Lumi cuối')).toBe(false)
  })
  it('P3 of an explicit fill: only the filled group changes picture', () => {
    const assets = ['a1', 'a2', 'a3'].map((id, i) => ({ id, kind: 'character', name: id, tag: id, description: '', imageIds: [`img${i + 1}`], color: '', position: null }) as Asset)
    const before = { prompt: 'A @image_1 B @image_?2(Lumi) C @image_2', refs: ['a1', 'a2'] }
    const members = new Set(groupOf(before.prompt, assets, before.refs, groupKeyOf('@image_?2(Lumi)'))!.members.map((m) => m.start))
    // the app's own fill (the character goes at the removed one's place, the other tokens renumber)
    const plan = planFill(before, assets, groupKeyOf('@image_?2(Lumi)'), 'a3', { renumber: true, maxImages: 9 })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(fillKeyProblem(before, { prompt: plan.prompt, refs: plan.refs }, assets, members, 'a3')).toBeNull()
    expect(fillKeyProblem(before, { prompt: 'A @image_1 B @image_2 C @image_3', refs: ['a1', 'a3', 'a2'] }, assets, members, 'a3')).toBeNull()
    // the filled character inserted in front without renumbering: @image_1 now names another picture
    expect(fillKeyProblem(before, { prompt: 'A @image_1 B @image_1 C @image_3', refs: ['a3', 'a1', 'a2'] }, assets, members, 'a3')).toContain('Token ảnh thứ 1')
    // the placeholder filled with another character's picture
    expect(fillKeyProblem(before, { prompt: 'A @image_1 B @image_1 C @image_2', refs: ['a1', 'a2'] }, assets, members, 'a3')).toContain('Chữ đỏ thứ 2')
  })
  it('P3 of a replacement: picture k of the old character becomes picture k of the new one, nothing else moves', () => {
    const assets = [
      { id: 'a1', imageIds: ['p1', 'p2'] },
      { id: 'a2', imageIds: ['q1'] },
      { id: 'a3', imageIds: ['r1'] },
    ].map((a) => ({ kind: 'character', name: a.id, tag: a.id, description: '', color: '', position: null, ...a }) as Asset)
    const before = { prompt: '@image_1 và @image_2 với @image_3', refs: ['a1', 'a2'] }
    const plan = planReplace(before, assets, 'a1', 'a3', { renumber: true, maxImages: 9 })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(replaceKeyProblem(before, { prompt: plan.prompt, refs: plan.refs }, assets, 'a1', 'a3')).toBeNull()
    // a2's token renumbered to the wrong slot
    expect(replaceKeyProblem(before, { prompt: '@image_1 và @image_?2(a1 · ảnh 2) với @image_1', refs: ['a3', 'a2'] }, assets, 'a1', 'a3')).toContain('Token ảnh thứ 3')
    // a1's second picture has no counterpart in a3: it must turn red, not name another picture
    expect(replaceKeyProblem(before, { prompt: '@image_1 và @image_2 với @image_2', refs: ['a3', 'a2'] }, assets, 'a1', 'a3')).toContain('Token ảnh thứ 2')
  })
  it('transport keys: the app follows the written plan; a rule that ignores the focus is caught', () => {
    expect(transportMismatches()).toEqual([])
    const ignoresFocus = { playerKey: (e: Parameters<typeof transportKey>[0], _f: unknown, ctx: Parameters<typeof transportKey>[1]) => transportKey(e, ctx), nodeFullKey }
    expect(transportMismatches(['KeyJ'], ignoresFocus).some((m) => m.includes('typing'))).toBe(true)
    expect(transportMismatches(['Space'], ignoresFocus).some((m) => m.includes('control-key'))).toBe(true)
    expect(expectedPlayerOp('ArrowUp', 'none', 'film')).toBe('clip-prev')
    expect(expectedNodeFull('ArrowUp', 'none')).toEqual({ kind: 'op', op: 'volume-up' })
  })
  it('the film plays the newest starred finished take, else the newest finished one', () => {
    const t = (id: string, number: number, status: Take['status'], starred = false) => ({ id, number, status, starred }) as Take
    expect(expectedFilmTake([t('a', 1, 'completed'), t('b', 3, 'completed'), t('c', 4, 'failed')])?.id).toBe('b')
    expect(expectedFilmTake([t('a', 1, 'completed', true), t('b', 3, 'completed')])?.id).toBe('a')
    expect(expectedFilmTake([t('a', 1, 'completed', true), t('b', 3, 'failed', true)])?.id).toBe('a')
    expect(expectedFilmTake([t('c', 4, 'queued')])).toBeNull()
  })
  it('every scenario only weights known actions', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(18)
    for (const s of SCENARIOS) {
      expect(SCENARIO_BY_ID.get(s.id)).toBe(s)
      for (const id of Object.keys(s.weights)) expect(ACTION_BY_ID.has(id), `${s.id} → ${id}`).toBe(true)
    }
  })
  it('formats a report', () => {
    const r: StressReport = {
      v: 1,
      app: { version: '0.0.0', build: 'headless' },
      seed: '7f3a91c2',
      startedAt: 0,
      durationMs: 1234,
      steps: 10,
      spec: { scenarios: ['monkey'], tier: 'S', steps: 10, maxMs: 0, faults: 'none', checkEvery: 5, stopOnFirst: true, expectVideoRetired: false, tokenKeep: false },
      result: 'fail',
      failure: { step: 7, action: 'refs.unlink', args: {}, invariant: 'P3', kind: 'app', message: 'Lệch nhân vật' },
      warnings: [{ invariant: 'D1', count: 2, firstStep: 3, message: 'tên trống' }],
      ring: [],
      log: [],
      metrics: { perAction: { 'refs.unlink': { n: 3, p50: 1, p95: 2, max: 3 } }, longFrames: [], heap: [], dom: [], slowSteps: [] },
      server: { jobs: 0, uploads: 0, balance: 0, faultsArmed: 0, requests: 0 },
      guards: {},
      notes: [],
    }
    expect(summaryText(r)).toContain('7f3a91c2')
    expect(toMarkdown(r)).toContain('P3')
    expect(JSON.parse(toJSON(r)).seed).toBe('7f3a91c2')
    expect(reportFileName(r, 'md')).toBe('sanovids-stress-7f3a91c2-fail.md')
  })
})

describe('static safety guards on the stress sources', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(name)) files.push(full)
    }
  }
  walk(root)
  const app = files.filter((f) => !/[\\/]__tests__[\\/]/.test(f))

  it('finds the sources', () => {
    expect(app.length).toBeGreaterThan(8)
  })
  it.each(app.map((f) => [f.slice(root.length)]))('%s', (rel) => {
    const src = readFileSync(join(root, rel), 'utf8')
    expect(src).not.toMatch(/resetDevMode/)
    expect(src).not.toMatch(/from ['"][./]*\/perf\b|src\/perf/)
    expect(src).not.toMatch(/https?:\/\//)
    expect(src).not.toMatch(/from ['"]vitest['"]/)
    expect(src).not.toMatch(/beforeunload/)
    expect(src.charCodeAt(0)).not.toBe(0xfeff)
    for (const m of src.matchAll(/from ['"]([^'"./][^'"]*)['"]/g)) expect(['react', 'zustand', 'zustand/react/shallow', 'lucide-react']).toContain(m[1])
  })
})

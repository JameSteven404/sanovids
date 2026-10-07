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
import { checkProject, checkStructural, isSubsequence, videoTokens, checkMigrate } from '../invariants'
import { summaryText, toMarkdown, toJSON, reportFileName } from '../report'
import { SCENARIOS, SCENARIO_BY_ID } from '../scenarios'
import { ACTION_BY_ID } from '../actions'
import type { Project } from '../../../core/types'
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

describe('scenarios & report', () => {
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

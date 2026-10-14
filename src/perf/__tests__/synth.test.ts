import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planRowSpacing, showsOldLayout } from '../../components/canvas/rowSpacing'
import { LAYOUT, ROW_H } from '../../store/project'
import { TIER_SIZE } from '../../devtools/stress/synth'
import { libraryFixture, SIZES, SYNTH_LAYOUT, SYNTH_MAX, synthProject } from '../synth'

describe('deterministic synthetic projects', () => {
  it('repeats byte-for-byte, changes with the seed, and matches all tiers', () => {
    const small = { scenes: 20, takes: 40 }
    expect(synthProject(small)).toEqual(synthProject(small))
    expect(synthProject(small, 7)).not.toEqual(synthProject(small))
    for (const spec of Object.values(SIZES)) {
      const { project, runs } = synthProject(spec)
      expect(project.scenes).toHaveLength(spec.scenes)
      expect(runs.takes).toHaveLength(spec.takes)
      expect(project.schemaVersion).toBe(2)
      expect(project.presets.map((p) => p.name)).toEqual(['Nháp', 'Final'])
      expect(project.folders?.every((f) => f.path === null && !f.takes?.length && !f.autoScenes?.length)).toBe(true)
      const assets = new Set(project.assets.map((a) => a.id)), takes = new Set(runs.takes.map((t) => t.id))
      for (const scene of project.scenes) {
        expect(scene.prompt.length).toBeGreaterThanOrEqual(2000)
        expect(scene.prompt.length).toBeLessThanOrEqual(6000)
        expect(scene.refs.length).toBeGreaterThanOrEqual(2)
        expect(scene.refs.length).toBeLessThanOrEqual(3)
        expect(scene.refs.every((id) => assets.has(id))).toBe(true)
        expect(scene.videoRefs).toEqual([])
        expect((scene.legacyVideoRefs ?? []).every((id) => takes.has(id))).toBe(true)
        expect(scene.prompt.includes('@video_1')).toBe(scene.order % 10 === 0)
      }
      expect(runs.takes.every((t) => t.id.startsWith('prf_') && t.provider === 'dev' && t.status === 'completed')).toBe(true)
    }
  })
  it('is laid out for the 0.6.0 node: the canvas never runs its one-time row spacing on it (no undo step / toast in a run)', () => {
    expect(SYNTH_LAYOUT).toEqual({
      scenesX: LAYOUT.scenesX, scenesY: LAYOUT.scenesY, rowH: ROW_H, sceneW: LAYOUT.sceneW, assetX: LAYOUT.assetX,
      tileStep: LAYOUT.assetH + LAYOUT.assetGapY, takeOffsetX: LAYOUT.takeOffsetX, takeStep: LAYOUT.takeW + LAYOUT.takeGapX,
    })
    for (const spec of [{ scenes: 20, takes: 40 }, SIZES.M]) {
      const { project } = synthProject(spec)
      expect(showsOldLayout(project)).toBe(false)
      expect(planRowSpacing({ scenes: project.scenes, assets: project.assets, folders: project.folders, takes: [] }).changed).toBe(false)
    }
  })
  it('bounds custom input before allocating', () => {
    for (const spec of [{ scenes: 0, takes: 0 }, { scenes: 3001, takes: 6000 }, { scenes: 1, takes: 6001 }, { scenes: 2, takes: 1 }, { scenes: NaN, takes: 2 }]) {
      expect(() => synthProject(spec)).toThrow()
    }
    expect(SYNTH_MAX).toEqual(SIZES.XXL)
    expect(() => synthProject({ scenes: SYNTH_MAX.scenes, takes: SYNTH_MAX.scenes })).not.toThrow()
  })
  it('lets the Hiệu năng panel start every tier and the largest custom size (no stale E2 hint)', () => {
    const panel = readFileSync('src/components/dev/DevPerfTab.tsx', 'utf8')
    const vi = (n: number) => n.toLocaleString('vi-VN')
    for (const [size, spec] of Object.entries(SIZES)) {
      expect(panel).toMatch(new RegExp(`<option value="${size}">[^<]*· ${vi(spec.scenes)} cảnh · ${vi(spec.takes)} video</option>`))
    }
    expect(panel).toContain('max={SYNTH_MAX.scenes}')
    expect(panel).toContain('max={SYNTH_MAX.takes}')
    expect(panel).not.toMatch(/chờ giao diện E2/)
  })
  it('documents that its XXL (3,000 scenes) is not the stress tester\'s XXL (2,000 scenes)', () => {
    expect(SIZES.XXL.scenes).toBe(3000)
    expect(TIER_SIZE.XXL.scenes).toBe(2000)
    expect(readFileSync('scripts/perf/README.md', 'utf8')).toMatch(/XXL[^\n]*3\.000 cảnh[^\n]*stress[^\n]*2\.000/)
  })
  it('adds exactly 200 unused library cards without allocating unjournalled media or changing scenes', () => {
    const { project } = synthProject(SIZES.M)
    const fixture = libraryFixture(project)
    expect(fixture.scenes).toBe(project.scenes)
    expect(project.assets).toHaveLength(12)
    expect(fixture.assets).toHaveLength(212)
    expect(new Set(fixture.assets.map((a) => a.id)).size).toBe(212)
    expect(fixture.assets.slice(-200).every((a) => a.position === null && a.imageIds === project.assets[0].imageIds)).toBe(true)
  })
})

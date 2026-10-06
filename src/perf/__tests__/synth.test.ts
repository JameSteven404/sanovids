import { describe, expect, it } from 'vitest'
import { SIZES, synthProject } from '../synth'

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
        expect(scene.videoRefs.every((id) => takes.has(id))).toBe(true)
        expect(scene.prompt.includes('@video_1')).toBe(scene.order % 10 === 0)
      }
      expect(runs.takes.every((t) => t.id.startsWith('prf_') && t.provider === 'dev' && t.status === 'completed')).toBe(true)
    }
  })
  it('bounds custom input before allocating', () => {
    for (const spec of [{ scenes: 0, takes: 0 }, { scenes: 2001, takes: 4002 }, { scenes: 1, takes: 6001 }, { scenes: 2, takes: 1 }, { scenes: NaN, takes: 2 }]) {
      expect(() => synthProject(spec)).toThrow()
    }
  })
})

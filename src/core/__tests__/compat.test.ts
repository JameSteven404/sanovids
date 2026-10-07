import { describe, expect, it } from 'vitest'
import { segmentPrompt } from '../../components/inspector/tokens'
import { validateRequest } from '../../providers/canvasapp/mapping'
import type { JobRequest } from '../../providers/types'
import { compileScene, imageKey, imageSlots, parseTokens, retiredVideoTokens } from '../compile'
import { FOREIGN_RUNNING_ERROR, migrateProject, migrateTake } from '../migrate'
import { MODELS, normalizeSettings } from '../models'
import { isRedTextBlock, runBlock } from '../runRules'
import { compatFixtures, jsonCopy } from './fixtures/compat'

describe.each(compatFixtures)('$source.version compatibility', (fixture) => {
  it('migrates, validates and compiles every scene without changing picture identity or authored data', () => {
    const raw = jsonCopy(fixture.autosave.project)
    const before = JSON.stringify(raw)
    const project = migrateProject(raw)
    expect(JSON.stringify(raw)).toBe(before)
    expect(project.schemaVersion).toBe(2)
    expect(project.assets).toEqual(raw.assets)
    expect(project.assets[1].name).toBe('Làng bên sông')
    expect(project.presets).toEqual(raw.presets)
    expect(project.settings.autoRenumber).toBe('autoRenumber' in raw.settings ? raw.settings.autoRenumber : true)
    expect(project.scenes.map((s) => s.prompt)).toEqual(fixture.expected.prompts)
    expect(project.scenes.map((s) => s.order)).toEqual([1, 2, 3])
    expect(new Set([...project.assets, ...project.scenes].map((x) => x.id)).size).toBe(5)
    expect(project).toMatchObject({ id: raw.id, name: raw.name, createdAt: raw.createdAt, updatedAt: raw.updatedAt })
    if ('folders' in raw) expect(project.folders).toEqual(raw.folders)
    else expect(project).not.toHaveProperty('folders')

    project.scenes.forEach((scene, index) => {
      const old = raw.scenes[index]
      const keys = fixture.expected.imageKeys[index]
      expect(scene).toMatchObject({ id: old.id, title: old.title, refs: old.refs, note: old.note,
        settings: old.settings, presetId: old.presetId, position: old.position, firstFrame: old.firstFrame, lastFrame: old.lastFrame })
      expect(scene.settings).toEqual(normalizeSettings(scene.settings))
      expect(scene.size).toEqual('size' in old ? old.size : undefined)
      expect(MODELS[scene.settings.model]).toBeDefined()
      expect(scene.refs.every((id) => project.assets.some((a) => a.id === id))).toBe(true)
      expect(scene.videoRefs).toEqual([])
      expect(scene.legacyVideoRefs).toEqual('videoRefs' in old && old.videoRefs.length ? old.videoRefs : undefined)
      expect(imageSlots(project, scene).map(imageKey)).toEqual(keys)
      const compiled = compileScene(project, scene)
      expect(compiled.text).toBe(fixture.expected.prompts[index].trim())
      expect(compiled.images.map(imageKey)).toEqual(keys)
      expect(compiled).not.toHaveProperty('videos')
      for (const token of parseTokens(compiled.text).filter((t) => t.kind === 'image')) {
        const image = compiled.images.find((i) => i.n === token.n)
        expect(image, compiled.text.slice(token.start, token.end)).toBeDefined()
        expect(imageKey(image!)).toBe(keys[token.n - 1])
      }
      const retired = retiredVideoTokens(scene.prompt).map((t) => t.text)
      expect(compiled.retiredTokens).toEqual(retired)
      const segments = segmentPrompt(scene.prompt, keys.length)
      expect(segments.map((s) => s.text).join('')).toBe(scene.prompt)
      expect(segments.filter((s) => s.kind === 'video').map((s) => s.text)).toEqual(retired)
      for (const seg of segments.filter((s) => s.kind === 'video')) expect(seg).toMatchObject({ invalid: true, reason: 'retired' })
      const block = runBlock({ scene, assets: project.assets, compiled })
      if (retired.length) {
        expect(compiled.unsentTokens).toEqual(retired)
        expect(block?.kind).toBe('retired')
        expect(isRedTextBlock(block)).toBe(true)
      } else {
        expect(block).toBeNull()
        expect(compiled.unsentTokens).toEqual([])
      }
    })
    expect(migrateProject(jsonCopy(project))).toEqual(project)
  })

  it('keeps every take status, snapshot, media key and billing field through repeated JSON saves', () => {
    const raw = jsonCopy(fixture.autosave.runs)
    const takes = raw.takes.map(migrateTake)
    expect(takes.map((t) => t.status)).toEqual(['queued', 'processing', 'completed', 'failed', 'cancelled'])
    takes.forEach((take, index) => {
      const old = raw.takes[index]
      // Only retired video links leave their original field; every other saved field must survive exactly.
      const { videoRefsSnapshot, ...kept } = old as typeof old & { videoRefsSnapshot?: string[] }
      expect(take).toMatchObject(kept)
      expect(take.videoRefsSnapshot).toEqual([])
      expect(take.legacyVideoRefsSnapshot).toEqual(videoRefsSnapshot?.length ? videoRefsSnapshot : undefined)
      expect(take.provider).toBe('provider' in old ? old.provider : 'mock')
      expect(take.charged).toBe('charged' in old ? old.charged : true)
      expect(take).not.toHaveProperty('imported')
      expect(take).not.toHaveProperty('foreignModel')
      expect(take).not.toHaveProperty('foreignProvider')
      // The provider's pure preflight also refuses old queued snapshots containing retired video text.
      if (retiredVideoTokens(take.promptSnapshot).length) {
        const req: JobRequest = { ...take.settings, key: take.id, takeId: take.id, sceneId: take.sceneId,
          sanovidsProjectId: fixture.autosave.project.id, sceneCode: 'S02', takeNumber: take.number,
          title: 'Trở về', color: '', prompt: take.promptSnapshot, rawPrompt: take.rawPromptSnapshot,
          images: [], firstFrame: null, lastFrame: null, startedAt: take.startedAt ?? 0 }
        expect(validateRequest(req).some((e) => e.includes('@video_1'))).toBe(true)
      }
    })
    let saved = { ...raw, takes }
    for (let i = 0; i < 3; i++) {
      const loaded = jsonCopy(saved)
      saved = { ...loaded, takes: loaded.takes.map(migrateTake) }
      expect(saved).toEqual({ ...raw, takes })
    }
  })
})

it('keeps old bare placeholders and new labelled placeholders red through a save/load', () => {
  for (const token of ['@image_?4', '@image_?4(Lumi)']) {
    const raw = jsonCopy(compatFixtures[4].autosave.project)
    raw.scenes[0].prompt += `\nChờ ${token}.`
    const project = migrateProject(raw)
    const scene = project.scenes[0]
    const compiled = compileScene(project, scene)
    expect(scene.prompt).toBe(raw.scenes[0].prompt)
    expect(compiled.unsentTokens).toEqual([token])
    expect(isRedTextBlock(runBlock({ scene, assets: project.assets, compiled }))).toBe(true)
    expect(segmentPrompt(scene.prompt, 3).find((s) => s.text === token)).toMatchObject({ invalid: true, reason: 'unbound' })
    expect(migrateProject(jsonCopy(project))).toEqual(project)
  }
})

it('keeps post-release imported/foreign markers without attributing them to a 0.5.0 writer', () => {
  const fixture = compatFixtures[4]
  const imported = { at: 1791320000000, jobName: 'Video 9', unknown: ['prompt', 'refs'], inferred: ['duration'] }
  const take = migrateTake({ ...fixture.autosave.runs.takes[1], imported, charged: false })
  expect(take.imported).toEqual(imported)
  expect(migrateTake(jsonCopy(take))).toEqual(take)
  const settings = { model: 'future-model', mode: 't2v', duration: 8, resolution: '4k', ratio: '21:9' }
  const raw = jsonCopy(fixture.autosave.project)
  const project = migrateProject({ ...raw, scenes: [{ ...raw.scenes[0], settings }], presets: [{ ...raw.presets[0], ...settings }] })
  expect(project.scenes[0]).toMatchObject({ foreignModel: settings.model, foreignSettings: settings })
  expect(project.presets[0]).toMatchObject({ foreignModel: settings.model, foreignSettings: settings })
  expect(runBlock({ scene: project.scenes[0], assets: project.assets, compiled: compileScene(project, project.scenes[0]) })?.kind).toBe('foreign')
  expect(migrateProject(jsonCopy(project))).toEqual(project)
  const foreign = migrateTake({ ...fixture.autosave.runs.takes[1], settings, provider: 'future-provider', charged: true })
  expect(foreign).toMatchObject({ status: 'failed', foreignStatus: 'processing', foreignCharged: true,
    foreignProvider: 'future-provider', foreignModel: settings.model, error: FOREIGN_RUNNING_ERROR, charged: false })
  expect(migrateTake(jsonCopy(foreign))).toEqual(foreign)
})

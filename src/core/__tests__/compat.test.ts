import { describe, expect, it } from 'vitest'
import { segmentForScene, segmentPrompt } from '../../components/inspector/tokens'
import { validateRequest } from '../../providers/canvasapp/mapping'
import type { JobRequest } from '../../providers/types'
import { compileScene, imageKey, imageSlots, parseTokens, retiredVideoTokens } from '../compile'
import { FOREIGN_RUNNING_ERROR, migrateProject, migrateTake, tagsToTokens } from '../migrate'
import { MODELS, normalizeSettings, usesRefs } from '../models'
import { isRedTextBlock, runBlock } from '../runRules'
import type { ModelId, Mode } from '../types'
import { compatFixtures, HISTORICAL_FACTORY_PRESETS, jsonCopy, v1Fixture } from './fixtures/compat'

describe.each(compatFixtures)('$source.version compatibility', (fixture) => {
  it('migrates, validates and compiles every scene without changing picture identity or authored data', () => {
    const raw = jsonCopy(fixture.autosave.project)
    const before = JSON.stringify(raw)
    const project = migrateProject(raw)
    expect(JSON.stringify(raw)).toBe(before)
    expect(project.schemaVersion).toBe(2)
    expect(project.assets).toEqual(raw.assets)
    expect(project.assets[1].name).toBe('Làng bên sông')
    // Every old project holds the factory presets as its build wrote them, one of them edited by the user, and a scene
    // linked to "Nháp". The factory-name migration (core/factoryPresets renameFactoryPresets + Project.presetNames):
    // untouched factory presets get their 0.6 names, the edited one and the user's own presets stay as saved, nothing
    // but a name changes, and the mark is written once (kept through export / import / reopen: compatPersist.test).
    const unnamed = (list: typeof raw.presets) => list.map(({ name: _name, ...rest }) => rest)
    expect(unnamed(project.presets)).toEqual(unnamed(raw.presets))
    const oldFactory = Object.fromEntries(raw.presets.filter((p) => p.id in HISTORICAL_FACTORY_PRESETS).map((p) => [p.id, p]))
    const factory = Object.fromEntries(project.presets.filter((p) => p.id in HISTORICAL_FACTORY_PRESETS).map((p) => [p.id, p]))
    expect(Object.keys(factory)).toEqual(Object.keys(HISTORICAL_FACTORY_PRESETS))
    expect(oldFactory.preset_draft.name).toBe(HISTORICAL_FACTORY_PRESETS.preset_draft)
    expect(oldFactory.preset_h3.name).toBe(HISTORICAL_FACTORY_PRESETS.preset_h3)
    expect(factory.preset_draft.name).toBe('Bản nháp')
    expect(factory.preset_h3.name).toBe('H3 từ ảnh')
    // edited by the user (renamed, or its settings changed): never a factory preset to rename
    expect(oldFactory.preset_final.name !== HISTORICAL_FACTORY_PRESETS.preset_final || oldFactory.preset_final.duration !== 15).toBe(true)
    expect(factory.preset_final).toEqual(oldFactory.preset_final)
    expect(project.presets.filter((p) => !(p.id in HISTORICAL_FACTORY_PRESETS))).toEqual(raw.presets.filter((p) => !(p.id in HISTORICAL_FACTORY_PRESETS)))
    expect(project.presetNames).toBe(2)
    expect(project.scenes[0].presetId).toBe('preset_draft')
    expect(project.settings.autoRenumber).toBe('autoRenumber' in raw.settings ? raw.settings.autoRenumber : true)
    expect(project.scenes.map((s) => s.prompt)).toEqual(fixture.expected.prompts)
    expect(project.scenes.map((s) => s.order)).toEqual(raw.scenes.map((_, i) => i + 1))
    expect(new Set([...project.assets, ...project.scenes].map((x) => x.id)).size).toBe(raw.assets.length + raw.scenes.length)
    expect(project).toMatchObject({ id: raw.id, name: raw.name, createdAt: raw.createdAt, updatedAt: raw.updatedAt })
    if ('folders' in raw) expect(project.folders).toEqual(raw.folders)
    else expect(project).not.toHaveProperty('folders')

    project.scenes.forEach((scene, index) => {
      const old = raw.scenes[index]
      const keys = fixture.expected.imageKeys[index]
      const sent = fixture.expected.sentImageKeys[index]
      expect(scene).toMatchObject({ id: old.id, title: old.title, refs: old.refs, note: old.note,
        settings: old.settings, presetId: old.presetId, position: old.position, firstFrame: old.firstFrame, lastFrame: old.lastFrame })
      expect(scene.settings).toEqual(normalizeSettings(scene.settings))
      expect(scene.size).toEqual('size' in old ? old.size : undefined)
      expect(MODELS[scene.settings.model]).toBeDefined()
      expect(scene.refs.every((id) => project.assets.some((a) => a.id === id))).toBe(true)
      expect(scene.videoRefs).toEqual([])
      expect(scene.legacyVideoRefs).toEqual('videoRefs' in old && old.videoRefs.length ? old.videoRefs : undefined)
      expect(imageSlots(project, scene).map(imageKey)).toEqual(keys)
      // The pictures a request carries: the model's mode and cap decide (H3 transform sends none, H3 i2v at most 9).
      expect(sent).toEqual(usesRefs(scene.settings) ? keys.slice(0, MODELS[scene.settings.model].maxRefImages) : [])
      const compiled = compileScene(project, scene)
      expect(compiled.text).toBe(fixture.expected.prompts[index].trim())
      expect(compiled.images.map(imageKey)).toEqual(sent)
      expect(compiled).not.toHaveProperty('videos')
      for (const token of parseTokens(compiled.text).filter((t) => t.kind === 'image')) {
        const image = compiled.images.find((i) => i.n === token.n)
        expect(image, compiled.text.slice(token.start, token.end)).toBeDefined()
        expect(imageKey(image!)).toBe(keys[token.n - 1])
      }
      const retired = retiredVideoTokens(scene.prompt).map((t) => t.text)
      expect(compiled.retiredTokens).toEqual(retired)
      const segments = segmentForScene(scene.prompt, project.assets, scene.refs, { sentImages: compiled.images.length })
      expect(segments.map((s) => s.text).join('')).toBe(scene.prompt)
      expect(segments.filter((s) => s.kind === 'video').map((s) => s.text)).toEqual(retired)
      for (const seg of segments.filter((s) => s.kind === 'video')) expect(seg).toMatchObject({ invalid: true, reason: 'retired' })
      // Every token that is not sent is drawn red where it stands, and nothing else is.
      expect(segments.filter((s) => s.invalid).map((s) => s.text)).toEqual(fixture.expected.unsent[index])
      expect(compiled.unsentTokens).toEqual(fixture.expected.unsent[index])
      const block = runBlock({ scene, assets: project.assets, compiled })
      expect(block?.kind ?? null).toBe(fixture.expected.blocks[index])
      if (block) expect(isRedTextBlock(block)).toBe(true)
      if (retired.length) expect(block?.kind).toBe('retired')
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
    const fixture = compatFixtures[4]
    const raw = jsonCopy(fixture.autosave.project)
    raw.scenes[0].prompt += `\nChờ ${token}.`
    const project = migrateProject(raw)
    const scene = project.scenes[0]
    const compiled = compileScene(project, scene)
    expect(scene.prompt).toBe(raw.scenes[0].prompt)
    // next to the scene's own red text (0.5.0: a description glued to a token, "@image_1(cô gái)")
    expect([...compiled.unsentTokens].sort()).toEqual([...fixture.expected.unsent[0], token].sort())
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

describe('v1 prompts: what the v1 compiler sent', () => {
  // v1.json "expected.v1Sent" / "v1Generated" are the texts the ae04bea compiler produced for these scenes (run once,
  // offline, stored as data): the body + enabled blocks with mentions replaced, plus the generated "References…"
  // paragraph and "Continue directly from the previous scene…" line (autoReferences / autoContinuity, v1's defaults).
  const { v1Sent, v1Generated } = v1Fixture.expected

  it('migrates every scene to exactly what v1 sent without the generated paragraphs (documented removal)', () => {
    const project = migrateProject(jsonCopy(v1Fixture.autosave.project))
    expect(v1Fixture.autosave.project.settings).toMatchObject({ autoReferences: true, autoContinuity: true })
    expect(v1Generated.flat().length).toBeGreaterThan(0)
    project.scenes.forEach((scene, i) => {
      const own = v1Sent[i].split('\n\n').filter((part) => !(v1Generated[i] as string[]).includes(part))
      expect(own.join('\n\n')).toBe(scene.prompt)
      expect(scene.prompt).not.toMatch(/References \(upload|Continue directly from the previous scene/)
    })
    // the generator settings are gone, nothing left that could add them back
    expect(project.settings).toEqual({ autoRenumber: true })
    expect(project).not.toHaveProperty('blocks')
    expect(project.scenes.some((s) => 'continueFrom' in s || 'blockOverrides' in s)).toBe(false)
    // takes keep what v1 really sent, generated paragraphs included
    for (const take of v1Fixture.autosave.runs.takes.map(migrateTake)) {
      expect(take.promptSnapshot).toBe(v1Sent[project.scenes.findIndex((s) => s.id === take.sceneId)])
    }
  })

  it('keeps an asset name where v1 sent no picture for the mention (mode without references, past the model cap)', () => {
    const project = migrateProject(jsonCopy(v1Fixture.autosave.project))
    const [, , transform, capped] = project.scenes
    // MiniMax-H3 transform sent no reference image: v1 wrote the names, the scene still runs.
    expect(transform.prompt).toBe('Chuyển từ cận cảnh Lumi sang toàn cảnh Làng bên sông.')
    // MiniMax-H3 i2v sent 9 pictures: @Lang is picture 9 (sent), Lumi's first picture is 10 (not sent → its name).
    expect(capped.prompt).toContain('@image_1 cho @image_9, Lumi đứng giữa.')
    expect(capped.prompt.startsWith('Ánh sáng dịu trên Lumi.')).toBe(true)
    for (const scene of [transform, capped]) {
      const compiled = compileScene(project, scene)
      expect(compiled.unsentTokens).toEqual([])
      expect(runBlock({ scene, assets: project.assets, compiled })).toBeNull()
    }
  })

  it('follows the v1 rule for every model and mode (the reported H3 t2v / transform block)', () => {
    const raw = jsonCopy(v1Fixture.autosave.project)
    const cases: [ModelId, Mode, string][] = [
      ['seedance_2_5', 't2v', '@image_1 chạy qua @image_3, @image_4 ở xa.'],
      ['minimax_h3', 'i2v', '@image_1 chạy qua @image_3, @image_4 ở xa.'],
      ['minimax_h3', 't2v', 'Lumi chạy qua Làng bên sông, Bảng màu ở xa.'],
      ['minimax_h3', 'transform', 'Lumi chạy qua Làng bên sông, Bảng màu ở xa.'],
    ]
    for (const [model, mode, want] of cases) {
      const settings = normalizeSettings({ model, mode })
      const scene = { ...raw.scenes[2], refs: ['lumi', 'village', 'moodboard'], prompt: '@Lumi chạy qua @Lang, @BangMau ở xa.', settings, blockOverrides: { before: false, after: false } }
      const project = migrateProject({ ...raw, scenes: [scene] })
      expect(project.scenes[0].prompt, `${model} ${mode}`).toBe(want)
      const compiled = compileScene(project, project.scenes[0])
      expect(compiled.unsentTokens, `${model} ${mode}`).toEqual([])
      expect(migrateProject(jsonCopy(project))).toEqual(project)
    }
    // the cap boundary, on both models
    const assets = migrateProject(raw).assets
    const refs = ['moodboard', 'village', 'lumi']
    expect(tagsToTokens('@Lang @Lumi', assets, refs, { model: 'minimax_h3', mode: 'i2v' })).toBe('@image_9 Lumi')
    expect(tagsToTokens('@Lang @Lumi', assets, refs, { model: 'seedance_2_5', mode: 't2v' })).toBe('@image_9 @image_10')
    // without settings (other callers): every linked asset with a picture gets its slot, as before
    expect(tagsToTokens('@Lang @Lumi', assets, refs)).toBe('@image_9 @image_10')
    // a v2 prompt is never rewritten, whatever its mode
    const v2 = migrateProject({ ...raw, schemaVersion: 2, scenes: [{ ...raw.scenes[2], prompt: '@Lumi ở @Lang.' }] })
    expect(v2.scenes[0].prompt).toBe('@Lumi ở @Lang.')
  })
})

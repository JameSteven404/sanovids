// "Đồng bộ nhân vật": the image each @image_N in the sent prompt refers to must be exactly the image sent as the
// N-th reference — from compiling the prompt, through the queue, to the canvasapp request. These tests pin that chain.
import { describe, expect, it } from 'vitest'
import { compileScene, extractMentions, imageKey, imageSlotsFor, remapTokens } from '../core/compile'
import type { Asset, Project, Scene } from '../core/types'
import { toVideoJobBody } from '../providers/canvasapp/mapping'
import type { JobRequest } from '../providers/types'
import { requestImages } from '../store/runs'

const asset = (id: string, name: string, imageIds: string[]): Asset => ({ id, kind: 'character', name, tag: name, description: '', imageIds, color: '#fff', position: null })

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  order: 1,
  title: '',
  prompt: '@image_1 hugs @image_2 in front of @image_3',
  refs: ['elara', 'lumi', 'village'],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
  ...over,
})

const project = (assets: Asset[], scenes: Scene[]): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets,
  scenes,
})

/** What the queue captures when the user presses Chạy (same moment, same project state). */
function enqueueSnapshot(p: Project, s: Scene) {
  const compiled = compileScene(p, s)
  return { promptSnapshot: compiled.text, refsSnapshot: [...s.refs], imageKeysSnapshot: imageSlotsFor(p.assets, s.refs).map(imageKey), compiled }
}

const request = (prompt: string, images: JobRequest['images']): JobRequest => ({
  key: 't1', takeId: 't1', sceneId: 's1', sanovidsProjectId: 'p', sceneCode: 'S01', takeNumber: 1, title: '', color: '#fff',
  model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9',
  prompt, rawPrompt: prompt, images, videos: [], firstFrame: null, lastFrame: null, startedAt: 0,
})

/** Which character each @image_N of the sent prompt points to, through canvasapp upload_ids. */
function charactersSent(prompt: string, images: JobRequest['images'], assets: Asset[]) {
  const uploadOf = (imageId: string) => 'up_' + imageId
  const body = toVideoJobBody(request(prompt, images), { projectId: 'bridge', uploadIdFor: uploadOf })
  const ownerOfUpload = new Map(assets.flatMap((a) => a.imageIds.map((id) => ['up_' + id, a.name] as const)))
  // also resolve uploads of images that were removed from the library meanwhile
  for (const img of images) if (!ownerOfUpload.has(uploadOf(img.imageId))) ownerOfUpload.set(uploadOf(img.imageId), img.assetId)
  const sent = body.upload_ids ?? [] // Seedance always sends upload_ids (missing → every token reads '(none)')
  return [...prompt.matchAll(/@image_(\d+)/g)].map((m) => ownerOfUpload.get(sent[Number(m[1]) - 1]) ?? '(none)')
}

describe('character sync: @image_N ↔ image sent', () => {
  const base = [asset('elara', 'Elara', ['e1']), asset('lumi', 'Lumi', ['l1']), asset('village', 'Village', ['v1'])]

  it('sends upload_ids in @image_N order', () => {
    const p = project(base, [scene()])
    const snap = enqueueSnapshot(p, p.scenes[0])
    const images = requestImages(snap, p.assets, 30)
    expect(charactersSent(snap.promptSnapshot, images, p.assets)).toEqual(['Elara', 'Lumi', 'Village'])
  })

  it('stays correct when a character gets an extra image while the take waits in the queue', () => {
    const p = project(base, [scene()])
    const snap = enqueueSnapshot(p, p.scenes[0])
    // user adds a 2nd image to Elara before the job is submitted → numbering in the library shifts
    const edited = [asset('elara', 'Elara', ['e1', 'e2']), base[1], base[2]]
    const images = requestImages(snap, edited, 30)
    expect(charactersSent(snap.promptSnapshot, images, edited)).toEqual(['Elara', 'Lumi', 'Village'])
  })

  it('stays correct when images are reordered or a character is removed while queued', () => {
    const p = project(base, [scene()])
    const snap = enqueueSnapshot(p, p.scenes[0])
    const reordered = [asset('elara', 'Elara', ['e9', 'e1']), base[2]] // Lumi deleted, Elara got a new first image
    const images = requestImages(snap, reordered, 30)
    // the take still sends exactly the images it was compiled with (Lumi's blob → adapter fails loudly if gone)
    expect(images.map((i) => i.imageId)).toEqual(['e1', 'l1', 'v1'])
    expect(charactersSent(snap.promptSnapshot, images, reordered)).toEqual(['Elara', 'lumi', 'Village'])
  })

  it('multi-image characters: every image keeps its own number', () => {
    const assets = [asset('elara', 'Elara', ['e1', 'e2']), asset('lumi', 'Lumi', ['l1'])]
    const s = scene({ refs: ['elara', 'lumi'], prompt: 'face @image_1, outfit @image_2, friend @image_3' })
    const p = project(assets, [s])
    const snap = enqueueSnapshot(p, s)
    const images = requestImages(snap, assets, 30)
    expect(images.map((i) => [i.n, i.imageId])).toEqual([
      [1, 'e1'],
      [2, 'e2'],
      [3, 'l1'],
    ])
    expect(charactersSent(snap.promptSnapshot, images, assets)).toEqual(['Elara', 'Elara', 'Lumi'])
  })

  it('legacy @Tag mentions are compiled to the right number before sending', () => {
    const p = project(base, [scene({ prompt: '@Lumi sleeps next to @Elara' })])
    const snap = enqueueSnapshot(p, p.scenes[0])
    expect(snap.promptSnapshot).toBe('@image_2 sleeps next to @image_1')
    expect(charactersSent(snap.promptSnapshot, requestImages(snap, p.assets, 30), p.assets)).toEqual(['Lumi', 'Elara'])
  })

  it('takes queued by older versions (no image snapshot) fall back to the refs snapshot', () => {
    const p = project(base, [scene()])
    const snap = enqueueSnapshot(p, p.scenes[0])
    const images = requestImages({ refsSnapshot: snap.refsSnapshot }, p.assets, 30)
    expect(charactersSent(snap.promptSnapshot, images, p.assets)).toEqual(['Elara', 'Lumi', 'Village'])
  })

  it('the model image cap never renumbers the images that are sent', () => {
    const many = Array.from({ length: 12 }, (_, i) => asset('a' + i, 'C' + i, ['i' + i]))
    const s = scene({ refs: many.map((a) => a.id), prompt: '@image_1 and @image_9', settings: { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' } })
    const p = project(many, [s])
    const snap = enqueueSnapshot(p, s)
    const images = requestImages(snap, many, 9) // MiniMax-H3 sends at most 9
    expect(images).toHaveLength(9)
    expect(charactersSent(snap.promptSnapshot, images, many)).toEqual(['C0', 'C8'])
  })
})

describe('character sync: tokens without an image never run', () => {
  const base = [asset('elara', 'Elara', ['e1']), asset('lumi', 'Lumi', ['l1'])]

  it('blocks @image_N beyond the images actually sent (model cap)', () => {
    const many = Array.from({ length: 12 }, (_, i) => asset('a' + i, 'C' + i, ['i' + i]))
    const s = scene({ refs: many.map((a) => a.id), prompt: '@image_1 meets @image_10', settings: { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' } })
    const out = compileScene(project(many, [s]), s)
    expect(out.images).toHaveLength(9)
    expect(out.unsentTokens).toEqual(['@image_10'])
    expect(out.warnings.some((w) => w.includes('@image_10') && w.includes('không được gửi'))).toBe(true)
  })

  it('blocks image tokens in a mode that sends no images, and unbound placeholders', () => {
    const t2v = scene({ refs: ['elara'], prompt: '@image_1 walks', settings: { model: 'minimax_h3', mode: 't2v', duration: 5, resolution: '768p', ratio: '16:9' } })
    expect(compileScene(project(base, [t2v]), t2v).unsentTokens).toEqual(['@image_1'])
    const pending = scene({ refs: ['elara'], prompt: '@image_1 and @image_?2' })
    expect(compileScene(project(base, [pending]), pending).unsentTokens).toEqual(['@image_?2'])
  })

  it('an out-of-range token does not start pointing at an image linked later', () => {
    // @image_3 typed while the scene has 2 images → after an edit that renumbers, it becomes a placeholder
    const before = mediaKeysFor(base, ['elara', 'lumi'])
    const after = mediaKeysFor([asset('elara', 'Elara', ['e1', 'e2']), base[1]], ['elara', 'lumi'])
    const out = remapTokens('@image_1 @image_2 @image_3', before, after, () => 'x')
    expect(out.text).toBe('@image_1 @image_3 @image_?3')
  })

  it('"write first, link later": numbers typed ahead bind to the characters linked next, in order', () => {
    const empty = mediaKeysFor(base, [])
    const one = mediaKeysFor(base, ['elara'])
    const two = mediaKeysFor(base, ['elara', 'lumi'])
    const step1 = remapTokens('@image_1 hugs @image_2', empty, one, () => 'x')
    expect(step1.text).toBe('@image_1 hugs @image_2') // @image_2 still waits (invalid until linked)
    const step2 = remapTokens(step1.text, one, two, () => 'x')
    expect(step2.text).toBe('@image_1 hugs @image_2')
    const p = project(base, [scene({ prompt: step2.text, refs: ['elara', 'lumi'] })])
    expect(charactersSent(step2.text, requestImages(enqueueSnapshot(p, p.scenes[0]), p.assets, 30), p.assets)).toEqual(['Elara', 'Lumi'])
  })

  it('a typed-ahead number never binds to an extra picture of a character already linked', () => {
    const before = mediaKeysFor(base, ['elara'])
    const after = mediaKeysFor([asset('elara', 'Elara', ['e1', 'e2']), base[1]], ['elara'])
    expect(remapTokens('@image_1 and @image_2', before, after, () => 'x').text).toBe('@image_1 and @image_?2')
  })

  it('changing only reference videos leaves typed-ahead image numbers alone', () => {
    const before = { images: mediaKeysFor(base, ['elara']).images, videos: [] }
    const after = { images: before.images, videos: ['t1'] }
    expect(remapTokens('@image_1 @image_2 @video_1', before, after, () => 'x').text).toBe('@image_1 @image_2 @video_1')
  })
})

function mediaKeysFor(assets: Asset[], refs: string[]) {
  return { images: imageSlotsFor(assets, refs).map(imageKey), videos: [] as string[] }
}

describe('character sync: tokens written as "@Image 1" / "@image1" (prompts written elsewhere)', () => {
  const base = [asset('elara', 'Elara', ['e1']), asset('lumi', 'Lumi', ['l1']), asset('village', 'Village', ['v1'])]

  it('are numbered tokens: validated, highlighted as tokens, never legacy @Tags', () => {
    const s = scene({ prompt: '@Image 1 hugs @image2 near @IMAGE_3, then @Image 5' })
    const out = compileScene(project(base, [s]), s)
    expect(out.text).toBe('@Image 1 hugs @image2 near @IMAGE_3, then @Image 5')
    expect(out.unsentTokens).toEqual(['@image_5'])
    expect(extractMentions(s.prompt)).toEqual([])
  })

  it('are renumbered with the references, keeping how they were written', () => {
    const before = mediaKeysFor(base, ['elara', 'lumi', 'village'])
    const after = mediaKeysFor(base, ['village', 'elara', 'lumi'])
    const out = remapTokens('@Image 1 = Elara, @image 2 = Lumi, @IMAGE3 = Village', before, after, () => 'x')
    expect(out.text).toBe('@Image 2 = Elara, @image 3 = Lumi, @IMAGE1 = Village')
  })

  it('send the right picture for each number', () => {
    const p = project(base, [scene({ prompt: '@Image 3 then @image 1', refs: ['elara', 'lumi', 'village'] })])
    const snap = enqueueSnapshot(p, p.scenes[0])
    const images = requestImages(snap, p.assets, 30)
    const body = toVideoJobBody(request(snap.promptSnapshot, images), { projectId: 'bridge', uploadIdFor: (id) => 'up_' + id })
    const nth = (n: number) => body.upload_ids![n - 1]
    expect([nth(3), nth(1)]).toEqual(['up_v1', 'up_e1'])
  })
})

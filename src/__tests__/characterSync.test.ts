// "Đồng bộ nhân vật": the image each @image_N in the sent prompt refers to must be exactly the image sent as the
// N-th reference — from compiling the prompt, through the queue, to the canvasapp request. These tests pin that chain.
// Since GT1 ("giữ token"): removing a reference picture never deletes prompt text — its token becomes a red placeholder
// "@image_?N(label)" that blocks every run path until the user fills it explicitly (never by itself).
import { beforeEach, describe, expect, it } from 'vitest'
import { restoredFromTake } from '../components/runs/restore'
import { compileScene, extractMentions, imageKey, imageSlotsFor, remapTokens } from '../core/compile'
import { runBlockReason } from '../core/runRules'
import type { Asset, Project, Scene } from '../core/types'
import { toVideoJobBody, validateRequest } from '../providers/canvasapp/mapping'
import type { JobRequest } from '../providers/types'
import { redo, undo, useProject } from '../store/project'
import { requestImages } from '../store/runs'
import { canReplaceRefEdge, replaceRefEdge } from '../components/canvas/CanvasView'
import { register } from '../lib/promptDrafts'
import { useUI } from '../store/ui'

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
  prompt, rawPrompt: prompt, images, firstFrame: null, lastFrame: null, startedAt: 0,
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

// ---------------------------------------------------------------------------------------------
// GT1: removal / restore matrix through the real store
// ---------------------------------------------------------------------------------------------

describe('character sync: a removed picture leaves a red placeholder that never runs (GT1)', () => {
  const base = () => [asset('elara', 'Elara', ['e1']), asset('lumi', 'Lumi', ['l1']), asset('village', 'Village', ['v1'])]
  const st = () => useProject.getState()
  const s1 = () => st().project.scenes.find((x) => x.id === 's1')!
  const blockOf = (p: Project, s: Scene) => runBlockReason({ scene: s, assets: p.assets, compiled: compileScene(p, s) })
  const load = (assets: Asset[], over: Partial<Scene> = {}, autoRenumber = true) => {
    st().loadProject({ ...project(assets, [scene(over)]), settings: { autoRenumber } })
    useProject.temporal.getState().clear()
  }
  beforeEach(() => load(base()))

  it('cut Lumi → "@image_?2(Lumi)" (Village renumbered to 2), the scene is blocked', () => {
    st().removeRef('s1', 'lumi')
    expect(s1().prompt).toBe('@image_1 hugs @image_?2(Lumi) in front of @image_2')
    const out = compileScene(st().project, s1())
    expect(out.unsentTokens).toEqual(['@image_?2(Lumi)'])
    expect(blockOf(st().project, s1())).toContain('Còn chữ đỏ chờ ảnh: Lumi (@image_?2)')
  })

  it('cut → the user deletes the "?" by hand → STILL blocked: @image_2 is Village, not Lumi', () => {
    st().removeRef('s1', 'lumi')
    st().setScenePrompt('s1', s1().prompt.replace('@image_?2(Lumi)', '@image_2(Lumi)'))
    const out = compileScene(st().project, s1())
    expect(out.unsentTokens).toEqual(['@image_2(Lumi)'])
    expect(blockOf(st().project, s1())).toBe('@image_2 đang là “Village”, không phải “Lumi” — kiểm tra ở dải “Chữ đỏ chờ ảnh” dưới ô prompt')
  })

  it('linking another character after a cut never fills the placeholder by itself', () => {
    st().removeRef('s1', 'lumi')
    st().addAsset({ id: 'mira', name: 'Mira', imageIds: ['m1'] })
    st().addRefs(['s1'], ['mira'])
    expect(s1().prompt).toBe('@image_1 hugs @image_?2(Lumi) in front of @image_2')
    expect(blockOf(st().project, s1())).not.toBeNull()
  })

  it('cut → link Mira → "Gắn vào chỗ Lumi" → the request sends Elara, Mira, Village in @image order', () => {
    st().removeRef('s1', 'lumi')
    st().addAsset({ id: 'mira', name: 'Mira', imageIds: ['m1'] })
    st().addRefs(['s1'], ['mira'])
    expect(st().fillPlaceholder('s1', '@image_?2(Lumi)', 'mira').ok).toBe(true)
    const p = st().project
    expect(s1().prompt).toBe('@image_1 hugs @image_2 in front of @image_3')
    expect(blockOf(p, s1())).toBeNull()
    const snap = enqueueSnapshot(p, s1())
    expect(charactersSent(snap.promptSnapshot, requestImages(snap, p.assets, 30), p.assets)).toEqual(['Elara', 'Mira', 'Village'])
  })

  it('replaceRef sends Mira in the slot Lumi had; the prompt is unchanged', () => {
    st().addAsset({ id: 'mira', name: 'Mira', imageIds: ['m1'] })
    expect(st().replaceRef('s1', 'lumi', 'mira')).toEqual({ ok: true })
    const p = st().project
    expect(s1().prompt).toBe('@image_1 hugs @image_2 in front of @image_3')
    const snap = enqueueSnapshot(p, s1())
    expect(charactersSent(snap.promptSnapshot, requestImages(snap, p.assets, 30), p.assets)).toEqual(['Elara', 'Mira', 'Village'])
  })

  it.each([true, false])('wire replacement keeps prompt bytes and the slot, with one undo step (renumber=%s)', (renumber) => {
    const prompt = '  @Image 1\n@image_2 + @IMAGE3; @image_?7(Mira)  '
    load([...base(), asset('mira', 'Mira', ['m1'])], { prompt }, renumber)
    const before = s1()
    expect(canReplaceRefEdge('ref:lumi->s1', 'mira')).toBe(true)
    replaceRefEdge('ref:lumi->s1', 'mira')
    expect(s1().refs).toEqual(['elara', 'mira', 'village'])
    expect(s1().prompt).toBe(prompt)
    expect(useProject.temporal.getState().pastStates).toHaveLength(1)
    const note = useUI.getState().toasts.at(-1)!
    expect(note.text).toBe('Đã thay Lumi bằng Mira ở S01 — prompt giữ nguyên.')
    expect(note.tone).toBe('success')
    expect(note.action?.label).toBe('Hoàn tác')
    note.action!.run()
    expect(s1()).toEqual(before)
    redo()
    expect(s1().refs).toEqual(['elara', 'mira', 'village'])
    expect(s1().prompt).toBe(prompt)
  })

  it('wire replacement flushes a draft before making missing pictures red, and undo restores that draft', () => {
    load([asset('elara', 'Elara', ['e1', 'e2']), asset('mira', 'Mira', ['m1']), asset('lumi', 'Lumi', ['l1'])], {
      refs: ['elara', 'lumi'], prompt: 'old prompt',
    })
    const prompt = 'face @image_1, outfit @image_2, friend @image_3'
    let historyAfterFlush = 0
    const unregister = register('s1', () => {
      st().setScenePrompt('s1', prompt)
      historyAfterFlush = useProject.temporal.getState().pastStates.length
    })
    try {
      replaceRefEdge('ref:elara->s1', 'mira')
    } finally {
      unregister()
    }
    expect(s1().prompt).toBe('face @image_1, outfit @image_?2(Elara · ảnh 2), friend @image_2')
    expect(s1().refs).toEqual(['mira', 'lumi'])
    expect(blockOf(st().project, s1())).not.toBeNull()
    expect(useProject.temporal.getState().pastStates).toHaveLength(historyAfterFlush + 1)
    expect(useUI.getState().toasts.at(-1)?.text).toContain('@image_?2(Elara · ảnh 2)')
    undo()
    expect(s1().prompt).toBe(prompt)
    expect(s1().refs).toEqual(['elara', 'lumi'])
  })

  it('invalid replacement drops preserve project, draft, selection, toasts and undo history', () => {
    load([...base(), asset('empty', 'Empty', []), asset('big', 'Big', Array.from({ length: 40 }, (_, i) => `b${i}`))])
    const before = st().project
    const ui = useUI.getState()
    let flushed = false
    const unregister = register('s1', () => { flushed = true })
    try {
      for (const [wire, target] of [
        ['ref:lumi->s1', ''], ['ref:lumi->s1', 's1'], ['ref:lumi->s1', 'missing'],
        ['ref:lumi->s1', 'lumi'], ['ref:lumi->s1', 'elara'], ['ref:lumi->s1', 'empty'],
        ['ref:lumi->s1', 'big'], ['ref:missing->s1', 'big'], ['ref:lumi->gone', 'big'],
        ['first:lumi->s1', 'big'],
      ]) {
        expect(canReplaceRefEdge(wire, target)).toBe(false)
        replaceRefEdge(wire, target)
      }
    } finally {
      unregister()
    }
    expect(flushed).toBe(false)
    expect(st().project).toBe(before)
    expect(useUI.getState()).toBe(ui)
    expect(useProject.temporal.getState().pastStates).toHaveLength(0)
  })

  it('replacing with more pictures renumbers later refs and leaves the extra picture unnamed', () => {
    load([...base(), asset('mira', 'Mira', ['m1', 'm2'])])
    replaceRefEdge('ref:lumi->s1', 'mira')
    expect(s1().prompt).toBe('@image_1 hugs @image_2 in front of @image_4')
    const p = st().project
    const snap = enqueueSnapshot(p, s1())
    expect(charactersSent(snap.promptSnapshot, requestImages(snap, p.assets, 30), p.assets)).toEqual(['Elara', 'Mira', 'Village'])
    undo()
    expect(s1().refs).toEqual(['elara', 'lumi', 'village'])
  })

  it('every removal path leaves the same placeholder: wire cut, Delete on the wire, unlink in many scenes, move to another scene, delete from the library', () => {
    const paths: [string, () => void][] = [
      ['removeRef', () => st().removeRef('s1', 'lumi')],
      ['deleteItems', () => st().deleteItems({ refs: [{ sceneId: 's1', assetId: 'lumi' }] })],
      ['removeRefs', () => st().removeRefs([{ sceneId: 's1', assetId: 'lumi' }])],
      ['removeAssets', () => st().removeAssets(['lumi'])],
    ]
    for (const [name, run] of paths) {
      load(base())
      run()
      expect(s1().prompt, name).toBe('@image_1 hugs @image_?2(Lumi) in front of @image_2')
      undo()
      expect(s1().prompt, name + ' undo').toBe('@image_1 hugs @image_2 in front of @image_3')
      redo()
      expect(s1().prompt, name + ' redo').toBe('@image_1 hugs @image_?2(Lumi) in front of @image_2')
    }
    load(base())
    st().loadProject({ ...st().project, scenes: [...st().project.scenes, { ...scene({ id: 's2', order: 2, prompt: 'x', refs: [] }) }] })
    st().moveRefToScene('lumi', 's1', 's2')
    expect(s1().prompt).toBe('@image_1 hugs @image_?2(Lumi) in front of @image_2')
  })

  it('multi-picture characters: each picture keeps its own slot and label', () => {
    load([asset('elara', 'Elara', ['e1', 'e2']), asset('lumi', 'Lumi', ['l1'])], { refs: ['elara', 'lumi'], prompt: 'face @image_1, outfit @image_2, friend @image_3' })
    st().updateAsset('elara', { imageIds: ['e1'] }) // the outfit picture removed, Elara still linked
    expect(s1().prompt).toBe('face @image_1, outfit @image_?2(Elara · ảnh 2), friend @image_2')
    let p = st().project
    expect(charactersSent('face @image_1, friend @image_2', requestImages(enqueueSnapshot(p, s1()), p.assets, 30), p.assets)).toEqual(['Elara', 'Lumi'])
    expect(blockOf(p, s1())).not.toBeNull()
    st().removeRef('s1', 'elara')
    expect(s1().prompt).toBe('face @image_?1(Elara), outfit @image_?2(Elara · ảnh 2), friend @image_1')
    p = st().project
    expect(compileScene(p, s1()).unsentTokens).toEqual(['@image_?1(Elara)', '@image_?2(Elara · ảnh 2)'])
  })

  it('two characters with the same name get their unique tags: filling one never touches the other', () => {
    load([asset('lumi', 'Lumi', ['l1']), { ...asset('lumi2', 'Lumi', ['l2']), tag: 'LumiNho' }, asset('mira', 'Mira', ['m1'])], {
      refs: ['lumi', 'lumi2'],
      prompt: '@image_1 and @image_2',
    })
    st().removeRefs([
      { sceneId: 's1', assetId: 'lumi' },
      { sceneId: 's1', assetId: 'lumi2' },
    ])
    expect(s1().prompt).toBe('@image_?1(Lumi) and @image_?2(LumiNho)')
    st().addRefs(['s1'], ['mira'])
    st().fillPlaceholder('s1', 'L:LumiNho', 'mira')
    expect(s1().prompt).toBe('@image_?1(Lumi) and @image_1')
  })

  it('renumbering off: the removed picture still turns red; the other numbers stay as written (and are reported stale)', () => {
    load(base(), {}, false)
    st().removeRef('s1', 'lumi')
    expect(s1().prompt).toBe('@image_1 hugs @image_?2(Lumi) in front of @image_3')
    // @image_3 now points past the two pictures left: blocked as well (never the wrong character)
    expect(compileScene(st().project, s1()).unsentTokens.sort()).toEqual(['@image_3', '@image_?2(Lumi)'])
  })

  it('renumbering off: a fill never lets a number left over by the cut start sending the new character', () => {
    load(base(), {}, false)
    st().removeRef('s1', 'lumi')
    st().addAsset({ id: 'mira', name: 'Mira', imageIds: ['m1'] })
    const before = st().project
    const steps = useProject.temporal.getState().pastStates.length
    // Mira would be appended as 3, and "in front of @image_3" (meant Village) would send Mira: refused, nothing changes
    expect(st().fillPlaceholder('s1', 'L:Lumi', 'mira')).toEqual({ ok: false, why: 'number-taken', token: '@image_3' })
    expect(st().project).toBe(before)
    expect(useProject.temporal.getState().pastStates.length).toBe(steps)
    expect(st().fillPlaceholders(['s1'], 'Lumi', 'mira').refused).toEqual([{ sceneId: 's1', why: 'number-taken', token: '@image_3' }])
    expect(blockOf(st().project, s1())).not.toBeNull()
    // the user fixes the number (the stale warning names it), then fills: every token sends its own character
    st().setScenePrompt('s1', '@image_1 hugs @image_?2(Lumi) in front of @image_2')
    expect(st().fillPlaceholder('s1', 'L:Lumi', 'mira').ok).toBe(true)
    const p = st().project
    expect([s1().prompt, s1().refs]).toEqual(['@image_1 hugs @image_3 in front of @image_2', ['elara', 'village', 'mira']])
    expect(blockOf(p, s1())).toBeNull()
    const snap = enqueueSnapshot(p, s1())
    expect(charactersSent(snap.promptSnapshot, requestImages(snap, p.assets, 30), p.assets)).toEqual(['Elara', 'Mira', 'Village'])
  })

  it('a description glued to a token stays as text after the cut; the placeholder still names who was removed', () => {
    load(base(), { prompt: '@image_1 hugs @image_2(cười) in front of @image_3' })
    st().removeRef('s1', 'lumi')
    expect(s1().prompt).toBe('@image_1 hugs @image_?2(Lumi)(cười) in front of @image_2')
    expect(compileScene(st().project, s1()).unsentTokens).toEqual(['@image_?2(Lumi)'])
    expect(blockOf(st().project, s1())).toContain('Lumi (@image_?2)')
    undo()
    expect(s1().prompt).toBe('@image_1 hugs @image_2(cười) in front of @image_3')
    // the picture's own label glued to the token stays the label (never "(Lumi)(Lumi)")
    load(base(), { prompt: '@image_1 hugs @image_2(Lumi) in front of @image_3' })
    st().removeAssets(['lumi'])
    expect(s1().prompt).toBe('@image_1 hugs @image_?2(Lumi) in front of @image_2')
  })

  it('restore from an older take: a character deleted since and everything after it come back as bare placeholders', () => {
    const take = { rawPromptSnapshot: '@image_1 hugs @image_2 in front of @image_3', refsSnapshot: ['elara', 'lumi', 'village'] }
    st().removeAssets(['lumi'])
    const r = restoredFromTake(take, st().project.assets, { renumber: true })
    expect(r.prompt).toBe('@image_1 hugs @image_?2 in front of @image_?3')
    const exact = restoredFromTake({ ...take, imageKeysSnapshot: ['elara:e1', 'lumi:l1', 'village:v1'] }, st().project.assets, { renumber: true })
    expect(exact.prompt).toBe('@image_1 hugs @image_?2 in front of @image_2')
  })

  it('restore: text glued to a token whose picture is gone stays as text after the label', () => {
    st().updateAsset('lumi', { imageIds: ['l9'] }) // Lumi still exists, the picture the take sent is gone
    const take = { rawPromptSnapshot: '@image_1 hugs @image_2(cười) in front of @image_3', refsSnapshot: ['elara', 'lumi', 'village'], imageKeysSnapshot: ['elara:e1', 'lumi:l1', 'village:v1'] }
    expect(restoredFromTake(take, st().project.assets, { renumber: true }).prompt).toBe('@image_1 hugs @image_?2(Lumi · ảnh 1)(cười) in front of @image_3')
  })

  it('a take queued before the cut still sends its own snapshot (imageKeysSnapshot), never the live refs', () => {
    const snap = enqueueSnapshot(st().project, s1())
    st().removeRef('s1', 'lumi')
    const p = st().project
    const images = requestImages(snap, p.assets, 30)
    expect(images.map((i) => i.imageId)).toEqual(['e1', 'l1', 'v1'])
    expect(charactersSent(snap.promptSnapshot, images, p.assets)).toEqual(['Elara', 'Lumi', 'Village'])
  })

  it('the gateway refuses a prompt that still holds a placeholder (last line, nothing billed)', () => {
    st().removeRef('s1', 'lumi')
    const problems = validateRequest(request(s1().prompt, []))
    expect(problems.some((x) => x.startsWith('Prompt còn chữ đỏ chờ ảnh @image_?2(Lumi)'))).toBe(true)
  })
})

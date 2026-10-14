// Parity of the main-process allowlist (electron/seedvis-rules.cjs) with the rest of the seedvis code:
//   1. (active) with the A0 catalogue (src/core/seedvisRoutes.ts SEEDVIS_ROUTE_TABLE) and contract: the same remote
//      models, modes, image fields and counts, durations (integer / "Ns"), ratios, upscale values — so what the app
//      lets a scene ask for is exactly what main lets through, and nothing more;
//   2. (SKIPPED) with the development-mode simulation's TypeScript port src/providers/dev/seedvis/routes.ts (track
//      A-SIM, built in parallel on cx/sv-sim): it has not landed on this branch yet.
import { describe, expect, it } from 'vitest'
import { SEEDVIS_ROUTE_TABLE } from '../../../core/seedvisRoutes'
import { SEEDVIS_MODEL_IDS } from '../../../core/services'
import { type Any, UUID, jpeg, png, rules, webp } from './fakeElectron'

const bytesFor = [png, jpeg, webp]
const mimes = ['image/png', 'image/jpeg', 'image/webp']

/** A body + images for one catalogue request shape with `n` images (spread over its fields, frames first). */
function sample(id: (typeof SEEDVIS_MODEL_IDS)[number], remoteMode: string, n: number): Any {
  const route = SEEDVIS_ROUTE_TABLE[id]
  const body: Any = {
    model: route.remoteModel,
    mode: remoteMode,
    prompt: 'Cảnh thử @image_1',
    aspect_ratio: route.ratios[0],
    duration: route.durationEncoding === 'seconds-suffix' ? `${route.defaultDuration}s` : route.defaultDuration,
    count: 1,
  }
  if (Object.keys(route.upscaleVideo).length) body.upscale_video = 'none'
  const req = route.requests.find((r) => r.remoteMode === remoteMode)!
  const images: Any[] = []
  const single = req.imageFields.filter((f) => f === 'image' || f === 'lastFrame')
  for (const f of single) if (images.length < n) images.push({ field: f, index: 0 })
  const arrayField = req.imageFields.find((f) => f === 'reference_images' || f === 'referenceImages')
  for (let i = 0; images.length < n; i++) images.push({ field: arrayField ?? req.imageFields[0] ?? 'reference_images', index: arrayField ? i : images.length })
  return {
    route: 'generations.create',
    idempotencyKey: UUID,
    body,
    images: images.map((im, i) => ({ ...im, mime: mimes[i % 3], bytes: bytesFor[i % 3](32) })),
  }
}

describe('seedvis-rules.cjs ↔ the A0 catalogue (src/core/seedvisRoutes.ts)', () => {
  it('the same three remote models, nothing else (no Omni Flash, no image models)', () => {
    expect(Object.keys(rules.SEEDVIS_SUBMIT_MODELS).sort()).toEqual(SEEDVIS_MODEL_IDS.map((id) => SEEDVIS_ROUTE_TABLE[id].remoteModel).sort())
  })

  it.each(SEEDVIS_MODEL_IDS.map((id) => [id]))('%s: modes, image fields and counts, durations, ratios, upscale', (id) => {
    const route = SEEDVIS_ROUTE_TABLE[id]
    const spec = rules.SEEDVIS_SUBMIT_MODELS[route.remoteModel]
    expect(Object.keys(spec.modes).sort()).toEqual([...new Set(route.requests.map((r) => r.remoteMode))].sort())
    for (const req of route.requests) {
      const fields = spec.modes[req.remoteMode]
      expect(fields.map((f: Any) => f.field), req.remoteMode).toEqual([...req.imageFields])
      expect(fields.reduce((s: number, f: Any) => s + f.min, 0), req.remoteMode).toBe(req.minImages)
      expect(fields.reduce((s: number, f: Any) => s + f.max, 0), req.remoteMode).toBe(req.maxImages)
    }
    const durations = route.durationEncoding === 'seconds-suffix' ? route.durations.map((d) => `${d}s`) : [...route.durations]
    expect([...spec.durations]).toEqual(durations)
    expect([...spec.ratios]).toEqual([...route.ratios])
    const upscale = [...new Set(Object.values(route.upscaleVideo))]
    expect(spec.upscale ? [...spec.upscale].sort() : []).toEqual(upscale.sort())
  })

  it.each(SEEDVIS_MODEL_IDS.flatMap((id) => SEEDVIS_ROUTE_TABLE[id].requests.map((r) => [id, r.remoteMode, r.minImages, r.maxImages] as const)))(
    '%s %s: main accepts min..max images and refuses one more',
    (id, mode, min, max) => {
      for (const n of [min, max]) expect(rules.checkSubmit(sample(id, mode, n)).ok, `${n} images`).toBe(true)
      expect(rules.checkSubmit(sample(id, mode, max + 1)).ok).toBe(false)
      if (min > 0) expect(rules.checkSubmit(sample(id, mode, min - 1)).ok).toBe(false)
    },
  )

  it('every duration and ratio of the catalogue passes main; values of another route do not', () => {
    for (const id of SEEDVIS_MODEL_IDS) {
      const route = SEEDVIS_ROUTE_TABLE[id]
      const t2v = route.requests[0].remoteMode
      for (const d of route.durations) {
        const req = sample(id, t2v, 0)
        req.body.duration = route.durationEncoding === 'seconds-suffix' ? `${d}s` : d
        expect(rules.checkSubmit(req).ok, `${id} ${d}`).toBe(true)
      }
      for (const r of route.ratios) {
        const req = sample(id, t2v, 0)
        req.body.aspect_ratio = r
        expect(rules.checkSubmit(req).ok, `${id} ${r}`).toBe(true)
      }
    }
    const veo = sample('seedvis/veo_3.1', 'text-to-video', 0)
    veo.body.aspect_ratio = '21:9'
    expect(rules.checkSubmit(veo).ok).toBe(false)
    const fast = sample('seedvis/seedance_2.0_fast', 'text-to-video', 0)
    fast.body.duration = 30
    expect(rules.checkSubmit(fast).ok).toBe(false)
  })
})

// TODO(integration, A-SIM): enable once src/providers/dev/seedvis/routes.ts (the TypeScript port of seedvis-rules.cjs,
// cx/sv-sim) is merged: replace `describe.skip` by `describe`, and map the names below to its exports if they differ.
// It is loaded through import.meta.glob so this file compiles before the module exists.
const simModules = import.meta.glob('../../dev/seedvis/routes.ts')

describe.skip('seedvis-rules.cjs ↔ the simulation’s routes.ts (SKIPPED: A-SIM’s src/providers/dev/seedvis/routes.ts has not landed on this branch)', () => {
  const corpus: Any[] = [
    { route: 'models' },
    { route: 'account.info' },
    { route: 'account.usage' },
    { route: 'generations.get', id: 'gen_1' },
    { route: 'generations.get', id: '../x' },
    { route: 'generations.cancel', id: 'gen_1' },
    { route: 'images.generations' },
    ...SEEDVIS_MODEL_IDS.flatMap((id) => SEEDVIS_ROUTE_TABLE[id].requests.flatMap((r) => [sample(id, r.remoteMode, r.minImages), sample(id, r.remoteMode, r.maxImages + 1)])),
  ]

  it('the simulation refuses exactly what main refuses', async () => {
    const load = simModules['../../dev/seedvis/routes.ts']
    expect(load, 'src/providers/dev/seedvis/routes.ts').toBeDefined()
    const sim = (await load()) as Any
    for (const req of corpus) {
      const mainVerdict = req.route === 'generations.create' ? rules.checkSubmit(req).ok : rules.matchSeedvisRoute(req) !== null
      const simVerdict = req.route === 'generations.create' ? sim.checkSubmit(req).ok : sim.matchSeedvisRoute(req) !== null
      expect(simVerdict, JSON.stringify({ route: req.route, mode: req.body?.mode, images: req.images?.length })).toBe(mainVerdict)
    }
  })
})

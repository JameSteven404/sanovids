// Parity of the main-process allowlist (electron/seedvis-rules.cjs) with the rest of the seedvis code:
//   1. (active) with the A0 catalogue (src/core/seedvisRoutes.ts SEEDVIS_ROUTE_TABLE) and contract: the same remote
//      models, modes, image fields and counts, durations (integer / "Ns"), ratios, upscale values — so what the app
//      lets a scene ask for is exactly what main lets through, and nothing more;
//   2. with the development-mode simulation (track A-SIM): src/providers/dev/seedvis/routes.ts matchSeedvisRoute(method,
//      path) ↔ main's URL layer matchSeedvisUrl, and validate.ts seedvisRequestProblem(req) ↔ main's symbolic layer
//      matchSeedvisRoute(req) / checkSubmit(req) — the simulation refuses exactly what main refuses.
import { describe, expect, it } from 'vitest'
import { SEEDVIS_ROUTE_TABLE } from '../../../core/seedvisRoutes'
import { SEEDVIS_MODEL_IDS } from '../../../core/services'
import { matchSeedvisRoute as simMatchPath } from '../../dev/seedvis/routes'
import { seedvisRequestProblem } from '../../dev/seedvis/validate'
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

describe('seedvis-rules.cjs ↔ the simulation (src/providers/dev/seedvis/routes.ts + validate.ts)', () => {
  const corpus: Any[] = [
    { route: 'models' },
    { route: 'account.info' },
    { route: 'account.usage' },
    { route: 'models', id: 'gen_1' },
    { route: 'generations.get', id: 'gen_1' },
    { route: 'generations.get', id: '../x' },
    { route: 'generations.get' },
    { route: 'generations.get', id: 'x'.repeat(101) },
    { route: 'generations.cancel', id: 'gen_1' },
    { route: 'generations.cancel', id: 'a/b' },
    { route: 'images.generations' },
    { route: 'toString' },
    { route: '__proto__' },
    ...SEEDVIS_MODEL_IDS.flatMap((id) =>
      SEEDVIS_ROUTE_TABLE[id].requests.flatMap((r) => [
        sample(id, r.remoteMode, r.minImages),
        sample(id, r.remoteMode, r.maxImages),
        sample(id, r.remoteMode, r.maxImages + 1),
        ...(r.minImages > 0 ? [sample(id, r.remoteMode, r.minImages - 1)] : []),
      ]),
    ),
  ]
  // a few create bodies each layer must refuse: another count, no prompt, a foreign model, a key that is not a UUID
  const bad = (edit: (req: Any) => void) => {
    const req = sample('seedvis/seedance_2.5', 'text-to-video', 0)
    edit(req)
    return req
  }
  corpus.push(
    bad((r) => (r.body.count = 2)),
    bad((r) => (r.body.prompt = '   ')),
    bad((r) => (r.body.model = 'omni-flash')),
    bad((r) => (r.idempotencyKey = 'not-a-uuid')),
    bad((r) => (r.body.extra = true)),
  )

  it('the simulation refuses exactly the symbolic requests main refuses', () => {
    let accepted = 0
    for (const req of corpus) {
      const mainVerdict = req.route === 'generations.create' ? rules.checkSubmit(req).ok : rules.matchSeedvisRoute(req) !== null
      const simVerdict = seedvisRequestProblem(req) === null
      expect(simVerdict, JSON.stringify({ route: req.route, id: req.id, mode: req.body?.mode, images: req.images?.length })).toBe(mainVerdict)
      if (mainVerdict) accepted++
    }
    // the corpus really holds both kinds (never a parity of "everything refused")
    expect(accepted).toBeGreaterThan(10)
    expect(accepted).toBeLessThan(corpus.length)
  })

  it('the simulation’s path allowlist names the same route as main’s URL layer', () => {
    const base = '/api/v1'
    const cases: [string, string][] = [
      ['GET', `${base}/models`],
      ['GET', `${base}/account/info`],
      ['GET', `${base}/account/usage`],
      ['POST', `${base}/developer/generations`],
      ['GET', `${base}/developer/generations/gen_1?wait=0`],
      ['POST', `${base}/developer/generations/gen_1/cancel`],
      ['GET', `${base}/developer/generations/gen_1`],
      ['GET', `${base}/developer/generations/gen_1?wait=30`],
      ['POST', `${base}/models`],
      ['GET', `${base}/developer/generations`],
      ['GET', `${base}/developer/generations/../models?wait=0`],
      ['GET', `${base}/developer/generations/a%2Fb?wait=0`],
      ['POST', `${base}/developer/generations/gen_1/cancel?x=1`],
      ['GET', `${base}/models?x=1`],
      ['GET', `/api/v2/models`],
      ['GET', `${base}/images/generations`],
    ]
    for (const [method, path] of cases) {
      const main = rules.matchSeedvisUrl(method, rules.SEEDVIS_ORIGIN + path)
      const sim = simMatchPath(method, path)
      expect(sim?.endpoint ?? null, `${method} ${path}`).toBe(main)
    }
  })
})

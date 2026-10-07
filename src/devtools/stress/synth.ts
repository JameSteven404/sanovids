// Generated test projects: built as raw JSON (like a saved file) and brought in through migrateProject / migrateTake,
// so they always have the shape the running build expects (before and after the "Đợt V" video-reference retirement).
// Never a real project: ids and names say "stress" / "Thử nghiệm giới hạn".
import { migrateProject, migrateTake } from '../../core/migrate'
import { MODELS } from '../../core/models'
import type { Project, Take } from '../../core/types'
import { edgeFragment, edgeName, sentence, textOfLength } from './corpus'
import type { Rng } from './rng'
import type { ScenarioDef, Tier } from './types'

export interface TierSize {
  scenes: number
  assets: number
  /** Finished takes already in the project (shown as video nodes). */
  takes: number
}

export const TIER_SIZE: Record<Tier, TierSize> = {
  S: { scenes: 30, assets: 12, takes: 20 },
  M: { scenes: 300, assets: 60, takes: 300 },
  L: { scenes: 600, assets: 120, takes: 1200 },
  XL: { scenes: 1000, assets: 200, takes: 3000 },
  XXL: { scenes: 2000, assets: 300, takes: 6000 },
  OVER: { scenes: 5000, assets: 400, takes: 8000 },
}

export const TIER_LABEL: Record<Tier, string> = {
  S: 'S — 30 cảnh',
  M: 'M — 300 cảnh',
  L: 'L — 600 cảnh',
  XL: 'XL — 1.000 cảnh',
  XXL: 'XXL — 2.000 cảnh',
  OVER: 'Vượt — 5.000 cảnh',
}

export const STRESS_PROJECT_PREFIX = 'prj_stress_'
export const STRESS_PROJECT_NAME = 'Thử nghiệm giới hạn'
const KINDS = ['character', 'location', 'prop', 'style'] as const

/** Image ids of the stress tester: valid upload names (/^[A-Za-z0-9_-]{1,60}$/), recognisable, unique per run. */
export const imageIdOf = (seed: string, n: number) => `img_stx_${seed}_${n}`
export const isStressImageId = (id: string) => id.startsWith('img_stx_')

export interface GeneratedProject {
  project: Project
  takes: Take[]
  /** Scene id → @video tokens in its prompt at load (legacy data). */
  legacyTokens: Map<string, string[]>
  /** Image ids the project uses (the session must be able to upload them). */
  imageIds: string[]
}

interface Ctx {
  rng: Rng
  seed: string
  nextImage: () => string
}

const SEEDANCE = MODELS.seedance_2_5
const H3 = MODELS.minimax_h3

function randomSettings(rng: Rng): Record<string, unknown> {
  if (rng.chance(0.8)) {
    return { model: 'seedance_2_5', mode: 't2v', duration: rng.pick(SEEDANCE.durations), resolution: rng.pick(SEEDANCE.resolutions), ratio: rng.pick(SEEDANCE.ratios) }
  }
  return { model: 'minimax_h3', mode: rng.pick(H3.modes), duration: rng.pick(H3.durations), resolution: rng.pick(H3.resolutions), ratio: rng.pick(H3.ratios) }
}

/** A prompt for `slots` reference images: text + @image_N tokens in range, sometimes hostile or very long. */
export function promptFor(rng: Rng, slots: number, opts: { long?: boolean } = {}): string {
  const parts: string[] = [sentence(rng)]
  const tokens = Math.min(slots, rng.int(0, 4))
  for (let i = 0; i < tokens; i++) parts.push(`@image_${rng.int(1, slots)}`, sentence(rng, rng.int(1, 5)))
  if (rng.chance(0.15)) parts.push(edgeFragment(rng))
  if (opts.long && rng.chance(0.5)) parts.push(textOfLength(rng, rng.int(5_000, 21_000)))
  return parts.join(' ')
}

function rawAsset(c: Ctx, i: number, images: number) {
  return {
    id: `ast_stx_${i}`,
    kind: KINDS[i % KINDS.length],
    name: c.rng.chance(0.1) ? edgeName(c.rng) || `Nhân vật ${i + 1}` : `Nhân vật ${i + 1}`,
    tag: `nv${i + 1}`,
    description: c.rng.chance(0.2) ? sentence(c.rng, 20) : '',
    imageIds: Array.from({ length: images }, () => c.nextImage()),
    color: '#7c9cff',
    position: i < 24 ? { x: -420, y: i * 220 } : null,
  }
}

function rawTake(c: Ctx, id: string, scene: { id: string; prompt: string; refs: string[]; settings: Record<string, unknown> }, number: number, status: 'completed' | 'failed') {
  const at = 1_700_000_000_000 + number * 1000
  return {
    id,
    sceneId: scene.id,
    number,
    status,
    progress: status === 'completed' ? 100 : 0,
    createdAt: at,
    startedAt: at,
    finishedAt: at + 8000,
    promptSnapshot: scene.prompt,
    rawPromptSnapshot: scene.prompt,
    refsSnapshot: [...scene.refs],
    videoRefsSnapshot: [],
    settings: { ...scene.settings },
    cost: 4,
    starred: false,
    posterId: null,
    videoId: null,
    error: status === 'failed' ? 'Lỗi giả lập (dữ liệu thử nghiệm).' : null,
    position: null,
    provider: 'dev',
    remoteId: `stx:${id}`,
    charged: false,
  }
}

/**
 * The project of a scenario at a size tier. `kind`:
 *  'generated'    many scenes with references, tokens in range, some hostile text, finished takes;
 *  'legacy-video' the same plus scenes saved with video references (@video_N, @video_?N, "Continue from @video_1:"),
 *                 some pointing at takes that no longer exist;
 *  'bridge-full'  every scene is runnable (Seedance t2v, short prompt) — for queue floods.
 */
export function generateProject(rng: Rng, seed: string, tier: Tier, kind: NonNullable<ScenarioDef['project']> = 'generated'): GeneratedProject {
  const size = TIER_SIZE[tier]
  let imageN = 0
  const imageIds: string[] = []
  const c: Ctx = {
    rng,
    seed,
    nextImage: () => {
      const id = imageIdOf(seed, ++imageN)
      imageIds.push(id)
      return id
    },
  }
  const assets = Array.from({ length: size.assets }, (_, i) => rawAsset(c, i, rng.chance(0.2) ? rng.int(2, 6) : 1))
  const imagesOf = new Map(assets.map((a) => [a.id, a.imageIds.length]))
  const legacyTokens = new Map<string, string[]>()
  const runnable = kind === 'bridge-full'

  const scenes = Array.from({ length: size.scenes }, (_, i) => {
    const refCount = runnable ? rng.int(0, 2) : rng.chance(0.1) ? rng.int(8, 40) : rng.int(0, 4)
    const refs: string[] = []
    for (let k = 0; k < refCount && assets.length; k++) {
      const a = assets[rng.int(0, assets.length - 1)].id
      if (!refs.includes(a)) refs.push(a)
    }
    const settings = runnable ? { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' } : randomSettings(rng)
    const slots = refs.reduce((n, a) => n + (imagesOf.get(a) ?? 0), 0)
    const cap = settings.model === 'minimax_h3' ? H3.maxRefImages : SEEDANCE.maxRefImages
    const prompt = runnable ? `${sentence(rng)}${slots ? ' @image_1' : ''}` : promptFor(rng, Math.min(slots, cap), { long: rng.chance(0.03) })
    const transform = settings.mode === 'transform'
    return {
      id: `scn_stx_${i}`,
      order: i + 1,
      title: rng.chance(0.1) ? edgeName(rng) : `Cảnh ${i + 1}`,
      prompt,
      refs,
      videoRefs: [] as string[],
      presetId: null,
      settings,
      firstFrame: transform && assets.length ? assets[rng.int(0, assets.length - 1)].id : null,
      lastFrame: transform && assets.length && rng.chance(0.5) ? assets[rng.int(0, assets.length - 1)].id : null,
      color: null,
      note: '',
    }
  })

  // Finished (and some failed) takes spread over the scenes.
  const takes: Record<string, unknown>[] = []
  const numbers = new Map<string, number>()
  for (let t = 0; t < size.takes && scenes.length; t++) {
    const scene = scenes[rng.int(0, scenes.length - 1)]
    const n = (numbers.get(scene.id) ?? 0) + 1
    numbers.set(scene.id, n)
    takes.push(rawTake(c, `take_stx_${t}`, scene, n, rng.chance(0.9) ? 'completed' : 'failed'))
  }

  if (kind === 'legacy-video') {
    const done = takes.filter((t) => t.status === 'completed') as { id: string; sceneId: string }[]
    const count = Math.max(1, Math.floor(scenes.length / 4))
    for (let k = 0; k < count && done.length; k++) {
      const scene = scenes[rng.int(0, scenes.length - 1)]
      if (scene.videoRefs.length) continue
      const own = (t: { sceneId: string }) => t.sceneId === scene.id
      const pool = done.filter((t) => !own(t))
      const n = rng.int(1, 3)
      for (let j = 0; j < n && pool.length; j++) {
        const id = rng.chance(0.1) ? `take_gone_${k}_${j}` : pool[rng.int(0, pool.length - 1)].id
        if (!scene.videoRefs.includes(id)) scene.videoRefs.push(id)
      }
      const tokens = scene.videoRefs.map((_, j) => `@video_${j + 1}`)
      const lead = rng.chance(0.5) ? 'Continue from @video_1: ' : ''
      const extra = rng.chance(0.3) ? ' @video_?2' : ''
      scene.prompt = `${lead}${scene.prompt} ${tokens.slice(lead ? 1 : 0).join(' ')}${extra}`.trim()
      legacyTokens.set(scene.id, (scene.prompt.match(/@video_\??\d+/g) ?? []).slice())
    }
  }

  const raw = {
    id: `${STRESS_PROJECT_PREFIX}${seed}`,
    name: `${STRESS_PROJECT_NAME} ${seed}`,
    schemaVersion: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    presets: [{ id: 'pst_stx_1', name: 'Seedance 480p', model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '480p', ratio: '16:9' }],
    settings: { autoRenumber: true },
    assets,
    scenes,
  }
  return { project: migrateProject(raw), takes: takes.map(migrateTake), legacyTokens, imageIds }
}

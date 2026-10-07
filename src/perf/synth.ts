import type { Project, Take, VideoSettings } from '../core/types'

export const SIZES = { M: { scenes: 300, takes: 600 }, L: { scenes: 600, takes: 1200 }, XL: { scenes: 1000, takes: 3000 } } as const
export type PerfSize = keyof typeof SIZES
/**
 * The 0.6.0 canvas layout (store/project LAYOUT / ROW_H — literal here: this module stays free of the stores; synth.test
 * checks both): scene rows 352 apart at x 464, the image column at x 40 in 220 × 275 tiles 24px apart, takes 224 + 16
 * from 64px right of the 352px node.
 */
export const SYNTH_LAYOUT = { scenesX: 464, scenesY: 60, rowH: 352, sceneW: 352, assetX: 40, tileStep: 275 + 24, takeOffsetX: 64, takeStep: 224 + 16 } as const
export interface SynthSpec { scenes: number; takes: number }
export function mulberry32(seed: number) {
  return () => {
    let t = seed += 0x6d2b79f5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
export function synthProject(spec: SynthSpec, seed = 20261006): { project: Project; runs: { takes: Take[]; credits: number; spent: number } } {
  if (!Number.isInteger(spec.scenes) || spec.scenes < 1 || spec.scenes > 2000 || !Number.isInteger(spec.takes)
    || spec.takes < spec.scenes || spec.takes > 6000 || !Number.isSafeInteger(seed)) throw new Error('Cỡ thử không hợp lệ (1–2.000 cảnh, tối đa 6.000 video).')
  const random = mulberry32(seed)
  const id = (kind: string, n = 0) => `prf_${seed}_${spec.scenes}_${spec.takes}_${kind}_${n}`
  const settings: VideoSettings = { model: 'seedance_2_5', mode: 'i2v', duration: 5, resolution: '720p', ratio: '16:9' }
  const now = 1791244800000
  // Laid out like a 0.6.0 project (scene rows 352 apart, the image column with its wire room, the folder right of the
  // longest take row): never taken for a 0.5.x layout by the canvas' one-time row spacing (rowSpacing.showsOldLayout).
  const L = SYNTH_LAYOUT
  const folderX = L.scenesX + L.sceneW + L.takeOffsetX + Math.ceil(spec.takes / spec.scenes) * L.takeStep + 64
  const project: Project = {
    id: id('project'), name: `Thử hiệu năng · ${spec.scenes} cảnh`, schemaVersion: 2, createdAt: now, updatedAt: now,
    settings: { autoRenumber: true },
    presets: [
      { id: id('preset'), name: 'Nháp', ...settings },
      { id: id('preset', 1), name: 'Final', ...settings, resolution: '1080p', duration: 10 },
    ],
    folders: [{ id: id('folder'), name: 'Thư mục thử · không ghi đĩa', path: null, position: { x: folderX, y: 0 }, mode: 'copy' }],
    assets: Array.from({ length: 12 }, (_, n) => ({ id: id('asset', n), name: `Nhân vật ${n + 1}`, tag: `NhanVat${n + 1}`,
      kind: 'character', description: 'Ảnh tổng hợp để đo hiệu năng', imageIds: [id('media', n)], color: '#6c8eaf', position: { x: L.assetX, y: L.scenesY + n * L.tileStep } })),
    scenes: [],
  }
  project.scenes = Array.from({ length: spec.scenes }, (_, n) => {
    const refs = Array.from({ length: 2 + Math.floor(random() * 2) }, (_, i) => id('asset', (n + i) % 12))
    const videoRefs = (n + 1) % 10 === 0 ? [id('take', n - 1)] : []
    const prefix = refs.map((_, i) => `@image_${i + 1}`).join(' ') + (videoRefs.length ? ' @video_1 ' : ' ')
    const length = 2000 + Math.floor(random() * 4001)
    const sentence = 'Ánh nắng xuyên qua rừng, nhân vật bước chậm về phía máy quay. Góc rộng điện ảnh, chuyển động tự nhiên. '
    return { id: id('scene', n), order: n + 1, title: `Cảnh thử ${n + 1}`, prompt: (prefix + sentence.repeat(70)).slice(0, length),
      refs, videoRefs, presetId: id('preset', n % 2), settings: { ...settings, ...(n % 2 ? { resolution: '1080p', duration: 10 } : {}) }, firstFrame: null, lastFrame: null,
      color: null, position: { x: L.scenesX, y: L.scenesY + n * L.rowH }, note: '' }
  })
  const takes: Take[] = Array.from({ length: spec.takes }, (_, n) => {
    const scene = project.scenes[n % spec.scenes]
    return { id: id('take', n), sceneId: scene.id, number: Math.floor(n / spec.scenes) + 1, status: 'completed', progress: 100,
      createdAt: now + n, startedAt: now + n, finishedAt: now + n + 1, promptSnapshot: scene.prompt, rawPromptSnapshot: scene.prompt,
      refsSnapshot: [...scene.refs], videoRefsSnapshot: [...scene.videoRefs], settings: { ...scene.settings }, cost: 0,
      starred: random() < 0.2, posterId: id('media', n % 12), videoId: null, error: null, position: null,
      provider: 'dev', remoteId: null, charged: false }
  })
  return { project, runs: { takes, credits: 1000, spent: 0 } }
}

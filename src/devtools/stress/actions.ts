// The catalog of stress actions. Each draws JSON args (raw integers resolved against the lists of the moment with
// `at()`, so a log replays even after steps are dropped) and drives the real stores / commands, exactly what the UI
// calls. Lists are always ordered (scenes by `order`, others by array index) — never by id, ids differ between runs.
import { deleteTakes, ensureAssetToken, linkAssets, renameTake } from '../../actions'
import { compileScene, parseTokens } from '../../core/compile'
import { cleanTakeFileName, safeFileName } from '../../core/fileNames'
import { migrateTake } from '../../core/migrate'
import { MODELS } from '../../core/models'
import { parsePromptText, scanTokens, summarizeImport } from '../../core/importPrompts'
import type { Mode, ModelId, Project, Scene, VideoSettings } from '../../core/types'
import { DEV_FAULT_PRESETS } from '../../providers/dev'
import { redo, undo, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useUI } from '../../store/ui'
import { edgeFragment, edgeName, sentence, textOfLength, TOKEN_LIKE } from './corpus'
import { checkMigrate, checkRoundTrip, firstDiff, ordered, projectKey } from './invariants'
import { at, type Rng } from './rng'
import { promptFor } from './synth'
import type { StepArgs, StressAction, StressContext } from './types'

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const project = (): Project => useProject.getState().project
const P = () => useProject.getState()
const R = () => useRuns.getState()
const scenes = () => ordered(project())
const assets = () => project().assets
const takes = () => R().takes
const folders = () => project().folders ?? []
const num = (a: StepArgs, k: string) => Number(a[k] ?? 0)
const str = (a: StepArgs, k: string) => String(a[k] ?? '')
const hasScenes = () => project().scenes.length > 0
const hasAssets = () => project().assets.length > 0

/** `count` distinct items picked from `list` starting at raw `r` (stride keeps it deterministic). */
function pickMany<T>(list: readonly T[], r: number, count: number): T[] {
  if (!list.length) return []
  const n = Math.min(count, list.length)
  const out: T[] = []
  const start = Math.abs(r) % list.length
  const stride = 1 + (Math.abs(r >> 7) % Math.max(1, list.length - 1))
  for (let i = 0, k = start; out.length < n && i < list.length * 2; i++, k = (k + stride) % list.length) {
    if (!out.includes(list[k])) out.push(list[k])
  }
  return out
}

/** Scenes near the end are where new ones go: keep the visible part of a big project busy too. */
const sceneAt = (r: number) => at(scenes(), r)

function slotsOf(s: Scene): number {
  const p = project()
  const byId = new Map(p.assets.map((a) => [a.id, a]))
  return s.refs.reduce((n, id) => n + (byId.get(id)?.imageIds.length ?? 0), 0)
}

/** A prompt for a step: plain, with tokens, hostile, or at / over the model's limit. */
function promptArg(rng: Rng): StepArgs {
  return { kind: rng.int(0, 9), r: rng.raw(), len: rng.int(0, 3) }
}

function buildPrompt(ctx: StressContext, s: Scene, a: StepArgs): string {
  const rng = ctx.rng.fork(`prompt/${ctx.step}`)
  const limit = MODELS[s.settings.model]?.promptLimit(s.settings.mode) ?? 20000
  switch (num(a, 'kind')) {
    case 0:
      return ''
    case 1:
      return '   \n\t  '
    case 2: {
      // exactly at, one over, far over the limit
      const n = [limit, limit + 1, limit * 3, limit - 1][num(a, 'len') % 4]
      return textOfLength(rng, n)
    }
    case 3:
      return Array.from({ length: 6 }, () => edgeFragment(rng)).join(' ')
    case 4:
      return Array.from({ length: 8 }, () => rng.pick(TOKEN_LIKE)).join(' ')
    case 5:
      return `${sentence(rng)} @image_${slotsOf(s) + 1 + rng.int(0, 5)}` // names a picture the scene does not have
    default:
      return promptFor(rng, slotsOf(s))
  }
}

const SETTINGS_PATCHES: Partial<VideoSettings>[] = [
  { model: 'seedance_2_5', mode: 't2v' },
  { model: 'minimax_h3', mode: 't2v' },
  { model: 'minimax_h3', mode: 'i2v' },
  { model: 'minimax_h3', mode: 'transform' },
  { duration: 30 },
  { duration: 5 },
  { resolution: '1080p' },
  { resolution: '2k' },
  { ratio: '9:16' },
  // invalid values: the store must normalise or refuse them, never keep garbage
  { model: 'veo_9' as ModelId },
  { mode: 'x2v' as Mode },
  { duration: -1 },
  { duration: 1e9 },
  { resolution: '' },
]

// ---------------------------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------------------------

export const ACTIONS: StressAction[] = [
  // ---- scenes ----
  {
    id: 'scene.add',
    label: 'Thêm cảnh',
    group: 'scene',
    layer: 'store',
    args: (rng) => ({ title: edgeName(rng).slice(0, 300), prompt: sentence(rng) }),
    run: (_c, a) => void P().addScene({ title: str(a, 'title'), prompt: str(a, 'prompt') }),
  },
  {
    id: 'scene.import',
    label: 'Nhập nhiều cảnh',
    group: 'scene',
    layer: 'store',
    args: (rng) => ({ n: rng.chance(0.1) ? rng.int(100, 300) : rng.int(1, 30), r: rng.raw() }),
    run: (c, a) => {
      const rng = c.rng.fork(`import/${c.step}`)
      P().applyImport({ scenes: Array.from({ length: num(a, 'n') }, (_, i) => ({ title: `Nhập ${i + 1}`, prompt: rng.chance(0.2) ? edgeFragment(rng) : sentence(rng) })) })
    },
  },
  {
    id: 'scene.prompt',
    label: 'Sửa prompt',
    group: 'scene',
    layer: 'store',
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), ...promptArg(rng) }),
    run: (c, a) => {
      const s = sceneAt(num(a, 's'))
      if (s) P().setScenePrompt(s.id, buildPrompt(c, s, a))
    },
  },
  {
    id: 'scene.type',
    label: 'Gõ nhanh vào prompt',
    group: 'scene',
    layer: 'store',
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), keys: rng.int(5, 80), r: rng.raw() }),
    run: async (c, a) => {
      const s = sceneAt(num(a, 's'))
      if (!s) return
      const rng = c.rng.fork(`type/${c.step}`)
      let text = s.prompt
      for (let i = 0; i < num(a, 'keys'); i++) {
        const cur = project().scenes.find((x) => x.id === s.id)
        if (!cur) return
        text = cur.prompt
        if (rng.chance(0.15) && text.length) text = text.slice(0, -1)
        else text += rng.chance(0.05) ? rng.pick(TOKEN_LIKE) : rng.pick([' ', 'a', 'ă', 'ệ', '\u{1F3AC}', '@', '_', '1'])
        P().setScenePrompt(s.id, text)
        if (i % 10 === 9) await c.env.advance(40)
      }
    },
  },
  {
    id: 'scene.title',
    label: 'Đổi tên cảnh',
    group: 'scene',
    layer: 'store',
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), title: edgeName(rng) }),
    run: (_c, a) => {
      const s = sceneAt(num(a, 's'))
      if (s) P().updateScene(s.id, { title: str(a, 'title') })
    },
  },
  {
    id: 'scene.settings',
    label: 'Đổi model / chế độ',
    group: 'scene',
    layer: 'store',
    structural: true,
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), n: rng.int(1, 20), p: rng.int(0, SETTINGS_PATCHES.length - 1) }),
    run: (_c, a) => {
      const ids = pickMany(scenes(), num(a, 's'), num(a, 'n')).map((s) => s.id)
      P().updateSettings(ids, SETTINGS_PATCHES[num(a, 'p')])
    },
  },
  {
    id: 'scene.preset',
    label: 'Áp preset',
    group: 'scene',
    layer: 'store',
    structural: true,
    when: () => hasScenes() && project().presets.length > 0,
    args: (rng) => ({ s: rng.raw(), n: rng.int(1, 50), p: rng.raw() }),
    run: (_c, a) => {
      const preset = at(project().presets, num(a, 'p'))
      if (preset) P().applyPreset(preset.id, pickMany(scenes(), num(a, 's'), num(a, 'n')).map((s) => s.id))
    },
  },
  {
    id: 'scene.remove',
    label: 'Xoá cảnh',
    group: 'scene',
    layer: 'store',
    structural: true,
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), n: rng.chance(0.05) ? rng.int(20, 200) : rng.int(1, 3) }),
    run: (_c, a) => P().removeScenes(pickMany(scenes(), num(a, 's'), num(a, 'n')).map((s) => s.id)),
  },
  {
    id: 'scene.duplicate',
    label: 'Nhân bản cảnh',
    group: 'scene',
    layer: 'store',
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), n: rng.int(1, 5) }),
    run: (_c, a) => void P().duplicateScenes(pickMany(scenes(), num(a, 's'), num(a, 'n')).map((s) => s.id)),
  },
  {
    id: 'scene.next',
    label: 'Tạo cảnh tiếp theo',
    group: 'scene',
    layer: 'store',
    when: hasScenes,
    args: (rng) => ({ s: rng.raw() }),
    run: (_c, a) => {
      const s = sceneAt(num(a, 's'))
      if (s) P().createNextScene(s.id)
    },
  },
  {
    id: 'scene.move',
    label: 'Đổi thứ tự cảnh',
    group: 'scene',
    layer: 'store',
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), to: rng.int(-3, 6), r: rng.raw() }),
    run: (_c, a) => {
      const s = sceneAt(num(a, 's'))
      if (!s) return
      const n = project().scenes.length
      const to = [0, -1, 1, n, n + 5, 1 + (num(a, 'r') % Math.max(1, n))][Math.abs(num(a, 'to')) % 6]
      P().moveScene(s.id, to)
    },
  },
  {
    id: 'scene.frame',
    label: 'Đặt khung đầu / cuối',
    group: 'scene',
    layer: 'store',
    structural: true,
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), a: rng.raw(), last: rng.chance(0.5), clear: rng.chance(0.2) }),
    run: (_c, a) => {
      const s = sceneAt(num(a, 's'))
      const asset = a.clear ? null : (at(assets(), num(a, 'a'))?.id ?? null)
      if (s) P().setFrame(s.id, a.last ? 'last' : 'first', asset)
    },
  },
  {
    id: 'scene.layout',
    label: 'Kéo / đổi cỡ / sắp xếp',
    group: 'scene',
    layer: 'store',
    when: hasScenes,
    args: (rng) => ({ kind: rng.int(0, 3), s: rng.raw(), x: rng.int(-1e7, 1e7), y: rng.int(-1e7, 1e7), w: rng.int(-100, 100000) }),
    run: (_c, a) => {
      const s = sceneAt(num(a, 's'))
      if (!s) return
      const k = num(a, 'kind')
      if (k === 0) P().setPositions({ [s.id]: { x: num(a, 'x'), y: num(a, 'y') } })
      else if (k === 1) P().setNodeSizes({ [s.id]: { w: num(a, 'w'), h: num(a, 'w') } })
      else if (k === 2) P().setNodeSizes({ [s.id]: null })
      else P().autoLayout()
    },
  },

  // ---- image references ----
  {
    id: 'refs.link',
    label: 'Nối ảnh tham chiếu',
    group: 'refs',
    layer: 'command',
    structural: true,
    when: () => hasScenes() && hasAssets(),
    args: (rng) => ({ s: rng.raw(), ns: rng.int(1, 5), a: rng.raw(), na: rng.chance(0.2) ? rng.int(10, 45) : rng.int(1, 4) }),
    run: (_c, a) => linkAssets(pickMany(scenes(), num(a, 's'), num(a, 'ns')).map((s) => s.id), pickMany(assets(), num(a, 'a'), num(a, 'na')).map((x) => x.id)),
  },
  {
    id: 'refs.unlink',
    label: 'Cắt dây ảnh',
    group: 'refs',
    layer: 'store',
    structural: true,
    when: () => project().scenes.some((s) => s.refs.length),
    args: (rng) => ({ s: rng.raw(), r: rng.raw(), many: rng.chance(0.2) }),
    run: (_c, a) => {
      const withRefs = scenes().filter((s) => s.refs.length)
      if (a.many) {
        const pairs = pickMany(withRefs, num(a, 's'), 5).flatMap((s) => pickMany(s.refs, num(a, 'r'), 2).map((assetId) => ({ sceneId: s.id, assetId })))
        P().removeRefs(pairs)
        return
      }
      const s = at(withRefs, num(a, 's'))
      const ref = s && at(s.refs, num(a, 'r'))
      if (s && ref) P().removeRef(s.id, ref)
    },
  },
  {
    id: 'refs.move',
    label: 'Đổi thứ tự ảnh',
    group: 'refs',
    layer: 'store',
    structural: true,
    when: () => project().scenes.some((s) => s.refs.length > 1),
    args: (rng) => ({ s: rng.raw(), from: rng.int(-2, 45), to: rng.int(-2, 45) }),
    run: (_c, a) => {
      const s = at(
        scenes().filter((x) => x.refs.length > 1),
        num(a, 's'),
      )
      if (s) P().moveRef(s.id, num(a, 'from'), num(a, 'to'))
    },
  },
  {
    id: 'refs.toScene',
    label: 'Chuyển dây ảnh sang cảnh khác',
    group: 'refs',
    layer: 'store',
    structural: true,
    when: () => project().scenes.length > 1 && project().scenes.some((s) => s.refs.length),
    args: (rng) => ({ s: rng.raw(), r: rng.raw(), t: rng.raw() }),
    run: (_c, a) => {
      const from = at(
        scenes().filter((x) => x.refs.length),
        num(a, 's'),
      )
      const to = sceneAt(num(a, 't'))
      const ref = from && at(from.refs, num(a, 'r'))
      if (from && to && ref && from.id !== to.id) P().moveRefToScene(ref, from.id, to.id)
    },
  },
  {
    id: 'refs.token',
    label: 'Chèn @nhân vật vào prompt',
    group: 'refs',
    layer: 'command',
    when: () => hasScenes() && hasAssets(),
    args: (rng) => ({ s: rng.raw(), a: rng.raw() }),
    run: (_c, a) => {
      const s = sceneAt(num(a, 's'))
      const asset = at(assets(), num(a, 'a'))
      if (!s || !asset) return
      const token = ensureAssetToken(s.id, asset.id)
      const cur = project().scenes.find((x) => x.id === s.id)
      if (token && cur) P().setScenePrompt(s.id, `${cur.prompt} ${token}`)
    },
  },
  {
    id: 'refs.deleteWires',
    label: 'Xoá dây (phím Delete)',
    group: 'refs',
    layer: 'store',
    structural: true,
    when: () => project().scenes.some((s) => s.refs.length || s.firstFrame || s.lastFrame),
    args: (rng) => ({ s: rng.raw(), n: rng.int(1, 8) }),
    run: (_c, a) => {
      const list = pickMany(
        scenes().filter((s) => s.refs.length || s.firstFrame || s.lastFrame),
        num(a, 's'),
        num(a, 'n'),
      )
      P().deleteItems({
        refs: list.flatMap((s) => s.refs.slice(0, 2).map((assetId) => ({ sceneId: s.id, assetId }))),
        frames: list.flatMap((s) => [...(s.firstFrame ? [{ sceneId: s.id, which: 'first' as const }] : []), ...(s.lastFrame ? [{ sceneId: s.id, which: 'last' as const }] : [])]),
      })
    },
  },

  // ---- assets ----
  {
    id: 'asset.add',
    label: 'Thêm nhân vật',
    group: 'asset',
    layer: 'store',
    args: (rng) => ({ name: edgeName(rng), images: rng.chance(0.1) ? rng.int(10, 40) : rng.int(0, 4), kind: rng.int(0, 9) }),
    run: (c, a) => {
      const kinds = ['good', 'good', 'good', 'good', 'good', 'good', 'big', 'empty', 'mime', 'corrupt'] as const
      const imageIds = Array.from({ length: num(a, 'images') }, (_, i) => c.newImage(i === 0 ? kinds[num(a, 'kind')] : 'good'))
      P().addAsset({ name: str(a, 'name'), imageIds })
    },
  },
  {
    id: 'asset.images',
    label: 'Thêm / bớt / đổi thứ tự ảnh của nhân vật',
    group: 'asset',
    layer: 'store',
    structural: true,
    when: hasAssets,
    args: (rng) => ({ a: rng.raw(), op: rng.int(0, 3), r: rng.raw() }),
    run: (c, a) => {
      const asset = at(assets(), num(a, 'a'))
      if (!asset) return
      const ids = [...asset.imageIds]
      const op = num(a, 'op')
      if (op === 0) ids.push(c.newImage())
      else if (op === 1 && ids.length) ids.splice(num(a, 'r') % ids.length, 1)
      else if (op === 2 && ids.length > 1) ids.push(ids.shift()!)
      else ids.unshift(c.newImage())
      P().updateAsset(asset.id, { imageIds: ids })
    },
  },
  {
    id: 'asset.rename',
    label: 'Đổi tên nhân vật',
    group: 'asset',
    layer: 'store',
    when: hasAssets,
    args: (rng) => ({ a: rng.raw(), name: edgeName(rng) }),
    run: (_c, a) => {
      const asset = at(assets(), num(a, 'a'))
      if (asset) P().updateAsset(asset.id, { name: str(a, 'name') })
    },
  },
  {
    id: 'asset.remove',
    label: 'Xoá nhân vật',
    group: 'asset',
    layer: 'store',
    structural: true,
    when: hasAssets,
    args: (rng) => ({ a: rng.raw(), n: rng.int(1, 3) }),
    run: (_c, a) => P().removeAssets(pickMany(assets(), num(a, 'a'), num(a, 'n')).map((x) => x.id)),
  },
  {
    id: 'asset.canvas',
    label: 'Đưa nhân vật lên / xuống canvas',
    group: 'asset',
    layer: 'store',
    when: hasAssets,
    args: (rng) => ({ a: rng.raw(), off: rng.chance(0.4), x: rng.int(-5000, 5000), y: rng.int(-5000, 50000) }),
    run: (_c, a) => {
      const asset = at(assets(), num(a, 'a'))
      if (asset) P().setAssetOnCanvas(asset.id, a.off ? null : { x: num(a, 'x'), y: num(a, 'y') })
    },
  },

  // ---- history ----
  {
    id: 'history.undo',
    label: 'Hoàn tác',
    group: 'history',
    layer: 'store',
    args: (rng) => ({ n: rng.chance(0.1) ? rng.int(20, 250) : rng.int(1, 3) }),
    run: (_c, a) => {
      for (let i = 0; i < num(a, 'n'); i++) undo()
    },
  },
  {
    id: 'history.redo',
    label: 'Làm lại',
    group: 'history',
    layer: 'store',
    args: (rng) => ({ n: rng.chance(0.1) ? rng.int(20, 250) : rng.int(1, 3) }),
    run: (_c, a) => {
      for (let i = 0; i < num(a, 'n'); i++) redo()
    },
  },
  {
    id: 'history.roundTrip',
    label: 'Hoàn tác rồi làm lại (phải y nguyên)',
    group: 'history',
    layer: 'store',
    args: (rng) => ({ n: rng.int(1, 30) }),
    run: (c, a) => {
      const beforeProject = project()
      const before = projectKey(beforeProject)
      const n = num(a, 'n')
      const history = useProject.temporal.getState()
      const depth = { past: history.pastStates.length, future: history.futureStates.length }
      for (let i = 0; i < n; i++) undo()
      const undone = depth.past - useProject.temporal.getState().pastStates.length
      for (let i = 0; i < undone; i++) redo()
      if (projectKey(project()) !== before) {
        const path = firstDiff(JSON.parse(before), JSON.parse(projectKey(project())))
        c.report({ invariant: 'H1', severity: 'error', kind: 'app', message: `Hoàn tác ${undone} bước rồi làm lại ${undone} bước không về đúng dự án cũ (khác ở ${path}).`, detail: { path, depth } })
      }
    },
  },

  // ---- runs ----
  {
    id: 'run.enqueue',
    label: 'Tạo video',
    group: 'run',
    layer: 'store',
    when: hasScenes,
    args: (rng) => ({ s: rng.raw(), n: rng.chance(0.1) ? rng.int(20, 120) : rng.int(1, 4) }),
    run: (_c, a) => void R().enqueue(pickMany(scenes(), num(a, 's'), num(a, 'n')).map((s) => s.id)),
  },
  {
    id: 'run.cancel',
    label: 'Huỷ video đang tạo',
    group: 'run',
    layer: 'store',
    when: () => takes().some((t) => t.status === 'queued' || t.status === 'processing'),
    args: (rng) => ({ t: rng.raw() }),
    run: (_c, a) => {
      const t = at(
        takes().filter((x) => x.status === 'queued' || x.status === 'processing'),
        num(a, 't'),
      )
      if (t) R().cancel(t.id)
    },
  },
  {
    id: 'run.retry',
    label: 'Thử lại video lỗi',
    group: 'run',
    layer: 'store',
    when: () => takes().some((t) => t.status === 'failed' || t.status === 'cancelled'),
    args: (rng) => ({ t: rng.raw() }),
    run: (_c, a) => {
      const t = at(
        takes().filter((x) => x.status === 'failed' || x.status === 'cancelled'),
        num(a, 't'),
      )
      if (t) R().retry(t.id)
    },
  },
  {
    id: 'run.star',
    label: 'Chọn video',
    group: 'run',
    layer: 'store',
    when: () => takes().length > 0,
    args: (rng) => ({ t: rng.raw() }),
    run: (_c, a) => {
      const t = at(takes(), num(a, 't'))
      if (t) R().toggleStar(t.id)
    },
  },
  {
    id: 'run.delete',
    label: 'Xoá video',
    group: 'run',
    layer: 'command',
    structural: true,
    when: () => takes().length > 0,
    args: (rng) => ({ t: rng.raw(), n: rng.chance(0.05) ? rng.int(20, 100) : rng.int(1, 3) }),
    run: (_c, a) => void deleteTakes(pickMany(takes(), num(a, 't'), num(a, 'n')).map((t) => t.id), { confirm: false, toast: false }),
  },
  {
    id: 'run.rename',
    label: 'Đặt tên file video',
    group: 'run',
    layer: 'command',
    when: () => takes().length > 0,
    args: (rng) => ({ t: rng.raw(), name: edgeName(rng) }),
    run: (c, a) => {
      const t = at(takes(), num(a, 't'))
      if (!t) return
      renameTake(t.id, str(a, 'name'))
      const name = R().takes.find((x) => x.id === t.id)?.fileName
      if (name !== undefined && (name === '' || /[<>:"/\\|?*\u0000-\u001f]/.test(name))) {
        c.report({ invariant: 'F1', severity: 'error', kind: 'app', message: `Tên file video không an toàn: “${name.slice(0, 60)}”.` })
      }
    },
  },
  {
    id: 'run.wait',
    label: 'Chờ',
    group: 'run',
    layer: 'store',
    args: (rng) => ({ ms: rng.chance(0.1) ? rng.int(20_000, 120_000) : rng.int(500, 5_000) }),
    run: (c, a) => c.env.advance(c.env.kind === 'app' ? Math.min(num(a, 'ms'), 1_500) : num(a, 'ms')),
  },

  // ---- faults at the simulated canvasapp ----
  {
    id: 'fault.preset',
    label: 'Bật lỗi mạng có sẵn',
    group: 'fault',
    layer: 'store',
    args: (rng) => ({ p: rng.raw() }),
    run: (c, a) => {
      const preset = at(DEV_FAULT_PRESETS, num(a, 'p'))
      if (preset) c.server.addFault(preset.rule)
    },
  },
  {
    id: 'fault.random',
    label: 'Bật lỗi ngẫu nhiên (409 / 429 / 5xx / chậm / mất câu trả lời)',
    group: 'fault',
    layer: 'store',
    args: (rng) => ({ e: rng.int(0, 6), k: rng.int(0, 6), times: rng.int(1, 4), ms: rng.int(100, 20_000) }),
    run: (c, a) => {
      const endpoints = ['job-create', 'jobs-list', 'upload', 'canvas-put', 'job-stream', 'video-profiles', '*'] as const
      const faults = [
        { kind: 'response', status: 409, json: { detail: 'Duplicate client_request_id' } },
        { kind: 'response', status: 429, json: { detail: 'Too many requests' } },
        { kind: 'response', status: 503, json: { detail: 'Unavailable' } },
        { kind: 'processed-then', status: 502, json: { detail: 'Bad gateway' } },
        { kind: 'lost-response' },
        { kind: 'network' },
        { kind: 'slow', ms: num(a, 'ms') },
      ] as const
      c.server.addFault({ endpoint: endpoints[num(a, 'e')], fault: faults[num(a, 'k')], times: num(a, 'times') })
    },
  },
  {
    id: 'fault.job',
    label: 'Job lỗi / hết hạn / tải video lỗi',
    group: 'fault',
    layer: 'store',
    args: (rng) => ({ k: rng.int(0, 2), n: rng.int(1, 5) }),
    run: (c, a) => {
      const k = num(a, 'k')
      c.server.setJobFaults(k === 0 ? { failNext: 'Lỗi giả lập (thử nghiệm giới hạn)' } : k === 1 ? { expireNext: true } : { streamFailures: num(a, 'n') })
    },
  },
  {
    id: 'fault.force',
    label: 'Ép job xong / lỗi / hết hạn',
    group: 'fault',
    layer: 'store',
    args: (rng) => ({ j: rng.raw(), k: rng.int(0, 2) }),
    run: (c, a) => {
      const job = at(
        c.server.snapshot().jobs.filter((j) => j.status === 'queued' || j.status === 'processing'),
        num(a, 'j'),
      )
      if (job) c.server.forceJob(job.job_id, (['complete', 'fail', 'expire'] as const)[num(a, 'k')], 'Lỗi giả lập (thử nghiệm giới hạn)')
    },
  },
  {
    id: 'fault.session',
    label: 'Đăng xuất / hết phiên / đăng nhập',
    group: 'fault',
    layer: 'store',
    args: (rng) => ({ k: rng.int(0, 3) }),
    run: (c, a) => {
      const k = num(a, 'k')
      if (k === 0) c.server.logout()
      else if (k === 1) c.server.expireSession()
      else c.server.login()
    },
  },
  {
    id: 'fault.balance',
    label: 'Đổi số dư (hết credit)',
    group: 'fault',
    layer: 'store',
    args: (rng) => ({ k: rng.int(0, 2) }),
    run: (c, a) => c.server.setBalance([0, 7, 1_000_000_000][num(a, 'k')]),
  },
  {
    id: 'fault.clear',
    label: 'Tắt mọi lỗi',
    group: 'fault',
    layer: 'store',
    args: () => ({}),
    run: (c) => {
      c.server.clearFaults()
      c.server.setJobFaults({ failNext: null, expireNext: false, streamFailures: 0 })
      c.server.login()
    },
  },

  // ---- folder nodes (never a real folder: path stays null) ----
  {
    id: 'folder.add',
    label: 'Thêm Thư mục',
    group: 'folder',
    layer: 'store',
    args: (rng) => ({ name: edgeName(rng) || 'Thư mục', x: rng.int(-2000, 4000), y: rng.int(-2000, 40000) }),
    run: (_c, a) => void P().addFolder({ name: str(a, 'name'), path: null, position: { x: num(a, 'x'), y: num(a, 'y') } }),
  },
  {
    id: 'folder.link',
    label: 'Nối cảnh / video vào Thư mục',
    group: 'folder',
    layer: 'store',
    when: () => folders().length > 0 && hasScenes(),
    args: (rng) => ({ f: rng.raw(), s: rng.raw(), n: rng.int(1, 10), save: rng.chance(0.3) }),
    run: (_c, a) => {
      const f = at(folders(), num(a, 'f'))
      if (!f) return
      if (a.save) {
        const done = takes().filter((t) => t.status === 'completed')
        P().linkFolder(f.id, 'save', pickMany(done, num(a, 's'), num(a, 'n')).map((t) => t.id))
      } else P().linkFolder(f.id, 'autosave', pickMany(scenes(), num(a, 's'), num(a, 'n')).map((s) => s.id))
    },
  },
  {
    id: 'folder.unlink',
    label: 'Cắt dây Thư mục',
    group: 'folder',
    layer: 'store',
    when: () => folders().some((f) => f.autoScenes?.length || f.takes?.length),
    args: (rng) => ({ f: rng.raw(), r: rng.raw() }),
    run: (_c, a) => {
      const f = at(
        folders().filter((x) => x.autoScenes?.length || x.takes?.length),
        num(a, 'f'),
      )
      if (!f) return
      const scene = at(f.autoScenes ?? [], num(a, 'r'))
      if (scene) P().unlinkFolder(f.id, 'autosave', scene)
      else {
        const take = at(f.takes ?? [], num(a, 'r'))
        if (take) P().unlinkFolder(f.id, 'save', take)
      }
    },
  },
  {
    id: 'folder.remove',
    label: 'Xoá Thư mục',
    group: 'folder',
    layer: 'store',
    when: () => folders().length > 0,
    args: (rng) => ({ f: rng.raw() }),
    run: (_c, a) => {
      const f = at(folders(), num(a, 'f'))
      if (f) P().removeFolders([f.id])
    },
  },

  // ---- data (nothing is written: round trips in memory) ----
  {
    id: 'persist.roundTrip',
    label: 'Lưu / đọc lại / xuất-nhập (trong bộ nhớ)',
    group: 'persist',
    layer: 'store',
    args: () => ({}),
    run: (c) => {
      for (const v of checkRoundTrip(project())) c.report(v)
    },
  },
  {
    id: 'persist.corrupt',
    label: 'Đọc dữ liệu hỏng (migrate)',
    group: 'persist',
    layer: 'store',
    args: (rng) => ({ r: rng.raw(), n: rng.int(1, 12) }),
    run: (c, a) => {
      const rng = c.rng.fork(`corrupt/${c.step}`)
      const raw = JSON.parse(JSON.stringify({ ...project(), scenes: scenes().slice(0, 40), assets: assets().slice(0, 40) })) as Record<string, unknown>
      for (let i = 0; i < num(a, 'n'); i++) mutateJson(raw, rng)
      for (const v of checkMigrate(JSON.parse(JSON.stringify(raw)))) c.report(v)
      // garbage takes must never throw either
      try {
        migrateTake(rng.pick([null, 1, 'x', [], { status: 7 }, { provider: { a: 1 }, fileName: edgeFragment(rng) }]))
      } catch (e) {
        c.report({ invariant: 'D2', severity: 'error', kind: 'app', message: `migrateTake ném lỗi với dữ liệu hỏng: ${(e as Error).message}` })
      }
    },
  },
  {
    id: 'persist.parsers',
    label: 'Bộ đọc prompt / token / tên file với chữ lạ',
    group: 'persist',
    layer: 'store',
    args: (rng) => ({ r: rng.raw() }),
    run: (c) => {
      const rng = c.rng.fork(`parse/${c.step}`)
      const text = Array.from({ length: rng.int(1, 12) }, () => (rng.chance(0.5) ? edgeFragment(rng) : rng.pick(TOKEN_LIKE))).join(rng.pick(['\n', '\n\n', ' ', '\r\n---\r\n']))
      try {
        parseTokens(text)
        scanTokens(text)
        summarizeImport(parsePromptText(text))
        const s = scenes()[0]
        if (s) compileScene(project(), { ...s, prompt: text })
      } catch (e) {
        c.report({ invariant: 'D2', severity: 'error', kind: 'app', message: `Bộ đọc prompt ném lỗi: ${(e as Error).message}`, detail: { text: text.slice(0, 300) } })
      }
      const name = edgeName(rng)
      try {
        const safe = safeFileName(name)
        const clean = cleanTakeFileName(name)
        for (const out of [safe, clean ?? 'x']) {
          if (!out || /[<>:"/\\|?*\u0000-\u001f]/.test(out)) c.report({ invariant: 'F1', severity: 'error', kind: 'app', message: `Tên file không an toàn sau khi làm sạch: “${String(out).slice(0, 60)}”.` })
        }
      } catch (e) {
        c.report({ invariant: 'F1', severity: 'error', kind: 'app', message: `Làm sạch tên file ném lỗi: ${(e as Error).message}` })
      }
    },
  },

  // ---- UI stores (app only) ----
  {
    id: 'ui.view',
    label: 'Đổi chế độ xem',
    group: 'ui',
    layer: 'ui',
    args: (rng) => ({ v: rng.int(0, 2) }),
    run: (_c, a) => useUI.getState().setView((['canvas', 'table', 'storyboard'] as const)[num(a, 'v')]),
  },
  {
    id: 'ui.select',
    label: 'Chọn nhiều thứ',
    group: 'ui',
    layer: 'ui',
    args: (rng) => ({ s: rng.raw(), n: rng.chance(0.1) ? rng.int(100, 2000) : rng.int(0, 10) }),
    run: (_c, a) => useUI.getState().select(pickMany(scenes(), num(a, 's'), num(a, 'n')).map((s) => s.id)),
  },
  {
    id: 'ui.panels',
    label: 'Mở / đóng bảng, kiểu dây, minimap',
    group: 'ui',
    layer: 'ui',
    args: (rng) => ({ k: rng.int(0, 5), on: rng.chance(0.5) }),
    run: (_c, a) => {
      const ui = useUI.getState()
      const on = !!a.on
      switch (num(a, 'k')) {
        case 0:
          return ui.setLeftOpen(on)
        case 1:
          return ui.setRightOpen(on)
        case 2:
          return ui.setQueueOpen(on)
        case 3:
          return ui.setMinimap(on)
        case 4:
          return ui.setTakeDisplay(on ? 'chosen' : 'all')
        default:
          return ui.cycleEdgeMode()
      }
    },
  },
]

/** Random damage to a JSON value: drop / retype / duplicate fields, deep in the tree. */
export function mutateJson(root: Record<string, unknown>, rng: Rng) {
  let node: unknown = root
  for (let depth = 0; depth < 4; depth++) {
    if (!node || typeof node !== 'object') break
    const keys = Object.keys(node as object)
    if (!keys.length) break
    const k = rng.pick(keys)
    const child = (node as Record<string, unknown>)[k]
    if (depth === 3 || !child || typeof child !== 'object' || rng.chance(0.3)) {
      const garbage = [null, undefined, -1, 1e308, NaN, '', 'x'.repeat(5000), [], {}, true, [null], { order: 'a' }, edgeFragment(rng)]
      if (rng.chance(0.2)) {
        if (Array.isArray(node)) node.splice(Number(k), 1)
        else delete (node as Record<string, unknown>)[k]
      } else (node as Record<string, unknown>)[k] = rng.pick(garbage)
      return
    }
    node = child
  }
}

export const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]))

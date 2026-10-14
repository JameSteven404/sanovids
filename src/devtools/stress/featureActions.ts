// 0.6.0 actions use the public commands and the same draft registry as the node editor; no DOM or network.
import { imageKey, imageSlotsFor, LABELLED_TOKEN_RE, parseTokens, TOKEN_RE } from '../../core/compile'
import { buildFilmItems } from '../../core/filmItems'
import type { KeyEventLike } from '../../core/keymap'
import { migrateProject } from '../../core/migrate'
import { assetDeleteImpact, groupKeyOf, groupOf, imagePlaceholders } from '../../core/placeholders'
import { nodeFullKey, playerKey, type FocusKind, type NodeFullKey, type TransportOp } from '../../core/transportKeys'
import type { Asset, Scene, Take } from '../../core/types'
import { deleteLibraryAssets, deleteLibrarySelection, registerLibraryView } from '../../libraryActions'
import { flushAll, register } from '../../lib/promptDrafts'
import { useCanvasPrefs } from '../../lib/canvasPrefs'
import { canvasNodeId, decodeRemoteId, sceneNodeId } from '../../providers/canvasapp/mapping'
import { gatewayProvider } from '../../providers'
import { importSiteJobs, scanForImport } from '../../siteJobActions'
import { answerConfirm, useConfirm } from '../../store/confirm'
import { redo, undo, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useSceneEditor } from '../../store/sceneEditor'
import { useUI } from '../../store/ui'
import { checkStructural, imageTokenCount, projectKey } from './invariants'
import { at } from './rng'
import { sessionActive } from './session'
import type { StressAction, StressContext } from './types'

const P = () => useProject.getState()
const R = () => useRuns.getState()
const problem = (c: StressContext, invariant: string, message: string, detail?: unknown) => c.report({ invariant, severity: 'error', kind: 'app', message, detail })
// Labels inside tokens are metadata, deliberately removed by an explicit fill / replacement.
const prose = (text: string) => {
  for (const ph of imagePlaceholders(text).reverse()) text = text.slice(0, ph.start) + text.slice(ph.end)
  return text.replace(LABELLED_TOKEN_RE, '').replace(TOKEN_RE, '')
}

export function checkExplicitRewrite(before: string, after: string): boolean {
  return prose(before) === prose(after) && imageTokenCount(before) === imageTokenCount(after)
}

// ---- P3 for explicit fills / replacements (not structural steps: the runner's own P3 never sees them) ----

type ImageItem = { ph: true; start: number } | { ph: false; start: number; key: string | undefined }

/** The image tokens and red placeholders of a prompt in text order; a token with the picture it names (undefined: none). */
function imageItems(prompt: string, assets: Asset[], refs: string[]): ImageItem[] {
  const slots = imageSlotsFor(assets, refs).map(imageKey)
  const items: ImageItem[] = []
  for (const t of parseTokens(prompt)) if (t.kind === 'image') items.push({ ph: false, start: t.start, key: t.n >= 1 && t.n <= slots.length ? slots[t.n - 1] : undefined })
  for (const p of imagePlaceholders(prompt)) items.push({ ph: true, start: p.start })
  return items.sort((a, b) => a.start - b.start)
}

type SceneText = Pick<Scene, 'prompt' | 'refs'>
const itemText = (i: ImageItem) => (i.ph ? 'chữ đỏ' : (i.key ?? 'không có ảnh'))

/**
 * After filling the group whose placeholders start at `members` with `assetId`: those may become that character's
 * pictures (or stay red when it has too few); every other token names the same picture as before, in the same order,
 * and every other placeholder stays red. A message when not (null = fine; a changed token count is X3's).
 */
export function fillKeyProblem(before: SceneText, after: SceneText, assets: Asset[], members: ReadonlySet<number>, assetId: string): string | null {
  const x = imageItems(before.prompt, assets, before.refs)
  const y = imageItems(after.prompt, assets, after.refs)
  if (x.length !== y.length) return null
  for (let i = 0; i < x.length; i++) {
    const u = x[i]
    const v = y[i]
    if (u.ph && members.has(u.start)) {
      if (!v.ph && !v.key?.startsWith(assetId + ':')) return `Chữ đỏ thứ ${i + 1} được gắn vào ảnh khác (${itemText(v)}).`
    } else if (u.ph) {
      if (!v.ph) return `Chữ đỏ thứ ${i + 1} ngoài nhóm được gắn bị đổi thành token (${itemText(v)}).`
    } else if (u.key !== undefined && (v.ph || v.key !== u.key)) {
      return `Token ảnh thứ ${i + 1} giờ trỏ sang ảnh khác (${u.key} → ${itemText(v)}).`
    }
  }
  return null
}

/**
 * After replacing `oldId` by `newId` (renumbering on): picture k of the old character is picture k of the new one (a
 * red placeholder when the new one has fewer); every other token names the same picture; placeholders stay red.
 */
export function replaceKeyProblem(before: SceneText, after: SceneText, assets: Asset[], oldId: string, newId: string): string | null {
  const oldImages = assets.find((a) => a.id === oldId)?.imageIds ?? []
  const newImages = assets.find((a) => a.id === newId)?.imageIds ?? []
  const x = imageItems(before.prompt, assets, before.refs)
  const y = imageItems(after.prompt, assets, after.refs)
  if (x.length !== y.length) return null
  for (let i = 0; i < x.length; i++) {
    const u = x[i]
    const v = y[i]
    if (u.ph) {
      if (!v.ph) return `Chữ đỏ thứ ${i + 1} bị đổi thành token khi thay nhân vật (${itemText(v)}).`
      continue
    }
    if (u.key === undefined) continue
    let want: string | null = u.key
    if (u.key.startsWith(oldId + ':')) {
      const k = oldImages.indexOf(u.key.slice(oldId.length + 1))
      want = k >= 0 && k < newImages.length ? `${newId}:${newImages[k]}` : null
    }
    if (want === null ? !v.ph : v.ph || v.key !== want) return `Token ảnh thứ ${i + 1} trỏ sai ảnh sau khi thay (${u.key} → ${itemText(v)}, cần ${want ?? 'chữ đỏ'}).`
  }
  return null
}

// ---- transport keys: the expectation is written out here, never read from core/transportKeys ----

const KEY_EVENTS: Record<string, KeyEventLike> = {
  Space: { key: ' ', code: 'Space' },
  KeyJ: { key: 'j', code: 'KeyJ' },
  KeyK: { key: 'k', code: 'KeyK' },
  KeyL: { key: 'l', code: 'KeyL' },
  KeyM: { key: 'm', code: 'KeyM' },
  KeyF: { key: 'f', code: 'KeyF' },
  KeyX: { key: 'x', code: 'KeyX' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown' },
  Home: { key: 'Home', code: 'Home' },
  End: { key: 'End', code: 'End' },
  Enter: { key: 'Enter', code: 'Enter' },
  Tab: { key: 'Tab', code: 'Tab' },
  Escape: { key: 'Escape', code: 'Escape' },
}
export const TRANSPORT_CODES = Object.keys(KEY_EVENTS)
const FOCI: FocusKind[] = ['none', 'typing', 'slider', 'control-key', 'control-mouse']
/** Plan "Phím tắt Premiere" §3.5 for the viewer / "Phát liền" (Windows keys). */
const VIEWER_OPS: Record<string, TransportOp> = {
  Space: 'toggle',
  KeyK: 'stop',
  KeyL: 'forward',
  KeyJ: 'reverse',
  ArrowLeft: 'frame-back',
  ArrowRight: 'frame-fwd',
  ArrowUp: 'clip-prev',
  ArrowDown: 'clip-next',
  Home: 'start',
  End: 'end',
  Escape: 'exit',
}
/** …and a take node's fullscreen player: ↑ / ↓ = volume (one clip only), F leaves it too, M = ★. */
const NODE_FULL_OPS: Record<string, TransportOp> = { ...VIEWER_OPS, ArrowUp: 'volume-up', ArrowDown: 'volume-down', KeyF: 'exit', KeyM: 'star' }
const SLIDER_CODES = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

/** What a key must do in the viewer / "Phát liền" with this focus (null = left alone). */
export function expectedPlayerOp(code: string, focus: FocusKind, player: 'viewer' | 'film'): TransportOp | null {
  if (focus === 'typing') return null
  if (focus === 'slider' && SLIDER_CODES.has(code)) return null
  if (focus === 'control-key' && (code === 'Space' || code === 'Enter')) return null
  if (code === 'KeyM') return player === 'viewer' ? 'star' : null
  return VIEWER_OPS[code] ?? null
}

/** What a key must do in a take node's fullscreen player (it decides every key: none reaches the canvas behind it). */
export function expectedNodeFull(code: string, focus: FocusKind): NodeFullKey {
  if (code === 'Tab') return { kind: 'tab' }
  if (focus === 'slider' && SLIDER_CODES.has(code)) return { kind: 'slider' }
  if (code === 'Enter' && (focus === 'control-key' || focus === 'control-mouse')) return { kind: 'default' }
  const op = NODE_FULL_OPS[code]
  return op ? { kind: 'op', op } : { kind: 'block' }
}

/** Where the players' key rules (default: the app's) differ from the expectation, for these keys and every focus. */
export function transportMismatches(codes: readonly string[] = TRANSPORT_CODES, rules = { playerKey, nodeFullKey }): string[] {
  const out: string[] = []
  for (const code of codes) {
    const e = KEY_EVENTS[code]
    if (!e) continue
    for (const focus of FOCI) {
      for (const player of ['viewer', 'film'] as const) {
        const got = rules.playerKey(e, focus, { player, mac: false })
        const want = expectedPlayerOp(code, focus, player)
        if (got !== want) out.push(`${player} · ${focus} · ${code}: ${got ?? 'không'} ≠ ${want ?? 'không'}`)
      }
      const got = rules.nodeFullKey(e, focus, { mac: false })
      const want = expectedNodeFull(code, focus)
      if (got.kind !== want.kind || (got.kind === 'op' && want.kind === 'op' && got.op !== want.op)) out.push(`node-full · ${focus} · ${code}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`)
    }
  }
  return out
}

/** The take "Phát liền" must play for a scene: its newest starred finished take, else its newest finished one. */
export function expectedFilmTake(takes: readonly Take[]): Take | null {
  const done = takes.filter((t) => t.status === 'completed').sort((a, b) => b.number - a.number)
  return done.find((t) => t.starred) ?? done[0] ?? null
}

/** Still this run's world after an await: the session was not stopped (another project opened, dev mode locked…). */
const stillOurs = (projectId: string) => sessionActive() && P().project.id === projectId

/** A valid scene to exercise the queue even after a destructive stress action emptied the project. */
function runnable(c: StressContext, pick: number) {
  let s = at(P().project.scenes, pick)
  if (!s) {
    const id = P().addScene({ prompt: 'Máy quay đi qua khu vườn.' })
    s = P().project.scenes.find((x) => x.id === id)!
  }
  P().updateSettings([s.id], { model: 'seedance_2_5', mode: 't2v', duration: 5, resolution: '720p', ratio: '16:9' })
  P().setScenePrompt(s.id, `Máy quay đi qua khu vườn. Lượt ${c.step}.`)
  return s.id
}

/** Let an async gateway read run under fake time too (without waiting on a fake timer from real time). */
async function advancing<T>(c: StressContext, promise: Promise<T>): Promise<T> {
  let done = false
  const settled = promise.finally(() => { done = true })
  // Attach rejection immediately; await below still propagates it.
  void settled.catch(() => undefined)
  for (let i = 0; !done && i < 120; i++) await c.env.advance(250)
  return settled
}

export const FEATURE_ACTIONS: StressAction[] = [
  {
    id: 'editor.savePending', label: 'Lưu ngay khi bản nháp chưa commit', group: 'persist', layer: 'store',
    when: (c) => !!c.env.saveProject && P().project.scenes.length > 0,
    args: (r) => ({ s: r.raw(), text: r.pick([' ệ cuối', ' 👨‍👩‍👧 cuối']) }),
    run: async (c, a) => {
      const s = at(P().project.scenes, Number(a.s))!
      const expected = s.prompt + String(a.text)
      const commit = () => { P().setScenePrompt(s.id, expected) }
      const off = register(s.id, commit)
      try {
        // NodePromptField.onKeyDown commits modifiers BEFORE Ctrl+S bubbles to useShortcuts -> persist.flush.
        commit()
        const saved = await advancing(c, c.env.saveProject!())
        c.hit('editor.persistPending')
        const got = saved?.scenes.find((x) => x.id === s.id)?.prompt
        if (got !== expected) problem(c, 'ED2', 'Lưu ngay khi đang gõ ghi prompt khác bản nháp đang hiện.', { sceneId: s.id, shown: expected, saved: got })
        if (c.env.switchProjectRoundTrip) {
          await advancing(c, c.env.switchProjectRoundTrip())
          c.hit('editor.persistSwitch')
          const reopened = P().project.scenes.find((x) => x.id === s.id)?.prompt
          if (reopened !== expected) problem(c, 'ED3', 'Đổi dự án rồi mở lại mất chữ đã commit.', { sceneId: s.id, shown: expected, reopened })
        }
      } finally { flushAll(); off() }
    },
  },
  {
    id: 'refs.fill', label: 'Gắn ảnh vào chữ đỏ', group: 'refs', layer: 'store',
    when: () => P().project.scenes.some((s) => imagePlaceholders(s.prompt).length > 0) && P().project.assets.length > 0,
    args: (r) => ({ s: r.raw(), a: r.raw() }),
    run: (c, a) => {
      const s = at(P().project.scenes.filter((s) => imagePlaceholders(s.prompt).length), Number(a.s))!
      const ph = imagePlaceholders(s.prompt)[0]
      const asset = at(P().project.assets, Number(a.a))!
      const before = P().project
      const members = new Set(groupOf(s.prompt, before.assets, s.refs, groupKeyOf(ph.text))?.members.map((m) => m.start) ?? [])
      const result = P().fillPlaceholder(s.id, ph.text, asset.id)
      c.hit(result.ok ? 'placeholder.filled' : 'placeholder.fillRefused')
      const after = P().project.scenes.find((x) => x.id === s.id)!
      if (!result.ok && P().project !== before) problem(c, 'PH1', 'Gắn ảnh bị từ chối nhưng vẫn đổi dự án.')
      if (result.ok && !checkExplicitRewrite(s.prompt, after.prompt)) problem(c, 'X3', 'Gắn chữ đỏ làm mất chữ hoặc đổi số token ảnh.', { before: s.prompt, after: after.prompt })
      // P3: only the filled group changes picture; every other token keeps its own
      const drift = result.ok ? fillKeyProblem(s, after, P().project.assets, members, asset.id) : null
      if (drift) problem(c, 'P3', `Gắn chữ đỏ làm lệch nhân vật: ${drift}`, { before: s.prompt, after: after.prompt, refsBefore: s.refs, refsAfter: after.refs, assetId: asset.id })
    },
  },
  {
    id: 'refs.replace', label: 'Thay nhân vật đã nối', group: 'refs', layer: 'store',
    when: () => P().project.scenes.some((s) => s.refs.length > 0) && P().project.assets.length > 1,
    args: (r) => ({ s: r.raw(), a: r.raw(), old: r.raw() }),
    run: (c, a) => {
      const s = at(P().project.scenes.filter((s) => s.refs.length), Number(a.s))!
      const asset = at(P().project.assets, Number(a.a))!
      const before = P().project
      const oldId = at(s.refs, Number(a.old))!
      const result = P().replaceRef(s.id, oldId, asset.id)
      c.hit(result.ok ? 'placeholder.replaced' : 'placeholder.replaceRefused')
      const after = P().project.scenes.find((x) => x.id === s.id)!
      if (!result.ok && P().project !== before) problem(c, 'PH1', 'Thay ảnh bị từ chối nhưng vẫn đổi dự án.')
      if (result.ok && !checkExplicitRewrite(s.prompt, after.prompt)) problem(c, 'X3', 'Thay nhân vật làm mất chữ hoặc đổi số token ảnh.', { before: s.prompt, after: after.prompt })
      // P3: only the replaced character's tokens change picture (renumbering off keeps numbers as written: not compared)
      const drift = result.ok && before.settings.autoRenumber ? replaceKeyProblem(s, after, P().project.assets, oldId, asset.id) : null
      if (drift) problem(c, 'P3', `Thay nhân vật làm lệch nhân vật: ${drift}`, { before: s.prompt, after: after.prompt, refsBefore: s.refs, refsAfter: after.refs, oldId, newId: asset.id })
    },
  },
  {
    id: 'library.bulk', label: 'Chọn nhiều mục, xoá rồi hoàn tác', group: 'asset', layer: 'command',
    args: (r) => ({ n: r.pick([1, 2, 20, 100, 200]), start: r.raw() }),
    run: (c, a) => {
      const n = Number(a.n)
      while (P().project.assets.length < n) P().addAsset({ name: `Nhân vật ${P().project.assets.length + 1}`, imageIds: [c.newImage()] })
      const list = P().project.assets
      const ids = Array.from({ length: n }, (_, i) => list[(Number(a.start) + i) % list.length].id)
      const before = P().project
      const impact = assetDeleteImpact(before, ids)
      // Register a headless view only; in-app use the existing library's registration.
      const off = c.env.kind === 'headless' ? registerLibraryView({ visibleIds: () => P().project.assets.map((x) => x.id), collapsed: () => false }) : () => undefined
      try {
        useUI.getState().setLibrarySelection(ids)
        if (c.env.kind === 'headless') deleteLibrarySelection()
        else deleteLibraryAssets(ids)
        if (impact.needsConfirm !== !!useConfirm.getState().request) problem(c, 'LB1', 'Câu hỏi xoá không khớp assetDeleteImpact.')
        answerConfirm(true)
        const after = P().project
        if (ids.some((id) => after.assets.some((x) => x.id === id))) problem(c, 'LB1', 'Xoá thư viện còn sót mục đã chọn.')
        for (const v of checkStructural(before, after, 'Xoá thư viện', true, true)) c.report(v)
        if (useUI.getState().librarySelection.some((id) => ids.includes(id))) problem(c, 'LB1', 'Lựa chọn còn giữ mục đã xoá.')
        undo()
        c.hit(`library.deleteUndo.${n}`)
        if (projectKey(P().project) !== projectKey(before)) problem(c, 'LB2', 'Một bước hoàn tác không khôi phục đủ thư viện và prompt.')
      } finally { off(); answerConfirm(false) }
    },
  },
  {
    id: 'editor.draft', label: 'Gõ bản nháp rồi chuyển cảnh / hoàn tác / lưu', group: 'scene', layer: 'store',
    when: () => P().project.scenes.length > 1,
    args: (r) => ({ s: r.raw(), op: r.int(0, 3), text: r.pick([' tiếng Việt ệ', ' 👩‍👩‍👧‍👦', '\ne\u0302\u0301', ' chữ cuối']) }),
    run: async (c, a) => {
      const before = P().project
      const s = at(before.scenes, Number(a.s))!
      const next = before.scenes.find((x) => x.id !== s.id)!
      const pref = useCanvasPrefs.getState().nodeEditor
      useCanvasPrefs.setState({ nodeEditor: 'click' })
      useSceneEditor.getState().open(s.id)
      let shown = s.prompt
      let committed = s.prompt
      const off = register(s.id, () => {
        if (shown === committed) return
        committed = shown
        P().setScenePrompt(s.id, shown)
      })
      // The mounted field follows external store edits (undo / redo), like its layout effect.
      const offStore = useProject.subscribe((st) => {
        const prompt = st.project.scenes.find((x) => x.id === s.id)?.prompt
        if (st.project.id === before.id && prompt !== undefined && prompt !== committed) shown = committed = prompt
      })
      const expected = shown + String(a.text)
      shown = expected
      try {
        c.hit(`editor.operation.${a.op}`)
        if (a.op === 0) useSceneEditor.getState().open(next.id)
        else if (a.op === 1) useSceneEditor.getState().openPanel(s.id)
        else flushAll()
        if (P().project.scenes.find((x) => x.id === s.id)?.prompt !== expected) problem(c, 'ED1', 'Đổi editor / flush làm mất ký tự vừa gõ.')
        if (a.op === 2) { undo(); redo() }
        const saved = c.env.saveProject ? await advancing(c, c.env.saveProject()) : migrateProject(JSON.parse(JSON.stringify(P().project)))
        if (saved?.scenes.find((x) => x.id === s.id)?.prompt !== shown) problem(c, 'ED2', 'Prompt lưu / đọc lại khác chữ đang hiện.')
        // Real project switching over isolated memory storage; the app sandbox stops on a user project switch.
        if (a.op === 3 && c.env.switchProjectRoundTrip) {
          await advancing(c, c.env.switchProjectRoundTrip())
          if (useSceneEditor.getState().sceneId !== null) problem(c, 'ED3', 'Editor cũ còn mở sau khi đổi dự án.')
          if (P().project.scenes.find((x) => x.id === s.id)?.prompt !== expected) problem(c, 'ED3', 'Mở lại dự án làm mất bản nháp đã lưu.')
        }
      } finally {
        offStore(); off()
        useSceneEditor.getState().close(); useSceneEditor.getState().closePanel()
        useCanvasPrefs.setState({ nodeEditor: pref })
      }
    },
  },
  {
    id: 'download.chaos', label: 'Tải video bị đứt / treo / quá lớn', group: 'run', layer: 'store',
    args: (r) => ({ s: r.raw(), kind: r.int(0, 2), range: r.chance(0.5) }),
    run: async (c, a) => {
      c.server.setConfig({ rangeSupport: !!a.range })
      const fault = a.kind === 0 ? { kind: 'cut' as const, fraction: 0.5 } : a.kind === 1 ? { kind: 'stall' as const, fraction: 0.5 } : { kind: 'oversize' as const }
      c.server.addFault({ endpoint: 'job-stream', fault, times: 1 })
      R().enqueue([runnable(c, Number(a.s))])
      await c.env.advance(c.env.kind === 'headless' ? 15_000 : 250)
    },
  },
  {
    id: 'import.site', label: 'Nhập job trên trang khi hàng đợi đang chạy', group: 'run', layer: 'command',
    args: (r) => ({
      s: r.raw(),
      node: r.raw(),
      same: r.chance(0.5),
      // job-create answers: 0 normal, 1 lost (handled, answer lost), 2 handled then a 502 — that POST stays unresolved
      fault: r.pick([0, 0, 1, 2]),
      latency: r.pick([0, 0, 400, 1500]),
      force: r.int(0, 3),
    }),
    run: async (c, a) => {
      const pid = P().project.id
      const headless = c.env.kind === 'headless'
      const latency = c.server.config().latencyMs
      // a slow site keeps the app's POST open while the site job is made, scanned and claimed (the ownership window)
      c.server.setConfig({ latencyMs: Number(a.latency) })
      if (a.fault === 1) c.server.addFault({ endpoint: 'job-create', fault: { kind: 'lost-response' }, times: 1 })
      else if (a.fault === 2) c.server.addFault({ endpoint: 'job-create', fault: { kind: 'processed-then', status: 502 }, times: 1 })
      try {
        const sceneId = runnable(c, Number(a.s))
        R().enqueue([sceneId])
        await c.env.advance(headless ? 1_000 : 250)
        if (!stillOurs(pid)) return
        const nodes = c.server.siteNodes()
        if (!nodes) return
        // the node of the take just sent (its POST may own a job made there), or any node of the session
        const same = a.same ? nodes.nodes.find((n) => n.id === sceneNodeId(pid, sceneId) || n.id === canvasNodeId(sceneId)) : undefined
        const node = same ?? at(nodes.nodes, Number(a.node))
        if (!node) return
        const site = c.server.createSiteJob({ projectId: nodes.projectId, nodeId: node.id })
        if (!site.ok) return // The site also refuses another running job on that node.
        c.hit('import.siteCreated')
        const scan = await advancing(c, scanForImport('dev'))
        if (!stillOurs(pid)) return
        // "Chọn tất cả": every job the scan offers — an app-owned job offered by mistake would get a second owner (IJ1)
        const ids = scan.scan.candidates.map((x) => x.jobId)
        if (!ids.length) return // The unresolved POST ownership window may legitimately hide it.
        const unresolved = R().takes.some((t) => !t.imported && t.provider === 'dev' && t.status === 'processing' && !t.remoteId)
        const imported = await advancing(c, importSiteJobs(scan, ids))
        if (!stillOurs(pid)) return
        const adopted = imported?.takeIds ?? []
        if (adopted.length) {
          c.hit('import.adopted')
          if (unresolved) c.hit('import.whileUnresolvedPost')
        }
        // Nothing armed, nothing in flight: the site job offered must come in (otherwise a POST may reserve it at claim time).
        if (!adopted.length && a.fault === 0 && a.latency === 0 && !unresolved && ids.includes(site.jobId)) problem(c, 'IJ1', 'Job đủ điều kiện không được nhập.', { site, imported })
        await advancing(c, importSiteJobs(scan, ids)) // stale scan, intentionally repeated
        if (!stillOurs(pid)) return
        c.hit('import.staleScanRetried')
        for (const jobId of ids) {
          const owners = R().takes.filter((t) => t.remoteId && decodeRemoteId(t.remoteId)?.jobId === jobId)
          if (owners.length > 1) problem(c, 'IJ1', 'Job trên trang bị nhận nhiều lần.', { jobId, owners: owners.map((t) => t.id) })
        }
        // An imported job ending badly on the site before "Thử lại": the imported take is never posted again (IJ2).
        const first = R().takes.find((t) => t.id === adopted[0])
        const firstJob = first?.remoteId ? decodeRemoteId(first.remoteId)?.jobId : undefined
        if (firstJob && Number(a.force) < 2 && c.server.forceJob(firstJob, a.force === 0 ? 'fail' : 'expire')) {
          c.hit('import.forcedEnd')
          await c.env.advance(headless ? 3_000 : 250)
          if (!stillOurs(pid)) return
        }
        for (const id of adopted) R().retry(id)
      } finally {
        c.server.setConfig({ latencyMs: latency })
      }
    },
  },
  {
    id: 'login.restart', label: 'Giữ đăng nhập / khởi động lại / đăng xuất giữa hàng đợi', group: 'run', layer: 'store',
    args: (r) => ({ s: r.raw(), s2: r.raw(), keep: r.chance(0.5), logout: r.chance(0.5), retry: r.chance(0.4) }),
    run: async (c, a) => {
      // The session's own provider, taken before any await: the sandbox may stop the session meanwhile (another
      // project opened, development mode locked) and put the app's dev gateway back — that one is never reset here.
      const gw = gatewayProvider('dev')
      const pid = P().project.id
      const ours = () => stillOurs(pid) && gatewayProvider('dev') === gw
      const headless = c.env.kind === 'headless'
      c.server.login()
      c.server.setConfig({ loginCookie: 'session', encryption: 'ok', dedupe: false })
      await c.bridge.setKeepLogin(!!a.keep)
      if (!ours()) return
      R().enqueue([runnable(c, Number(a.s))])
      await c.env.advance(250)
      if (!ours()) return
      const restart = await c.bridge.simulateRestart()
      c.hit(restart.survived ? 'login.kept' : 'login.notKept')
      if (restart.survived !== !!a.keep) problem(c, 'RL1', 'Khởi động lại không theo lựa chọn giữ đăng nhập.')
      if (a.logout) {
        await c.bridge.logout()
        if (!ours()) return
        gw.reset()
      }
      if (!c.server.isAuthenticated()) {
        if (!ours()) return
        // Work waiting while logged out (RL3: nothing may be sent — no job, no upload): a new take, sometimes a failed one again.
        R().enqueue([runnable(c, Number(a.s2))])
        if (a.retry) {
          const t = at(R().takes.filter((t) => t.status === 'failed' && t.provider === 'dev' && !t.imported), Number(a.s2))
          if (t) R().retry(t.id)
        }
        const waiting = () => R().takes.some((t) => t.provider === 'dev' && !t.imported && (t.status === 'queued' || (t.status === 'processing' && !t.remoteId)))
        if (waiting()) c.hit('login.workWhileOut')
        const balance = c.server.balance()
        await c.env.advance(headless ? 3_000 : 250)
        if (!ours()) return
        if (waiting()) c.hit('login.workStillWaiting')
        if (c.server.balance() < balance) problem(c, 'RL2', 'Vẫn trừ credit khi đã đăng xuất.')
      }
      c.server.login()
    },
  },
  {
    id: 'ui.transport', label: 'Phím player, Phát liền và màn hình đã ẩn', group: 'ui', layer: 'store',
    args: (r) => ({ view: r.pick(['table', 'storyboard']), code: r.pick(TRANSPORT_CODES), star: r.chance(0.5), t: r.raw() }),
    run: (c, a) => {
      useUI.getState().setView(a.view as 'table' | 'storyboard')
      if (useUI.getState().view !== 'canvas') problem(c, 'UI1', 'Màn hình đã ẩn vẫn mở được.')
      // UI2: what the key does in the viewer, "Phát liền" and a take node's fullscreen player, for every kind of focus
      const keys = transportMismatches([String(a.code)])
      if (keys.length) problem(c, 'UI2', `Phím player sai luật: ${keys[0]}`, { mismatches: keys.slice(0, 10) })
      c.hit('transport.checked')
      // UI3: "Phát liền" plays every scene once, in scene order, each with its ★ take (else its newest finished one)
      const starred = a.star ? at(R().takes.filter((t) => t.status === 'completed'), Number(a.t)) : undefined
      if (starred) R().toggleStar(starred.id)
      const scenes = P().project.scenes
      const takes = R().takes
      const film = buildFilmItems(scenes, takes)
      const orderOf = new Map(scenes.map((s) => [s.id, s.order]))
      if (film.length !== scenes.length || new Set(film.map((x) => x.sceneId)).size !== scenes.length) problem(c, 'UI3', 'Phát liền thiếu hoặc lặp cảnh.')
      for (let i = 1; i < film.length; i++) {
        if ((orderOf.get(film[i - 1].sceneId) ?? 0) > (orderOf.get(film[i].sceneId) ?? 0)) {
          problem(c, 'UI3', 'Phát liền sai thứ tự cảnh.', { at: i })
          break
        }
      }
      const byScene = new Map<string, Take[]>()
      for (const t of takes) {
        const list = byScene.get(t.sceneId)
        if (list) list.push(t)
        else byScene.set(t.sceneId, [t])
      }
      for (const item of film) {
        const want = expectedFilmTake(byScene.get(item.sceneId) ?? [])
        if ((item.take?.id ?? null) !== (want?.id ?? null)) {
          problem(c, 'UI3', 'Phát liền phát sai take của cảnh.', { sceneId: item.sceneId, got: item.take?.id ?? null, want: want?.id ?? null })
          break
        }
      }
      const now = starred ? takes.find((t) => t.id === starred.id) : undefined
      if (now?.starred) {
        c.hit('film.starred')
        if (film.find((x) => x.sceneId === now.sceneId)?.take?.id !== now.id) problem(c, 'UI3', 'Take vừa gắn ★ không được Phát liền chọn.', { takeId: now.id })
      }
    },
  },
]

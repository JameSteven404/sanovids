// 0.6.0 actions use the public commands and the same draft registry as the node editor; no DOM or network.
import { LABELLED_TOKEN_RE, TOKEN_RE } from '../../core/compile'
import { buildFilmItems } from '../../core/filmItems'
import { migrateProject } from '../../core/migrate'
import { assetDeleteImpact, imagePlaceholders } from '../../core/placeholders'
import { playerKey } from '../../core/transportKeys'
import { deleteLibraryAssets, deleteLibrarySelection, registerLibraryView } from '../../libraryActions'
import { flushAll, register } from '../../lib/promptDrafts'
import { useCanvasPrefs } from '../../lib/canvasPrefs'
import { decodeRemoteId } from '../../providers/canvasapp/mapping'
import { gatewayProvider } from '../../providers'
import { importSiteJobs, scanForImport } from '../../siteJobActions'
import { answerConfirm, useConfirm } from '../../store/confirm'
import { redo, undo, useProject } from '../../store/project'
import { useRuns } from '../../store/runs'
import { useSceneEditor } from '../../store/sceneEditor'
import { useUI } from '../../store/ui'
import { checkStructural, imageTokenCount, projectKey } from './invariants'
import { at } from './rng'
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
      const result = P().fillPlaceholder(s.id, ph.text, asset.id)
      c.hit(result.ok ? 'placeholder.filled' : 'placeholder.fillRefused')
      const after = P().project.scenes.find((x) => x.id === s.id)!
      if (!result.ok && P().project !== before) problem(c, 'PH1', 'Gắn ảnh bị từ chối nhưng vẫn đổi dự án.')
      if (result.ok && !checkExplicitRewrite(s.prompt, after.prompt)) problem(c, 'X3', 'Gắn chữ đỏ làm mất chữ hoặc đổi số token ảnh.', { before: s.prompt, after: after.prompt })
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
      const result = P().replaceRef(s.id, at(s.refs, Number(a.old))!, asset.id)
      c.hit(result.ok ? 'placeholder.replaced' : 'placeholder.replaceRefused')
      const after = P().project.scenes.find((x) => x.id === s.id)!
      if (!result.ok && P().project !== before) problem(c, 'PH1', 'Thay ảnh bị từ chối nhưng vẫn đổi dự án.')
      if (result.ok && !checkExplicitRewrite(s.prompt, after.prompt)) problem(c, 'X3', 'Thay nhân vật làm mất chữ hoặc đổi số token ảnh.', { before: s.prompt, after: after.prompt })
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
    args: (r) => ({ s: r.raw() }),
    run: async (c, a) => {
      R().enqueue([runnable(c, Number(a.s))])
      await c.env.advance(c.env.kind === 'headless' ? 1_000 : 250)
      const nodes = c.server.siteNodes()
      const node = nodes && at(nodes.nodes, Number(a.s))
      if (!node) return
      const site = c.server.createSiteJob({ projectId: nodes!.projectId, nodeId: node.id })
      if (!site.ok) return // The site also refuses another running job on that node.
      c.hit('import.siteCreated')
      const scan = await advancing(c, scanForImport('dev'))
      if (!scan.scan.candidates.some((x) => x.jobId === site.jobId)) return // The unresolved POST ownership window may legitimately hide it.
      const imported = await advancing(c, importSiteJobs(scan, [site.jobId]))
      if (imported?.takeIds.length) c.hit('import.adopted')
      if (!imported?.takeIds.length) problem(c, 'IJ1', 'Job đủ điều kiện không được nhập.', { site, imported })
      await advancing(c, importSiteJobs(scan, [site.jobId])) // stale scan, intentionally repeated
      c.hit('import.staleScanRetried')
      const owners = R().takes.filter((t) => t.remoteId && decodeRemoteId(t.remoteId)?.jobId === site.jobId)
      if (owners.length !== 1) problem(c, 'IJ1', 'Job trên trang bị nhận nhiều lần.', { jobId: site.jobId, owners: owners.map((t) => t.id) })
      for (const id of imported?.takeIds ?? []) R().retry(id)
    },
  },
  {
    id: 'login.restart', label: 'Giữ đăng nhập / khởi động lại / đăng xuất giữa hàng đợi', group: 'run', layer: 'store',
    args: (r) => ({ s: r.raw(), keep: r.chance(0.5), logout: r.chance(0.5) }),
    run: async (c, a) => {
      c.server.login()
      c.server.setConfig({ loginCookie: 'session', encryption: 'ok', dedupe: false })
      await c.bridge.setKeepLogin(!!a.keep)
      R().enqueue([runnable(c, Number(a.s))])
      await c.env.advance(250)
      const restart = await c.bridge.simulateRestart()
      c.hit(restart.survived ? 'login.kept' : 'login.notKept')
      if (restart.survived !== !!a.keep) problem(c, 'RL1', 'Khởi động lại không theo lựa chọn giữ đăng nhập.')
      if (a.logout) {
        await c.bridge.logout()
        gatewayProvider('dev').reset()
      }
      if (!c.server.isAuthenticated()) {
        const balance = c.server.balance()
        await c.env.advance(c.env.kind === 'headless' ? 3_000 : 250)
        if (c.server.balance() < balance) problem(c, 'RL2', 'Vẫn trừ credit khi đã đăng xuất.')
      }
      c.server.login()
    },
  },
  {
    id: 'ui.transport', label: 'Phím player và màn hình đã ẩn', group: 'ui', layer: 'store',
    args: (r) => ({ view: r.pick(['table', 'storyboard']), code: r.pick(['KeyJ', 'KeyK', 'KeyL', 'Space', 'ArrowLeft', 'ArrowRight']) }),
    run: (c, a) => {
      useUI.getState().setView(a.view as 'table' | 'storyboard')
      if (useUI.getState().view !== 'canvas') problem(c, 'UI1', 'Màn hình đã ẩn vẫn mở được.')
      const event = { key: String(a.code), code: String(a.code) }
      if (playerKey(event, 'typing', { player: 'node-full', mac: false }) !== null) problem(c, 'UI2', 'Player chiếm phím khi đang nhập chữ.')
      const film = buildFilmItems(P().project.scenes, R().takes)
      const ordered = [...P().project.scenes].sort((x, y) => x.order - y.order)
      if (film.some((x, i) => x.sceneId !== ordered[i]?.id)) problem(c, 'UI3', 'Phát liền sai thứ tự cảnh.')
    },
  },
]

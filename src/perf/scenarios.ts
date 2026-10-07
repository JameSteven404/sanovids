import { flushSync } from 'react-dom'
import { undo, useProject } from '../store/project'
import { useRuns, stopEngine } from '../store/runs'
import { useSceneEditor } from '../store/sceneEditor'
import { flush, switchProject } from '../store/persist'
import { useUI } from '../store/ui'
import { LOD_ZOOM } from '../components/canvas/canvasModel'
import { cutEdge } from '../components/canvas/edges'
import { edgeId } from '../actions'
import { parsePlaceholders } from '../core/placeholders'
import { libraryFixture } from './synth'
import { flushAll } from '../lib/promptDrafts'
import { frame, pause, settle, type work } from './measure'
import { perfCanvas } from './probe'

export interface Scenario { id: string; label: string; run(sample: typeof work): Promise<void>; optional?: string }
const element = <T extends HTMLElement>(selector: string): T => {
  const result = document.querySelector<T>(selector)
  if (!result) throw new Error(`Chưa có phần tử đo: ${selector}`)
  return result
}
// The canvas is the only view (core/shownViews): the scenarios of the hidden Bảng cảnh / Storyboard (returnCanvas,
// tableScroll, storyboardOpen, storyboardReorder) were removed with them.
async function showCanvas() {
  flushSync(() => useUI.setState({ view: 'canvas' }))
  await settle('.react-flow')
}
async function pan(sample: typeof work, zoom: number, count = 30) {
  const api = perfCanvas()
  if (!api) throw new Error('P2 cần đăng ký registerPerfCanvas trước khi đo canvas.')
  await api.setViewport({ x: 30, y: 30, zoom })
  await frame()
  for (let i = 0; i < count; i++) await sample(() => { void api.setViewport({ x: 30 + i * 40, y: 30, zoom }) })
}
async function drag(sample: typeof work, count: number) {
  const scenes = useProject.getState().project.scenes.slice(0, count)
  flushSync(() => useUI.getState().select(scenes.map((s) => s.id)))
  const node = element<HTMLElement>(`.react-flow__node[data-id="${scenes[0].id}"]`)
  const rect = node.getBoundingClientRect()
  const x = rect.x + rect.width / 2, y = rect.y + 25
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window }))
  try {
    for (let i = 1; i <= 20; i++) await sample(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + i * 4, clientY: y + i * 2, buttons: 1, view: window }))
    })
  } finally {
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 80, clientY: y + 40, button: 0, view: window }))
  }
  if (useProject.getState().project.scenes[0].position === scenes[0].position) throw new Error('Kéo thử chưa di chuyển thẻ; không có số đo hợp lệ.')
}

const nodeSelector = () => `.react-flow__node[data-id="${useProject.getState().project.scenes[0].id}"]`
const nodeField = () => element<HTMLTextAreaElement>(`${nodeSelector()} .cv-sn-pr textarea`)
function check(passed: boolean, message: string): asserts passed { if (!passed) throw new Error(message) }
async function prepareNode() {
  const scene = useProject.getState().project.scenes[0]
  const api = perfCanvas()
  check(!!api, 'Thiếu registerPerfCanvas.')
  await api.setViewport({ x: 40 - scene.position.x, y: 40 - scene.position.y, zoom: 1 })
  flushSync(() => useUI.getState().select([scene.id]))
  await settle(nodeSelector())
}
/**
 * The click a user makes on the static prompt: on its first characters, so SceneNode's onClick takes the caret-where-
 * clicked path (staticTextBefore hit test + caretFromExcerptHit), not the caret-at-end one of a click below the text.
 * The point is found before the measured slice; the returned action only dispatches the click.
 */
function nodeClick(): () => void {
  const text = element(`${nodeSelector()} .cv-sn-pr .cv-sn-text`)
  const first = document.createTreeWalker(text, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }).nextNode()
  check(!!first && first.textContent!.length >= 4, 'Prompt tĩnh chưa có chữ để bấm.')
  const range = document.createRange()
  range.setStart(first, 0); range.setEnd(first, 4)
  const box = range.getBoundingClientRect()
  const x = box.left + box.width / 2, y = box.top + box.height / 2
  const target = document.elementFromPoint(x, y)
  check(!!target && text.contains(target), 'Chữ prompt tĩnh bị che; không bấm được như người dùng.')
  return () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 1, view: window })) }
}
/** The editor opened where the static text was clicked (not at the end). */
function checkCaretAtClick() {
  const caret = useSceneEditor.getState().caret
  check(caret !== null && caret < useProject.getState().project.scenes[0].prompt.length, 'Bấm vào chữ chưa đặt con trỏ tại chỗ bấm.')
}
function closeNode() {
  nodeField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}
function checkEditor(open: boolean) {
  check(document.querySelectorAll('.cv-sn-pr textarea').length === (open ? 1 : 0), 'Số khung sửa trên node không đúng.')
  check(useSceneEditor.getState().sceneId === (open ? useProject.getState().project.scenes[0].id : null), 'Trạng thái khung sửa không đúng.')
}
async function typeText(sample: typeof work, textarea: HTMLTextAreaElement) {
  textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  const before = textarea.value
  const text = ' Máy quay đi qua khu rừng xanh.'.repeat(5).slice(0, 120)
  for (const character of text) {
    await sample(() => { check(document.execCommand('insertText', false, character), 'Trình duyệt không chèn được chữ.') })
    await pause(30)
  }
  check(textarea.value === before + text, 'Prompt chưa nhận đủ chữ thử.')
  flushAll()
  check(useProject.getState().project.scenes[0].prompt === before + text, 'Nháp chưa được ghi vào cảnh.')
}
/** Type into the sidebar search the way React sees typing (its value is component state, not a pref). */
function setSearch(value: string) {
  const input = document.querySelector<HTMLInputElement>('.sb-search-input')
  if (!input || input.value === value) return
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const SIDEBAR_PREFS = ['bdp:pref:sb-collapsed', 'bdp:pref:sb-kind'] // Sidebar.tsx, AssetLibrary.tsx usePrefState
const kindLabel = (tab: Element | null) => tab?.querySelector('span')?.textContent ?? null
/**
 * Shows the 200 fixture cards: clears the sidebar search, opens the Thư viện section, picks the "Tất cả" tab. Returns
 * the card ids and the undo of those UI changes (search text, section, tab and both device prefs, as they were).
 */
async function prepareLibrary(): Promise<{ ids: string[]; restore: () => Promise<void> }> {
  const query = document.querySelector<HTMLInputElement>('.sb-search-input')?.value ?? ''
  const collapsed = !!document.querySelector('.sb-library .sb-sec-toggle[aria-expanded="false"]')
  const prefs = SIDEBAR_PREFS.map((key) => [key, localStorage.getItem(key)] as const)
  let kind: string | null = null
  const restore = async () => {
    flushSync(() => {
      const tab = [...document.querySelectorAll('.sb-library .sb-kind')].find((t) => kindLabel(t) === kind)
      if (tab && !tab.classList.contains('active')) (tab as HTMLElement).click()
    })
    flushSync(() => { if (collapsed) document.querySelector<HTMLElement>('.sb-library .sb-sec-toggle[aria-expanded="true"]')?.click() })
    flushSync(() => setSearch(query))
    await frame() // The prefs' write effects ran: put back the exact stored values (a tab no longer shown included).
    for (const [key, value] of prefs) if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value)
  }
  try {
    const project = libraryFixture(useProject.getState().project)
    flushSync(() => { useProject.setState({ project }); useUI.getState().setLibrarySelection([]) })
    flushSync(() => {
      setSearch('')
      if (collapsed) element('.sb-library .sb-sec-toggle').click()
    })
    kind = kindLabel(element('.sb-library .sb-kind.active'))
    flushSync(() => element('.sb-library .sb-kind').click()) // First tab: all kinds.
    await settle('.sb-library .sb-grid')
    const ids = project.assets.slice(-200).map((a) => a.id)
    for (const id of ids) element(`.sb-library [data-asset-id="${id}"]`)
    return { ids, restore }
  } catch (error) {
    await restore()
    throw error
  }
}
function selectLibrary(ids: string[]) {
  element(`.sb-library [data-asset-id="${ids[0]}"]`).click()
  element(`.sb-library [data-asset-id="${ids[199]}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
}
function checkLibrary(ids: string[]) {
  const selection = useUI.getState().librarySelection
  check(selection.length === 200 && ids.every((id) => selection.includes(id)), 'Chưa chọn đúng 200 mục thư viện.')
  check(document.querySelectorAll('.sb-library [aria-selected="true"][data-asset-id]').length === 200, 'Thư viện chưa hiển thị đủ 200 mục đã chọn.')
}

export function scenarios(projectId: string, alternateId: string): Scenario[] {
  const ids = () => useProject.getState().project.scenes.map((s) => s.id)
  return [
    { id: 'open', label: 'Mở dự án', run: async (sample) => {
      await switchProject(alternateId)
      await showCanvas()
      await sample(async () => { await switchProject(projectId); stopEngine(); await settle('.react-flow') })
    } },
    ...([1, 0.4, 0.15] as const).map((zoom) => ({ id: zoom === 0.15 ? 'panFar' : zoom === 0.4 ? 'pan04' : 'pan', label: `Kéo canvas · zoom ${zoom}`, run: (sample: typeof work) => pan(sample, zoom) })),
    { id: 'zoom', label: 'Thu phóng', run: async (sample) => {
      const api = perfCanvas()
      if (!api) throw new Error('Thiếu registerPerfCanvas.')
      for (let i = 0; i < 30; i++) await sample(() => { void api.setViewport({ x: 30, y: 30, zoom: 1 - i * 0.025 }) })
    } },
    { id: 'selectFirst', label: 'Chọn cảnh lần đầu', run: async (sample) => {
      flushSync(() => useUI.getState().clearSelection()); await frame()
      await sample(() => useUI.getState().select([ids()[0]]))
    } },
    { id: 'select', label: 'Chọn cảnh', run: async (sample) => {
      useUI.getState().select([ids()[0]]); await frame()
      for (const id of ids().slice(1, 21)) await sample(() => useUI.getState().select([id]))
    } },
    { id: 'drag', label: 'Kéo một thẻ', run: (sample) => drag(sample, 1) },
    { id: 'drag50', label: 'Kéo 50 thẻ', run: (sample) => drag(sample, 50) },
    { id: 'typeInspector', label: 'Gõ prompt ở bảng bên phải', run: async (sample) => {
      flushSync(() => useUI.getState().select([ids()[0]])); await frame()
      // From 0.6.0 the prompt is typed on the scene node: the panel's prompt field is the wide composer, opened on demand.
      flushSync(() => useSceneEditor.getState().openPanel(ids()[0])); await frame()
      const textarea = element<HTMLTextAreaElement>('.app-right textarea[aria-label="Prompt của cảnh"]')
      await typeText(sample, textarea)
    } },
    { id: 'promptCommit', label: 'Commit prompt', run: async (sample) => {
      for (let i = 0; i < 40; i++) await sample(() => { useProject.getState().setScenePrompt(ids()[0], `Nháp đo ${i}`) })
    } },
    { id: 'runsTick', label: 'Tiến độ 20 video đang tạo', run: async (sample) => {
      stopEngine()
      useRuns.setState((s) => ({ takes: s.takes.map((t, i) => i < 20 ? { ...t, status: 'processing', progress: 1 } : t) }))
      await flush(); await frame()
      for (let n = 2; n <= 41; n++) await sample(() => useRuns.setState((s) => ({ takes: s.takes.map((t, i) => i < 20 ? { ...t, progress: n } : t) })))
      await flush()
    } },
    { id: 'star', label: 'Bấm sao', run: async (sample) => {
      for (let i = 0; i < 20; i++) await sample(() => useRuns.getState().toggleStar(useRuns.getState().takes[0].id))
    } },
    { id: 'hover', label: 'Rê chuột qua thẻ', run: async (sample) => {
      for (const node of document.querySelectorAll<HTMLElement>('.react-flow__node').values()) {
        await sample(() => { node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
        if (node === document.querySelectorAll('.react-flow__node')[29]) break
      }
    } },
    { id: 'allWires', label: 'Kéo với tất cả dây', run: async (sample) => { flushSync(() => useUI.setState({ edgeMode: 'all' })); await pan(sample, 1) } },
    { id: 'minimapOn', label: 'Kéo với bản đồ thu nhỏ', run: async (sample) => {
      flushSync(() => useUI.setState({ showMinimap: true, minimapShownFor: [projectId] })); await pan(sample, 1)
    } },
    { id: 'autosave', label: 'Lưu tự động', run: async (sample) => {
      useProject.getState().setScenePrompt(ids()[0], 'Đo lưu tự động')
      useRuns.getState().toggleStar(useRuns.getState().takes[0].id)
      await sample(async () => { if (!await flush()) throw new Error('Không lưu được dữ liệu thử.') })
    } },
    { id: 'typeNode', label: 'Gõ trên thẻ', run: async (sample) => {
      await prepareNode(); flushSync(nodeClick()); await frame(); checkEditor(true); checkCaretAtClick()
      await typeText(sample, nodeField())
      checkEditor(true)
    } },
    { id: 'nodeCommit', label: 'Commit prompt trên thẻ', run: async (sample) => {
      await prepareNode(); flushSync(nodeClick()); await frame(); checkEditor(true)
      const textarea = nodeField()
      textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      for (const character of ' Ánh nắng chiếu qua tán lá, máy quay lia.'.repeat(2).slice(0, 40)) {
        check(document.execCommand('insertText', false, character), 'Trình duyệt không chèn được chữ.')
        const draft = textarea.value
        check(useProject.getState().project.scenes[0].prompt !== draft, 'Nháp đã vào cảnh trước bước đo commit.')
        // The editor commits 160 ms after a burst of keys (throttle); its registered draft flush is the same commit, now.
        await sample(flushAll)
        check(useProject.getState().project.scenes[0].prompt === draft, 'Commit chưa ghi nháp của thẻ vào cảnh.')
      }
      checkEditor(true)
    } },
    ...(['openEditor', 'closeEditor'] as const).map((id) => ({ id,
      label: id === 'openEditor' ? 'Mở khung sửa' : 'Đóng khung sửa', run: async (sample: typeof work) => {
        await prepareNode()
        for (let i = 0; i < 20; i++) {
          if (id === 'openEditor') {
            await sample(nodeClick()); checkEditor(true); checkCaretAtClick()
            flushSync(closeNode); await frame(); checkEditor(false)
          } else {
            flushSync(nodeClick()); await frame(); checkEditor(true)
            await sample(closeNode); checkEditor(false)
          }
        }
      } })),
    { id: 'expandSettings', label: 'Mở dòng cấu hình trên thẻ', run: async (sample) => {
      await prepareNode()
      for (let i = 0; i < 20; i++) {
        await sample(() => element(`${nodeSelector()} .cv-sn-sum`).click())
        element(`${nodeSelector()} .cv-sn-setx`)
        check(useSceneEditor.getState().settingsSceneId === ids()[0], 'Dòng cấu hình chưa mở.')
        flushSync(() => element(`${nodeSelector()} .cv-sn-setx-close`).click()); await frame()
        check(useSceneEditor.getState().settingsSceneId === null, 'Dòng cấu hình chưa đóng.')
      }
    } },
    ...(['panWithEditor', 'zoomWithEditor', 'lodSwitch'] as const).map((id) => ({ id,
      label: ({ panWithEditor: 'Kéo khi sửa', zoomWithEditor: 'Zoom khi sửa', lodSwitch: 'Qua ngưỡng 55% hai chiều' })[id],
      run: async (sample: typeof work) => {
        await prepareNode()
        if (id !== 'lodSwitch') { flushSync(nodeClick()); await frame(); checkEditor(true) }
        const api = perfCanvas()!, scene = useProject.getState().project.scenes[0]
        // Keep the edited card in view; zoomWithEditor stays near, lodSwitch covers both sides and exactly 55%.
        // panWithEditor: 40 px per step (the pan metric), back and forth, so the culled edge moves and the card stays.
        for (let i = 0; i < 30; i++) {
          const zoom = id === 'lodSwitch' ? [LOD_ZOOM - 0.01, LOD_ZOOM, LOD_ZOOM + 0.01][i % 3]
            : id === 'zoomWithEditor' ? 0.7 + (i % 10) * 0.03 : 1
          const target = { x: 40 - scene.position.x * zoom + (id === 'panWithEditor' && i % 2 === 0 ? 40 : 0), y: 40 - scene.position.y * zoom, zoom }
          await sample(() => { void api.setViewport(target) })
          const now = api.getViewport()
          check(Math.abs(now.x - target.x) < 0.5 && Math.abs(now.y - target.y) < 0.5 && Math.abs(now.zoom - zoom) < 1e-3, 'Viewport chưa đổi theo bước đo.')
          check(element(`${nodeSelector()} .cv-scene`).classList.contains('is-far') === (zoom < LOD_ZOOM), 'Node chưa đổi mức chi tiết tại 55%.')
          if (id !== 'lodSwitch') checkEditor(true)
        }
      } })),
    ...(['librarySelect200', 'libraryDelete200'] as const).map((id) => ({ id,
      label: id === 'librarySelect200' ? 'Chọn 200 mục thư viện' : 'Xoá 200 mục thư viện', run: async (sample: typeof work) => {
        const { ids: selected, restore } = await prepareLibrary()
        try {
          if (id === 'librarySelect200') {
            await sample(() => selectLibrary(selected)); checkLibrary(selected)
          } else {
            flushSync(() => selectLibrary(selected)); await frame(); checkLibrary(selected)
            const before = useProject.getState().project
            await sample(() => element('.sb-library .sb-libfoot-del').click())
            const after = useProject.getState().project
            check(after.assets.length === before.assets.length - 200 && after.assets.every((a) => !selected.includes(a.id)), 'Chưa xoá đúng 200 mục thư viện.')
            check(selected.every((assetId) => !document.querySelector(`.sb-library [data-asset-id="${assetId}"]`)), 'Card đã xoá vẫn còn trong thư viện.')
            check(useUI.getState().librarySelection.length === 0, 'Lựa chọn thư viện chưa được xoá.')
            check(before.scenes.every((scene, i) => after.scenes[i] === scene), 'Xoá ảnh chưa dùng làm thay đổi cảnh.')
          }
        } finally { await restore() }
      } })),
    ...(['cutWire', 'undoWire'] as const).map((id) => ({ id,
      label: id === 'cutWire' ? 'Cắt dây, giữ chữ đỏ' : 'Hoàn tác dây và chữ đỏ', run: async (sample: typeof work) => {
        await prepareNode()
        const before = useProject.getState().project.scenes[0]
        const wire = edgeId('ref', before.refs[0], before.id)
        const wirePath = `.react-flow__edge[data-id="${wire}"] .cv-wire`
        // Show both endpoints so the cut also measures the wire/placeholder render and cut animation.
        await perfCanvas()!.setViewport({ x: 30, y: 30, zoom: 0.7 })
        await settle('.react-flow')
        check(!!document.querySelector(wirePath), 'Chưa có dây hiển thị để cắt.')
        const label = useProject.getState().project.assets.find((a) => a.id === before.refs[0])!.name
        for (let i = 0; i < 20; i++) {
          if (id === 'cutWire') await sample(() => cutEdge(wire))
          else { flushSync(() => cutEdge(wire)); await frame() }
          const cut = useProject.getState().project.scenes[0]
          check(!cut.refs.includes(before.refs[0]) && parsePlaceholders(cut.prompt).some((p) => p.label === label), 'Cắt dây chưa tạo chữ đỏ có tên ảnh.')
          check(!document.querySelector(wirePath), 'Dây đã cắt vẫn còn trên canvas.')
          element(`${nodeSelector()} .in-tk.is-invalid`)
          if (id === 'undoWire') await sample(() => { undo() })
          else { flushSync(() => { undo() }); await frame() }
          const restored = useProject.getState().project.scenes[0]
          check(restored.prompt === before.prompt && restored.refs.join() === before.refs.join(), 'Hoàn tác chưa phục hồi dây và prompt.')
          check(!!document.querySelector(wirePath), 'Hoàn tác chưa vẽ lại dây.')
          check(!document.querySelector(`${nodeSelector()} .in-tk.is-invalid`), 'Chữ đỏ vẫn còn sau hoàn tác.')
        }
      } })),
  ]
}

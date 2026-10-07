import { flushSync } from 'react-dom'
import { useProject } from '../store/project'
import { useRuns, stopEngine } from '../store/runs'
import { flush, switchProject } from '../store/persist'
import { useUI } from '../store/ui'
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
      const textarea = element<HTMLTextAreaElement>('.app-right textarea[aria-label="Prompt của cảnh"]')
      textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      const before = textarea.value
      for (const character of ' Máy quay đi qua khu rừng xanh.'.repeat(5).slice(0, 120)) {
        await sample(() => { if (!document.execCommand('insertText', false, character)) throw new Error('Trình duyệt không chèn được chữ.') })
        await pause(30)
      }
      flushAll()
      if (textarea.value === before) throw new Error('Prompt chưa nhận chữ thử.')
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
    ...['typeNode', 'openEditor', 'closeEditor', 'panWithEditor', 'zoomWithEditor'].map((id) => ({ id,
      label: ({ typeNode: 'Gõ trên thẻ', openEditor: 'Mở khung sửa', closeEditor: 'Đóng khung sửa', panWithEditor: 'Kéo khi sửa', zoomWithEditor: 'Zoom khi sửa' } as Record<string, string>)[id],
      optional: 'Chờ giao diện E2 (ngoài Wave C Đợt 1).', run: async () => {} })),
  ]
}

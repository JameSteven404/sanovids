// Canvas preferences (this device): how wires react to a click, how much the canvas animates, the editor on a scene
// card and the big-project optimisations.
// - clickToCut ("Bấm vào dây để bỏ nối", default on): one click on a reference / save wire cuts it (toast with Undo).
//   Off: a click selects the wire (old behaviour) and Delete or the wire's × cuts it. Ctrl / Shift + click always selects.
// - animations ("Hoạt ảnh", default 'full'): 'full' = wire cut / draw-in / drag effects; 'reduced' = short fades only,
//   no movement; 'off' = no canvas animation at all. The OS "reduce motion" setting turns 'full' into 'reduced'.
// - nodeEditor ("Sửa prompt & cấu hình trên thẻ cảnh", default 'click'): the scene node is the editor —
//   'click' = a plain click on the node's prompt text types there (caret where clicked), its settings line opens in
//   place; 'select' = also ready to type (without focus) as soon as exactly one scene is selected; 'off' = the node is
//   read-only, edit in the right panel only. Enter on the selected node types in it in every mode but 'off'.
// - editorWidth (no Settings row: the editor's resize grip): width of that editor on screen, px, 340–640 (default 380).
// - bigProject ("Tối ưu khi dự án lớn", default 'auto'): from 800 cards the minimap hides itself for the session and
//   "Tất cả dây" draws only the wires near the view; 'off' = never. The minimap pref itself is never overwritten.
// - wheel ("Con lăn chuột", default 'pan'): 'pan' = the wheel moves the canvas (Shift: sideways), Ctrl / ⌘ + wheel
//   and a trackpad pinch zoom — like Magnific Spaces / ElevenLabs Flows; 'zoom' = the wheel zooms (0.5's behaviour).
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'

export type MotionLevel = 'full' | 'reduced' | 'off'
export type NodeEditorMode = 'click' | 'select' | 'off'
export type BigProjectMode = 'auto' | 'off'
export type WheelMode = 'pan' | 'zoom'

export interface CanvasPrefs {
  /** A click on a wire cuts it (default true). */
  clickToCut: boolean
  /** Canvas animation level (default 'full'). */
  animations: MotionLevel
  /** How the editor on a scene card opens (default 'click'). */
  nodeEditor: NodeEditorMode
  /** Width of the editor on a scene card, px on screen: an integer, EDITOR_WIDTH_MIN–EDITOR_WIDTH_MAX (default 380). */
  editorWidth: number
  /** Big-project optimisations of the canvas (default 'auto'). */
  bigProject: BigProjectMode
  /** What the mouse wheel does on the canvas (default 'pan'). */
  wheel: WheelMode
}

export const EDITOR_WIDTH_DEFAULT = 380
export const EDITOR_WIDTH_MIN = 340
export const EDITOR_WIDTH_MAX = 640

export const CANVAS_PREFS_KEY = 'bdp:pref:canvas'
export const DEFAULT_CANVAS_PREFS: CanvasPrefs = {
  clickToCut: true,
  animations: 'full',
  nodeEditor: 'click',
  editorWidth: EDITOR_WIDTH_DEFAULT,
  bigProject: 'auto',
  wheel: 'pan',
}
export const MOTION_LEVELS: readonly MotionLevel[] = ['full', 'reduced', 'off']
export const MOTION_LABEL: Record<MotionLevel, string> = { full: 'Đầy đủ', reduced: 'Giảm bớt', off: 'Tắt' }
export const NODE_EDITOR_MODES: readonly NodeEditorMode[] = ['click', 'select', 'off']
export const NODE_EDITOR_LABEL: Record<NodeEditorMode, string> = {
  click: 'Bấm vào prompt',
  select: 'Tự mở khi chọn 1 cảnh',
  off: 'Tắt (chỉ sửa ở bảng bên phải)',
}
export const BIG_PROJECT_MODES: readonly BigProjectMode[] = ['auto', 'off']
export const BIG_PROJECT_LABEL: Record<BigProjectMode, string> = { auto: 'Tự động', off: 'Tắt' }
export const WHEEL_MODES: readonly WheelMode[] = ['pan', 'zoom']
export const WHEEL_LABEL: Record<WheelMode, string> = { pan: 'Kéo canvas', zoom: 'Thu phóng' }

/** Texts of the Settings rows (SettingsDialog GROUPS 'canvas'), kept here so the settings search test reads the real ones. */
export const NODE_EDITOR_ROW = {
  label: 'Sửa prompt & cấu hình trên thẻ cảnh',
  hint: 'Node cảnh là chỗ sửa (giống canvasapp): bấm vào chữ prompt để gõ ngay, bấm dòng cấu hình để chọn model, thời lượng, độ phân giải, tỉ lệ rồi bấm Tạo video. Chỉ node đang gõ có ô gõ thật nên dự án nhiều cảnh vẫn nhanh. Esc để thôi gõ.',
  keywords: 'node thẻ cảnh sửa prompt nhập trực tiếp cấu hình inline canvasapp trình sửa thu gọn thôi gõ',
} as const
export const BIG_PROJECT_ROW = {
  label: 'Tối ưu khi dự án lớn',
  hint: 'Khi canvas có từ 800 thẻ (khoảng 300 cảnh): tạm ẩn bản đồ thu nhỏ và, ở chế độ “Tất cả dây”, chỉ vẽ dây gần vùng đang xem. Hiện lại bản đồ bằng nút trên thanh công cụ.',
  keywords: 'hiệu năng nhanh mượt lag giật chậm dự án lớn nhiều node nhiều cảnh tối ưu performance',
} as const

export const WHEEL_ROW = {
  label: 'Con lăn chuột',
  hint: 'Kéo canvas: lăn để di chuyển lên xuống (Shift + lăn: sang ngang), Ctrl + lăn hoặc chụm hai ngón trên touchpad để thu phóng — mượt hơn, giống Magnific và ElevenLabs. Thu phóng: lăn để phóng to / thu nhỏ như bản 0.5.',
  keywords: 'con lăn chuột wheel cuộn scroll di chuyển kéo thu phóng zoom mượt giật khựng touchpad',
} as const

const oneOf =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (list as readonly string[]).includes(v)
const isMotion = oneOf(MOTION_LEVELS)
export const isNodeEditorMode = oneOf(NODE_EDITOR_MODES)
export const isBigProjectMode = oneOf(BIG_PROJECT_MODES)
export const isWheelMode = oneOf(WHEEL_MODES)

/** An editor width as this build stores it (an integer in range): the only values a settings file may bring. */
export const isEditorWidth = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= EDITOR_WIDTH_MIN && (v as number) <= EDITOR_WIDTH_MAX

/** Any finite number → a valid editor width (rounded, clamped); anything else → null. For the resize grip and storage. */
export function clampEditorWidth(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(EDITOR_WIDTH_MAX, Math.max(EDITOR_WIDTH_MIN, Math.round(v)))
}

/** Stored JSON → prefs (unknown keys ignored, wrong types / garbage → defaults, a width out of range → clamped). */
export function parseCanvasPrefs(raw: string | null | undefined): CanvasPrefs {
  if (!raw) return { ...DEFAULT_CANVAS_PREFS }
  try {
    const saved = JSON.parse(raw) as Partial<Record<keyof CanvasPrefs, unknown>> | null
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_CANVAS_PREFS }
    return {
      clickToCut: typeof saved.clickToCut === 'boolean' ? saved.clickToCut : DEFAULT_CANVAS_PREFS.clickToCut,
      animations: isMotion(saved.animations) ? saved.animations : DEFAULT_CANVAS_PREFS.animations,
      nodeEditor: isNodeEditorMode(saved.nodeEditor) ? saved.nodeEditor : DEFAULT_CANVAS_PREFS.nodeEditor,
      editorWidth: clampEditorWidth(saved.editorWidth) ?? DEFAULT_CANVAS_PREFS.editorWidth,
      bigProject: isBigProjectMode(saved.bigProject) ? saved.bigProject : DEFAULT_CANVAS_PREFS.bigProject,
      wheel: isWheelMode(saved.wheel) ? saved.wheel : DEFAULT_CANVAS_PREFS.wheel,
    }
  } catch {
    return { ...DEFAULT_CANVAS_PREFS }
  }
}

function readPrefs(): CanvasPrefs {
  try {
    return parseCanvasPrefs(localStorage.getItem(CANVAS_PREFS_KEY))
  } catch {
    return { ...DEFAULT_CANVAS_PREFS }
  }
}

export const useCanvasPrefs = create<CanvasPrefs & { set: (patch: Partial<CanvasPrefs>) => void }>()((setState, getState) => ({
  ...readPrefs(),
  set: (patch) => {
    const next: Partial<CanvasPrefs> = {}
    if (typeof patch.clickToCut === 'boolean') next.clickToCut = patch.clickToCut
    if (isMotion(patch.animations)) next.animations = patch.animations
    if (isNodeEditorMode(patch.nodeEditor)) next.nodeEditor = patch.nodeEditor
    const width = clampEditorWidth(patch.editorWidth)
    if (width !== null) next.editorWidth = width
    if (isBigProjectMode(patch.bigProject)) next.bigProject = patch.bigProject
    if (isWheelMode(patch.wheel)) next.wheel = patch.wheel
    if (!Object.keys(next).length) return
    setState(next)
    const { clickToCut, animations, nodeEditor, editorWidth, bigProject, wheel } = getState()
    try {
      localStorage.setItem(CANVAS_PREFS_KEY, JSON.stringify({ clickToCut, animations, nodeEditor, editorWidth, bigProject, wheel }))
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
  },
}))

// ---------------- OS "reduce motion" ----------------
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'
const reduceMedia = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(REDUCE_QUERY) : null)

/** The OS asks for less motion right now. */
export function systemReducedMotion(): boolean {
  return reduceMedia()?.matches === true
}

/** The level actually used: 'full' becomes 'reduced' when the OS asks for less motion. */
export function motionLevel(pref: MotionLevel, reducedMotion: boolean = systemReducedMotion()): MotionLevel {
  return pref === 'full' && reducedMotion ? 'reduced' : pref
}

function subscribeReduced(onChange: () => void) {
  const m = reduceMedia()
  m?.addEventListener?.('change', onChange)
  return () => m?.removeEventListener?.('change', onChange)
}

/** Effective canvas motion level (pref + OS setting), re-rendering when either changes. */
export function useMotionLevel(): MotionLevel {
  const pref = useCanvasPrefs((s) => s.animations)
  const reduced = useSyncExternalStore(subscribeReduced, systemReducedMotion, () => false)
  return motionLevel(pref, reduced)
}

/**
 * Call once at startup: mirrors the effective level on <html data-motion="full|reduced|off"> and keeps it in sync
 * with the pref (Settings → "Hiệu ứng chuyển động") and the OS setting. styles/app.css uses it app-wide: 'reduced'
 * keeps fades but nothing glides or scales, 'off' drops every transition and animation. Returns a cleanup.
 */
export function initMotion(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const apply = () => {
    document.documentElement.dataset.motion = motionLevel(useCanvasPrefs.getState().animations)
  }
  apply()
  const offPref = useCanvasPrefs.subscribe((s, prev) => {
    if (s.animations !== prev.animations) apply()
  })
  const offOs = subscribeReduced(apply)
  return () => {
    offPref()
    offOs()
  }
}

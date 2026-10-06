// Pure decisions for the single editor layer. Sizes are CSS pixels unless marked as flow coordinates.
import type { NodeEditorMode } from '../../lib/canvasPrefs'
import { formatCredits, type CreditKind } from '../../lib/credits'
import type { Box } from '../../store/project'
import type { ViewMode } from '../../core/types'
import type { InlineKey, StageSize, Viewport } from './canvasModel'

export type EditorFocus = 'prompt' | 'title' | 'preset' | 'model' | 'mode' | 'duration' | 'resolution' | 'ratio'

/** Screen scale E and the compensating CSS scale k inside ViewportPortal. */
export function editorScale(zoom: number): { E: number; k: number } {
  const E = Math.min(1.25, Math.max(1, zoom))
  return { E, k: E / zoom }
}

/** Local CSS width: the preference, or enough to cover the card (whose width is in flow coordinates). */
export function editorWidth(preferred: number, cardWidth: number, zoom: number): number {
  return Math.max(preferred, cardWidth * zoom / editorScale(zoom).E)
}

/** Pan only. box.x/y are flow coordinates; box.w/h are the editor's unscaled CSS dimensions. */
export function editorPanViewport(box: Box, vp: Viewport, stage: StageSize): Viewport | null {
  const { E } = editorScale(vp.zoom)
  const left = 32
  const right = Math.max(left + 1, stage.w - 32)
  const top = Math.min(64, Math.max(0, (stage.h - stage.bottom) / 3))
  const bottom = Math.max(top + 1, stage.h - stage.bottom - 24)
  const sx = box.x * vp.zoom + vp.x
  const sy = box.y * vp.zoom + vp.y
  // Oversized editors keep their header / left edge reachable; the panel handles its own scrolling.
  const dx = sx < left || box.w * E > right - left ? left - sx : Math.min(0, right - sx - box.w * E)
  const dy = sy < top || box.h * E > bottom - top ? top - sy : Math.min(0, bottom - sy - box.h * E)
  return dx || dy ? { x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom } : null
}

interface EditorKey extends InlineKey {
  isComposing?: boolean
  keyCode?: number
  defaultPrevented?: boolean
}

/** The injected keymap owns user bindings; local Escape, IME and lone modifiers never reach React Flow. */
export function nodeEditorKeyBubbles<E extends EditorKey>(e: E, isTypingChord: (e: E) => boolean): boolean {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 ||
    /^(Escape|Process|Dead|Unidentified|Control|Meta|Alt|AltGraph|Shift|OS|Super|Hyper|CapsLock|Fn|FnLock)$/.test(e.key)) return false
  return isTypingChord(e)
}

export interface EditorContext {
  sceneId: string | null
  projectId: string | null
  currentProjectId: string
  sceneExists: boolean
  selectedIds: readonly string[]
  view: ViewMode
  nodeEditor: NodeEditorMode
}

/** Focus, dialogs and viewport visibility deliberately do not participate in the close decision. */
export function editorShouldStayOpen(s: EditorContext): boolean {
  return s.sceneId !== null && s.projectId === s.currentProjectId && s.sceneExists &&
    s.view === 'canvas' && s.nodeEditor !== 'off' && s.selectedIds.length === 1 && s.selectedIds[0] === s.sceneId
}

type EditorTarget = { closest(selector: string): { getAttribute(name: string): string | null } | null } | null
type ClickModifiers = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }

/** null = ignore; { focus: null } = select-mode opening without stealing focus. Call after selection settles. */
export function editorClickIntent(target: EditorTarget, pref: NodeEditorMode, modifiers: ClickModifiers): { focus: EditorFocus | null } | null {
  if (pref === 'off' || modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey || modifiers.altKey) return null
  if (target?.closest('input, textarea, select, [contenteditable="true"], .react-flow__resize-control')) return null
  if (pref === 'select') return { focus: null }
  const field = target?.closest('[data-edit]')?.getAttribute('data-edit')
  if (field && /^(prompt|title|preset|model|mode|duration|resolution|ratio)$/.test(field)) return { focus: field as EditorFocus }
  if (target?.closest('.cv-prompt-box')) return { focus: 'prompt' }
  return null
}

/** Native activation on an already focused control takes priority over opening the editor with Enter. */
export function enterOpensEditor(target: EditorTarget): boolean {
  return !target?.closest('input, textarea, select, [contenteditable="true"], button, a[href], summary, [role="button"], [role="option"], [role="tab"], [role="radio"], [role="checkbox"], [role="menuitem"]')
}

/** A DOM Range's text from the excerpt start to the hit maps directly to the prompt's UTF-16 offset. */
export function caretFromExcerptHit(prompt: string, textBeforeHit: string | null): number | null {
  if (textBeforeHit === null || !prompt.startsWith(textBeforeHit)) return null
  return textBeforeHit.length
}

export function runButtonLabel(duration: number, cost: number | null, kind: CreditKind): string {
  return `Tạo video · ${duration} giây · ${formatCredits(cost, kind)}`
}

export function counterLabel(prompt: string, limit: number): string {
  const count = [...prompt].length
  return `${count.toLocaleString('vi-VN')} / ${limit.toLocaleString('vi-VN')} ký tự${count > limit ? ' · vượt giới hạn' : ''}`
}

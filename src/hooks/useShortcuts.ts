// Global keyboard shortcuts. Mounted once in App (Shell).
import { useEffect } from 'react'
import {
  canvasEvents,
  FIT_EVENT,
  connectSelection,
  deleteSelection,
  duplicateSelection,
  nextScene,
  redo,
  requestRun,
  selectedSceneIds,
  undo,
} from '../actions'
import { useProject } from '../store/project'
import { flush } from '../store/persist'
import { toast, useUI } from '../store/ui'

/** Mac keyboards have no forward-delete key: there ⌫ (Backspace) is the delete key. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
/** macOS ⌫: wait this long before deleting; any key arriving meanwhile means it was typed by an input tool. */
export const BACKSPACE_GRACE_MS = 90

/**
 * What a key does to the selection: 'now' = delete it, 'deferred' = delete it unless another key follows within
 * BACKSPACE_GRACE_MS, null = nothing. Only Delete deletes on Windows / Linux. Vietnamese typing tools (Unikey, EVKey,
 * OpenKey…) rewrite letters by sending a real Backspace + the accented letter even when no text field has focus:
 * pressing E twice (wire mode) turned into "ê" and its Backspace deleted the selected scene and videos. They do not use
 * IME composition, so `isComposing` cannot tell. On macOS ⌫ stays, guarded by the grace period (the tool's letter
 * arrives right after its Backspace).
 */
export function deleteKeyAction(key: string, mac: boolean): 'now' | 'deferred' | null {
  if (key === 'Delete') return 'now'
  if (key === 'Backspace' && mac) return 'deferred'
  return null
}

/**
 * Selection rule of the Delete key (takes selected together with their own scene are spared). It lives in
 * core/deletePlan and actions.deleteSelection applies it itself; re-exported here for older imports and tests.
 */
export { keyboardDeletePlan } from '../core/deletePlan'

/**
 * Delete key → actions.deleteSelection, which spares videos selected together with their own scene (they are only
 * hidden with it, Undo brings them back), asks before deleting finished videos for good and leaves the selection
 * untouched when the question is cancelled.
 */
function deleteFromKeyboard() {
  deleteSelection()
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(type)
  }
  return el.isContentEditable
}

export function useShortcuts(): void {
  useEffect(() => {
    let pendingDelete: ReturnType<typeof setTimeout> | null = null
    const cancelPendingDelete = () => {
      if (pendingDelete) clearTimeout(pendingDelete)
      pendingDelete = null
    }
    const onKey = (e: KeyboardEvent) => {
      // Any key right after a macOS ⌫ means an input tool is rewriting a letter: that ⌫ was not meant to delete.
      cancelPendingDelete()
      if (e.defaultPrevented || e.isComposing) return
      const ui = useUI.getState()
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const typing = isTyping(e.target)
      const dialogOpen = ui.dialog.kind !== 'none'

      // ---- always available (even while typing) ----
      if (mod && key === 's') {
        e.preventDefault()
        void flush().then((ok) => ok && toast('Đã lưu', { tone: 'success' }))
        return
      }
      if (mod && key === 'Enter') {
        if (dialogOpen) return
        e.preventDefault()
        requestRun(selectedSceneIds())
        return
      }
      if (key === 'Escape') {
        if (dialogOpen) {
          ui.closeDialog()
          return
        }
        if (typing) {
          ;(e.target as HTMLElement).blur()
          return
        }
        ui.clearSelection()
        ui.setLibrarySelection([])
        return
      }
      if (typing || dialogOpen) return

      // ---- with Ctrl / Cmd ----
      if (mod) {
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault()
          undo()
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault()
          redo()
        } else if (key === 'd') {
          e.preventDefault()
          duplicateSelection()
        } else if (key === 'a') {
          if (ui.view !== 'canvas') return
          e.preventDefault()
          ui.select(useProject.getState().project.scenes.map((s) => s.id))
        } else if (key === 'k') {
          e.preventDefault()
          if (!ui.leftOpen) ui.setLeftOpen(true)
          requestAnimationFrame(() => window.dispatchEvent(new Event('bdp:search')))
        }
        return
      }
      if (e.altKey) return

      // ---- single keys ----
      const del = deleteKeyAction(key, IS_MAC)
      if (del) {
        e.preventDefault()
        if (e.repeat) return
        if (del === 'now') deleteFromKeyboard()
        else
          pendingDelete = setTimeout(() => {
            pendingDelete = null
            deleteFromKeyboard()
          }, BACKSPACE_GRACE_MS)
        return
      }
      switch (key) {
        case '?':
          e.preventDefault()
          ui.openDialog({ kind: 'shortcuts' })
          return
      }
      if (e.repeat) return
      switch (key) {
        case 'n':
          e.preventDefault()
          nextScene()
          break
        case 'c':
          e.preventDefault()
          connectSelection()
          break
        case 'f':
          e.preventDefault()
          if (ui.view !== 'canvas') ui.setView('canvas')
          {
            const ids = ui.selectedIds
            setTimeout(() => canvasEvents.dispatchEvent(new CustomEvent(FIT_EVENT, { detail: ids })), ui.view === 'canvas' ? 0 : 120)
          }
          break
        case 'e':
          ui.cycleEdgeMode()
          break
        case 'h':
          ui.setInteraction('hand')
          break
        case 'v':
          ui.setInteraction('select')
          break
        case 'm':
          ui.toggleMinimap()
          break
        case '1':
          ui.setView('canvas')
          break
        case '2':
          ui.setView('table')
          break
        case '3':
          ui.setView('storyboard')
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelPendingDelete()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

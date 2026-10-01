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
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const ui = useUI.getState()
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const typing = isTyping(e.target)
      const dialogOpen = ui.dialog.kind !== 'none'

      // ---- always available (even while typing) ----
      if (mod && key === 's') {
        e.preventDefault()
        flush()
        toast('Đã lưu', { tone: 'success' })
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
      switch (key) {
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          deleteSelection()
          return
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
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

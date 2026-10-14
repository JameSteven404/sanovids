// Global keyboard shortcuts. Mounted once in App.
import { useEffect } from 'react'
import { decideShortcut } from '../core/keymap'
import { eventLike, isImeKey, isTypingTarget, IS_MAC } from '../lib/keyEvents'
import { matchesAction, shortcutLabel, useKeymap } from '../lib/keymapPrefs'
import { escapeForFullscreen, trackFullscreen } from '../lib/fullscreenGuard'
import { KEY_COMMANDS, openSelectedTake } from '../keyCommands'
import { cancelLibraryKey, handleLibraryKey, noteCanvasCommand, showBackspaceHint } from '../libraryActions'
import { moveSelectedScene, sceneOrderKey } from '../sceneOrderActions'
import { usePlayback } from '../lib/playback'
import { toast, useUI } from '../store/ui'
import { promptFocusPending, useSceneEditor } from '../store/sceneEditor'

/** Vietnamese input tools send Backspace before a rewritten letter; never delete for that pair. */
export const BACKSPACE_GRACE_MS = 90
export function deleteKeyAction(key: string, mac: boolean): 'now' | 'deferred' | null {
  return key === 'Delete' ? 'now' : key === 'Backspace' && mac ? 'deferred' : null
}
export { keyboardDeletePlan } from '../core/deletePlan'

/** Once per device (plan Premiere §3.7): the notice that the default keys changed. */
export const PREMIERE_NOTICE_KEY = 'bdp:notice:premiere-keys'
/**
 * Read when this module loads, before App's bootstrap opens or creates a project: a profile that never opened one
 * (store/persist `bdp:active`) is a new install, whose user never knew the 0.5 keys.
 */
const FRESH_PROFILE = (() => {
  try {
    return localStorage.getItem('bdp:active') === null
  } catch {
    return false
  }
})()

/** The one-time "keys now follow Premiere" toast, with the live labels; never on a new install. */
export function premiereKeysNotice(fresh = FRESH_PROFILE): void {
  try {
    if (localStorage.getItem(PREMIERE_NOTICE_KEY)) return
    localStorage.setItem(PREMIERE_NOTICE_KEY, '1')
  } catch {
    return // storage unavailable: never repeat the notice on every start
  }
  if (fresh) return
  const keys = ([['selection.connect', 'nối'], ['take.star', '★'], ['take.download', 'tải'], ['canvas.fit', 'vừa màn hình']] as const)
    .flatMap(([id, what]) => { const label = shortcutLabel(id); return label ? [`${label} ${what}`] : [] })
  toast(`Phím tắt nay giống Premiere Pro${keys.length ? ` (${keys.join(', ')}…)` : ''}. Phím cũ vẫn dùng được.`, {
    ms: 9000, action: { label: 'Xem', run: () => useUI.getState().openDialog({ kind: 'shortcuts' }) },
  })
}

export function useShortcuts(): void {
  useEffect(() => {
    const stopFullscreen = trackFullscreen()
    premiereKeysNotice()
    let pendingDelete: ReturnType<typeof setTimeout> | null = null
    const cancelPendingDelete = () => {
      if (pendingDelete) clearTimeout(pendingDelete)
      pendingDelete = null
    }
    const dispatch = (e: KeyboardEvent, typing: boolean) => {
      const ui = useUI.getState()
      const decision = decideShortcut(eventLike(e), { typing, dialog: ui.dialog.kind, view: ui.view }, IS_MAC, useKeymap.getState().resolved)
      if (!decision.handled) return
      e.preventDefault()
      if (decision.action === 'escape') {
        if (ui.dialog.kind !== 'none') ui.closeDialog()
        else if (typing) (e.target as HTMLElement)?.blur()
        else if (useSceneEditor.getState().sceneId) useSceneEditor.getState().close()
        else KEY_COMMANDS['selection.deselectAll']()
      } else if (decision.action === 'mac-backspace') {
        pendingDelete = setTimeout(() => { pendingDelete = null; KEY_COMMANDS['selection.delete']() }, BACKSPACE_GRACE_MS)
      } else if (decision.action && decision.action !== 'settings.search') KEY_COMMANDS[decision.action](e)
    }
    const onKey = (e: KeyboardEvent) => {
      cancelPendingDelete()
      cancelLibraryKey()
      if (e.defaultPrevented || isImeKey(e)) return
      if (usePlayback.getState().fullscreenId || escapeForFullscreen(e)) return
      const ui = useUI.getState()
      const typing = isTypingTarget(e.target)
      const dialogOpen = ui.dialog.kind !== 'none'
      // Save/run remain available in text fields; local editors consume their Enter/Escape first.
      if (typing || dialogOpen) { dispatch(e, typing); return }
      // A node's prompt field asked for but not focused yet (a far node zooming in to type in it, a new scene made by
      // double-click): plain letters, ⌫ and Delete were meant for that field — never a canvas key or a delete.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') && promptFocusPending()) return
      if (handleLibraryKey(e, IS_MAC, {
        isDeleteChord: matchesAction(e, 'selection.delete'),
        isSelectAllChord: matchesAction(e, 'selection.selectAll'),
      })) return
      const step = sceneOrderKey(e)
      if (step) { e.preventDefault(); noteCanvasCommand(); moveSelectedScene(step); return }
      if (openSelectedTake(e)) return
      if (!IS_MAC && e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !e.repeat) {
        e.preventDefault()
        pendingDelete = setTimeout(() => { pendingDelete = null; showBackspaceHint() }, BACKSPACE_GRACE_MS)
        return
      }
      dispatch(e, false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelPendingDelete()
      stopFullscreen()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

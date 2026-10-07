// Keys of the library ("Thư viện") while it is where the user works (libraryActions.isLibraryKeyTarget). Pure: no
// stores, no DOM. hooks/useShortcuts asks libraryActions.handleLibraryKey first and only falls back to the canvas
// rules when the key is not the library's.
//
//   delete-now       Delete (Windows / Mac fn+⌫), ⌘⌫ on Mac: delete the selected library items at once.
//   delete-deferred  plain ⌫ on Mac: delete after LIBRARY_KEY_GRACE_MS unless another key follows (an input tool
//                    rewriting a letter sends ⌫ + the accented letter).
//   backspace-hint   plain Backspace on Windows: never deletes (Unikey / EVKey / OpenKey send a real Backspace to
//                    rewrite letters, even outside text fields); after the grace period a hint names the Delete key.
//   select-all       Ctrl+A (⌘A on Mac): select every visible library card.
//   ignore           a held delete key (key repeat): handled — it must not reach the canvas — but does nothing.
//   null             not a library key: the global shortcuts handle it as before.
//
// The custom keymap (core/keymap, K2) can pass its own verdicts through `isDeleteChord` / `isSelectAllChord`: a
// rebound "Xoá lựa chọn" / "Chọn tất cả" then works in the library too. Backspace is never bindable there (refusalFor),
// so its rules stay fixed.

/** Same grace period as the canvas ⌫ (hooks/useShortcuts BACKSPACE_GRACE_MS; a test compares the two). */
export const LIBRARY_KEY_GRACE_MS = 90

export type LibraryKeyAction = 'delete-now' | 'delete-deferred' | 'backspace-hint' | 'select-all' | 'ignore'

export interface LibraryKeyInput {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  /** Mac keyboard rules (⌘ for Ctrl, ⌫ deletes). */
  mac: boolean
  /** The keymap's verdict for "selection.delete" (K2); omitted = the default chord (Delete). */
  isDeleteChord?: boolean
  /** The keymap's verdict for "selection.selectAll" (K2); omitted = the default chord (Ctrl+A / ⌘A). */
  isSelectAllChord?: boolean
}

/** Default "selection.delete": Delete without Ctrl / ⌘ / Alt (Shift+Delete deletes, as on the canvas). */
function defaultDeleteChord(e: LibraryKeyInput): boolean {
  return e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** Default "selection.selectAll": Ctrl+A on Windows, ⌘A on Mac (⌃A on a Mac is not select-all). */
function defaultSelectAllChord(e: LibraryKeyInput): boolean {
  const mod = e.mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey
  return mod && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'a' || e.code === 'KeyA')
}

/** What a key does in the library (see the table above). */
export function libraryKeyAction(e: LibraryKeyInput): LibraryKeyAction | null {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return null
  const backspace = e.key === 'Backspace'
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
  // Mac ⌘⌫ (Finder's delete) deletes at once; ⌃ / ⌥ + ⌫ are text-editing chords, not ours.
  const macCommandBackspace = e.mac && backspace && !!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  const deleteChord = !backspace && (e.isDeleteChord ?? defaultDeleteChord(e))
  if (deleteChord || macCommandBackspace) return e.repeat ? 'ignore' : 'delete-now'
  if (backspace && plain) {
    if (e.repeat) return 'ignore'
    return e.mac ? 'delete-deferred' : 'backspace-hint'
  }
  if (e.isSelectAllChord ?? defaultSelectAllChord(e)) return 'select-all'
  return null
}

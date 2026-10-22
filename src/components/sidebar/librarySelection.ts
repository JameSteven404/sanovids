// Selection of library cards by mouse (pure, tested in __tests__/librarySelection.test.ts). The library keeps its own
// selection (ui.librarySelection), independent of the canvas one.
//
//   plain click         select only this card — also when it already is the only one selected (click it, press Delete:
//                       it is deleted, never deselected first); deselect with Ctrl / ⌘ + click, Esc, a click on the
//                       empty library area or the footer's ×
//   Ctrl / ⌘ + click    add / remove this card (the other selected cards stay)
//   Shift + click       add every visible card from the anchor (the last card clicked) to this one, in list order
//   Ctrl+A / ⌘A         every visible card (libraryActions.selectAllInLibrary)

export interface ClickMods {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export interface ClickResult {
  selection: string[]
  /** The card a later Shift + click ranges from. */
  anchor: string | null
}

/** The selection after a click on card `id`. `visibleIds` = the cards on screen, in list order. */
export function libraryClick(current: readonly string[], visibleIds: readonly string[], anchor: string | null, id: string, mods: ClickMods): ClickResult {
  if (mods.shiftKey && anchor && anchor !== id) {
    const from = visibleIds.indexOf(anchor)
    const to = visibleIds.indexOf(id)
    if (from >= 0 && to >= 0) {
      const range = visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1)
      // The anchor stays: the next Shift + click ranges from the same card.
      return { selection: [...new Set([...current, ...range])], anchor }
    }
  }
  if (mods.ctrlKey || mods.metaKey || mods.shiftKey) {
    return { selection: current.includes(id) ? current.filter((x) => x !== id) : [...current, id], anchor: id }
  }
  return { selection: [id], anchor: id }
}

/** Ctrl+A / ⌘A: every visible card, in list order. */
export function selectAllVisible(visibleIds: readonly string[]): string[] {
  return [...new Set(visibleIds)]
}

// Which panel the inspector shows for the current selection (pure — unit-tested).
//
// Two selections live side by side: the canvas selection (scenes, canvas assets, take nodes) and the library
// selection (asset cards). Clicking on the canvas does not clear the library selection on purpose (select library
// cards + scenes, then "C" connects them), so the panel follows whichever selection the user changed LAST:
// a take clicked after a library card shows the take, a library card clicked after a take shows the card.

export type SelectionSource = 'canvas' | 'library'

export type InspectorView =
  | { kind: 'scene'; id: string }
  | { kind: 'scenes'; ids: string[] }
  | { kind: 'asset'; id: string }
  | { kind: 'assets'; ids: string[] }
  | { kind: 'takes'; ids: string[] }
  | { kind: 'empty' }

const NONE: string[] = []

/** `ids` that still exist in `items`, in selection order (a stable empty list when nothing is selected). */
export function existingIds(items: readonly { id: string }[], ids: string[]): string[] {
  if (!ids.length) return NONE
  const set = new Set(items.map((x) => x.id))
  return ids.filter((id) => set.has(id))
}

export interface SelectionParts {
  /** Selected scenes (canvas). */
  scenes: string[]
  /** Selected asset nodes (canvas). */
  canvasAssets: string[]
  /** Selected take (video) nodes (canvas). */
  takes: string[]
  /** Selected library cards. */
  libraryAssets: string[]
}

/**
 * Scenes always win (the library selection stays for the "C" connect flow). Otherwise the most recently changed
 * selection decides: library cards when the library was clicked last, else canvas assets → takes, and the library
 * cards again when nothing else is selected on the canvas.
 */
export function pickView(sel: SelectionParts, last: SelectionSource): InspectorView {
  if (sel.scenes.length === 1) return { kind: 'scene', id: sel.scenes[0] }
  if (sel.scenes.length > 1) return { kind: 'scenes', ids: sel.scenes }
  const assets =
    last === 'library' && sel.libraryAssets.length
      ? sel.libraryAssets
      : sel.canvasAssets.length
        ? sel.canvasAssets
        : sel.takes.length
          ? NONE
          : sel.libraryAssets
  if (assets.length === 1) return { kind: 'asset', id: assets[0] }
  if (assets.length > 1) return { kind: 'assets', ids: assets }
  if (sel.takes.length) return { kind: 'takes', ids: sel.takes }
  return { kind: 'empty' }
}

/** Source of a selection change (call with the new and previous ui state). */
export function changedSource(
  next: { selectedIds: string[]; librarySelection: string[] },
  prev: { selectedIds: string[]; librarySelection: string[] },
  current: SelectionSource,
): SelectionSource {
  if (next.librarySelection !== prev.librarySelection) return next.librarySelection.length ? 'library' : 'canvas'
  if (next.selectedIds !== prev.selectedIds) return 'canvas'
  return current
}

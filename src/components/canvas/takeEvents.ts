// "Đổi tên file" of a take from anywhere (a context menu, a command): the take node opens its rename input in its title
// line. Off-screen nodes are not rendered (onlyRenderVisibleElements), so a request nobody takes at once waits a moment
// while the canvas pans to the node, which takes it when it mounts; after RENAME_WAIT_MS the take viewer opens instead
// (its "Tên file" field renames too).
import { canvasEvents, revealNodes } from '../../actions'
import { useUI } from '../../store/ui'

/** canvasEvents event, detail RenameTakeDetail. The node that renders `takeId` near (not zoomed out) sets `handled`. */
export const RENAME_TAKE_EVENT = 'rename-take'
export interface RenameTakeDetail {
  takeId: string
  handled: boolean
}

/** How long a rename waits for its node (pan 60 + 300 ms, then the node mounts) before the viewer opens instead. */
export const RENAME_WAIT_MS = 1000

let pending: { takeId: string; at: number } | null = null
let fallback: ReturnType<typeof setTimeout> | null = null

/** Pure: is a pending rename `p` still `takeId`'s at `now`? */
export function livePendingRename(p: { takeId: string; at: number } | null, takeId: string, now: number): boolean {
  return !!p && p.takeId === takeId && now - p.at >= 0 && now - p.at <= RENAME_WAIT_MS
}

/** A take node that just mounted near: is a rename waiting for it? (Then it is taken.) */
export function takePendingRename(takeId: string, now = Date.now()): boolean {
  if (!livePendingRename(pending, takeId, now)) return false
  pending = null
  if (fallback) clearTimeout(fallback)
  fallback = null
  return true
}

/** Open the rename input of `takeId` (its node, else after a pan, else the take viewer). */
export function requestTakeRename(takeId: string): void {
  const detail: RenameTakeDetail = { takeId, handled: false }
  canvasEvents.dispatchEvent(new CustomEvent(RENAME_TAKE_EVENT, { detail }))
  if (detail.handled) return
  pending = { takeId, at: Date.now() }
  if (fallback) clearTimeout(fallback)
  revealNodes([takeId])
  fallback = setTimeout(() => {
    fallback = null
    if (!pending || pending.takeId !== takeId) return
    pending = null
    // A second chance once the pan ended (the node may have mounted zoomed out, then come near).
    const again: RenameTakeDetail = { takeId, handled: false }
    canvasEvents.dispatchEvent(new CustomEvent(RENAME_TAKE_EVENT, { detail: again }))
    if (!again.handled) useUI.getState().openDialog({ kind: 'take', takeId })
  }, RENAME_WAIT_MS)
}

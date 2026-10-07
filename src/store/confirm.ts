// One question asked in the app's own dialog (components/common/ConfirmSheet: the shared Modal, drawn ABOVE every
// dialog), instead of the browser's window.confirm — which Electron shows as a native box that ignores the theme and
// the app's keys. One question at a time: a new one cancels the one still open. Not undoable, not persisted.
import { create } from 'zustand'

export interface ConfirmRequest {
  id: number
  title: string
  /** The question; line breaks are kept. */
  text: string
  /** The button that does it ("Xoá"). */
  confirmLabel: string
  cancelLabel?: string
  /** The action deletes or loses something: the button is red. */
  danger?: boolean
  onConfirm: () => void
  onCancel?: () => void
}

interface ConfirmState {
  request: ConfirmRequest | null
}

export const useConfirm = create<ConfirmState>(() => ({ request: null }))

let seq = 0

/** Show the question. `onConfirm` runs when the user confirms, `onCancel` on cancel, Escape, a click outside or a newer question. */
export function askConfirm(req: Omit<ConfirmRequest, 'id'>): void {
  const prev = useConfirm.getState().request
  useConfirm.setState({ request: { ...req, id: ++seq } })
  prev?.onCancel?.()
}

/** The user answered the open question (no-op when none is open). */
export function answerConfirm(ok: boolean): void {
  const req = useConfirm.getState().request
  if (!req) return
  useConfirm.setState({ request: null })
  if (ok) req.onConfirm()
  else req.onCancel?.()
}

// Pure helpers about takes (video nodes) shared by the canvas and the layout of new nodes (store/takeRows).
import type { Take, XY } from './types'

/**
 * Does a take the user placed by hand (`at`) still sit on its row slot (`slot`), i.e. was it only nudged? Its box
 * (`w` × `h`) then overlaps the slot's box and it keeps the slot reserved; dragged further away, it leaves the row.
 */
export function keepsSlot(at: XY, slot: XY, w: number, h: number): boolean {
  return Math.abs(at.x - slot.x) < w && Math.abs(at.y - slot.y) < h
}

/** Starred take, else the latest completed one, else the latest. `list` is sorted oldest first. */
export function chooseTake(list: Take[]): Take | undefined {
  let completed: Take | undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]
    if (t.starred) return t
    if (!completed && t.status === 'completed') completed = t
  }
  return completed ?? list[list.length - 1]
}

// Pointer gesture constants shared by drag interactions. Moved out of the hidden Storyboard (components/views) so live
// code never imports from that frozen folder.

/** How far a press must travel before it becomes a drag (px). Touch drags start with a long press instead. */
export const DRAG_SLOP = { mouse: 5, pen: 6, touch: 10 } as const

// Side panel widths that fit the window. Pure — covered by ./__tests__/panelFit.test.ts.

export interface PanelLimits {
  min: number
}

/**
 * Widths for the left / right panels (null = panel hidden) so the center keeps at least `minCenter` px of
 * `total`. The wider panel gives way first (down to the other one's width), then both equally, never below their
 * minimum — if even the minimums do not fit, the center gets what is left. Widths that already fit are returned
 * as they are. The result is only applied, never saved: the preferred widths come back when the window grows.
 */
export function fitPanelWidths(
  total: number,
  left: number | null,
  right: number | null,
  limits: { left: PanelLimits; right: PanelLimits },
  minCenter: number,
): { left: number | null; right: number | null } {
  let l = left ?? 0
  let r = right ?? 0
  let over = l + r + minCenter - total
  if (over <= 0 || !Number.isFinite(total)) return { left, right }
  const minL = left === null ? 0 : Math.min(l, limits.left.min)
  const minR = right === null ? 0 : Math.min(r, limits.right.min)
  // 1. The wider panel shrinks toward the other one's width.
  if (l > r) {
    const d = Math.min(over, l - Math.max(r, minL))
    l -= d
    over -= d
  } else if (r > l) {
    const d = Math.min(over, r - Math.max(l, minR))
    r -= d
    over -= d
  }
  // 2. Then both by the same amount, each down to its minimum.
  if (over > 0) {
    const half = over / 2
    const dl = Math.min(half, l - minL)
    const dr = Math.min(over - dl, r - minR)
    const dl2 = Math.min(over - dl - dr, l - minL - dl)
    l -= dl + dl2
    r -= dr
  }
  return { left: left === null ? null : Math.round(l), right: right === null ? null : Math.round(r) }
}

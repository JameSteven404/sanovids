/** Fixed-height rows: six extra rows on either side, plus the focus and native drag source. */
export function windowedRows(count: number, rowHeight: number, scrollTop: number, height: number, pins: readonly number[] = []) {
  const top = Math.max(0, Math.min(scrollTop, count * rowHeight - height))
  const start = Math.max(0, Math.floor(top / rowHeight) - 6)
  const end = Math.min(count, Math.ceil((top + Math.max(0, height)) / rowHeight) + 6)
  const rows = new Set<number>()
  for (let i = start; i < end; i++) rows.add(i)
  for (const i of pins) if (i >= 0 && i < count) rows.add(i)
  return [...rows].sort((a, b) => a - b)
}

/** Null means this is not a list navigation key; -1 means the list is empty. */
export function listKeyIndex(key: string, index: number, count: number, pageRows: number): number | null {
  let next: number
  switch (key) {
    case 'ArrowUp': next = index - 1; break
    case 'ArrowDown': next = index + 1; break
    case 'Home': next = 0; break
    case 'End': next = count - 1; break
    case 'PageUp': next = index - Math.max(1, pageRows); break
    case 'PageDown': next = index + Math.max(1, pageRows); break
    default: return null
  }
  return count ? Math.max(0, Math.min(count - 1, next)) : -1
}

/** Smallest scroll that exposes the target row; never scroll beyond either end after filtering. */
export function rowScrollTop(index: number, count: number, rowHeight: number, scrollTop: number, height: number): number {
  const top = index * rowHeight
  const next = top < scrollTop ? top : top + rowHeight > scrollTop + height ? top + rowHeight - height : scrollTop
  return Math.max(0, Math.min(next, count * rowHeight - height))
}

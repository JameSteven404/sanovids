// Drag (HTML5) + keyboard (↑/↓ on the grip) reordering of a short list of rows.
import { useState, type DragEvent, type KeyboardEvent } from 'react'

export function useReorder(count: number, mime: string, onMove: (from: number, to: number) => void) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const finish = () => {
    setDragFrom(null)
    setDropAt(null)
  }
  const rowProps = (i: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(mime, String(i))
      e.dataTransfer.effectAllowed = 'move'
      setDragFrom(i)
    },
    onDragOver: (e: DragEvent) => {
      if (dragFrom === null || !e.dataTransfer.types.includes(mime)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const at = e.clientY < r.top + r.height / 2 ? i : i + 1
      if (at !== dropAt) setDropAt(at)
    },
    onDrop: (e: DragEvent) => {
      if (dragFrom === null || dropAt === null) return
      e.preventDefault()
      e.stopPropagation()
      const to = dropAt > dragFrom ? dropAt - 1 : dropAt
      if (to !== dragFrom) onMove(dragFrom, to)
      finish()
    },
    onDragEnd: finish,
  })
  const rowClass = (i: number) =>
    [
      dragFrom === i ? 'is-dragging' : '',
      dragFrom !== null && dropAt === i ? 'drop-before' : '',
      dragFrom !== null && dropAt === i + 1 && i === count - 1 ? 'drop-after' : '',
    ].join(' ')
  const gripKeyDown = (i: number) => (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault()
      onMove(i, i - 1)
    } else if (e.key === 'ArrowDown' && i < count - 1) {
      e.preventDefault()
      onMove(i, i + 1)
    }
  }
  return { rowProps, rowClass, gripKeyDown }
}

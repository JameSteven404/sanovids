// Custom HTML5 drag image for sidebar drags (library cards, finished videos).
import type { DragEvent } from 'react'

export interface GhostItem {
  /** Object URL of the thumbnail when already loaded (cachedUrl), else a letter is shown. */
  url: string | null
  letter: string
  color: string
  /** 'square' = library item (square avatars everywhere, characters included), 'wide' = 16:9 video poster. */
  shape: 'square' | 'wide'
}

/** Offscreen element used as the drag image: overlapping thumbnails + label (+ count when several). */
function buildGhost(items: GhostItem[], label: string, video: boolean): HTMLElement {
  const el = document.createElement('div')
  el.className = 'sb-drag-ghost' + (video ? ' video' : '')
  const stack = document.createElement('div')
  stack.className = 'sb-drag-ghost-stack'
  for (const it of items.slice(0, 4)) {
    const av = document.createElement('span')
    av.className = 'sb-drag-ghost-av ' + it.shape
    av.style.background = it.color
    if (it.url) {
      const img = document.createElement('img')
      img.src = it.url
      img.alt = ''
      av.appendChild(img)
    } else {
      av.textContent = it.letter
    }
    stack.appendChild(av)
  }
  el.appendChild(stack)
  const text = document.createElement('span')
  text.className = 'sb-drag-ghost-label'
  text.textContent = label
  el.appendChild(text)
  if (items.length > 1) {
    const count = document.createElement('span')
    count.className = 'sb-drag-ghost-count'
    count.textContent = String(items.length)
    el.appendChild(count)
  }
  document.body.appendChild(el)
  return el
}

/** Set the custom drag image (optional nicety: silently skipped when the browser refuses). */
export function setDragGhost(e: DragEvent<HTMLElement>, items: GhostItem[], label: string, video = false) {
  try {
    const ghost = buildGhost(items, label, video)
    e.dataTransfer.setDragImage(ghost, 22, 22)
    setTimeout(() => ghost.remove(), 0)
  } catch {
    /* custom drag image is optional */
  }
}

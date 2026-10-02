// Natural pixel size of stored images, measured once per image id and cached in memory.
// Used to show reference images in full at their real aspect ratio (no square crop).
import { useEffect } from 'react'
import { create } from 'zustand'
import { getUrl } from './imageStore'

export interface ImageSize {
  w: number
  h: number
}

interface MetaState {
  sizes: Record<string, ImageSize>
}

export const useImageMeta = create<MetaState>()(() => ({ sizes: {} }))

const inflight = new Map<string, Promise<ImageSize | null>>()

/** Measure (or return the cached) natural size of a stored image. */
export function measureImage(id: string): Promise<ImageSize | null> {
  const hit = useImageMeta.getState().sizes[id]
  if (hit) return Promise.resolve(hit)
  let p = inflight.get(id)
  if (!p) {
    p = getUrl(id).then(
      (url) =>
        new Promise<ImageSize | null>((resolve) => {
          if (!url) return resolve(null)
          const img = new Image()
          img.onload = () => {
            const size = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 }
            useImageMeta.setState((s) => ({ sizes: { ...s.sizes, [id]: size } }))
            inflight.delete(id)
            resolve(size)
          }
          img.onerror = () => {
            inflight.delete(id)
            resolve(null)
          }
          img.src = url
        }),
    )
    inflight.set(id, p)
  }
  return p
}

/** Natural size of an image (null until measured). */
export function useImageSize(id: string | null | undefined): ImageSize | null {
  const size = useImageMeta((s) => (id ? s.sizes[id] : undefined)) ?? null
  useEffect(() => {
    if (id && !size) void measureImage(id)
  }, [id, size])
  return size
}

/** width / height, clamped so extreme panoramas or strips stay usable in the UI. */
export function aspectOf(size: ImageSize | null | undefined, fallback = 1, min = 0.4, max = 2.6): number {
  if (!size || !size.w || !size.h) return fallback
  return Math.max(min, Math.min(max, size.w / size.h))
}

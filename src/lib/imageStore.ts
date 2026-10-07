// Images (asset photos, take posters, demo videos) are stored as Blobs in IndexedDB.
// The project JSON only keeps their keys.
import { createStore, del, get, set } from 'idb-keyval'
import { useEffect, useState } from 'react'
import { newId } from '../core/ids'

const store = createStore('ban-dung-phim', 'media')
interface MediaUrl { refs: number; url: string | null; pending?: Promise<string | null>; deleted?: boolean; deleting?: boolean }
const urlCache = new Map<string, MediaUrl>()

/** Number of live cached object URLs (performance harness). */
export const urlCount = () => [...urlCache.values()].filter((entry) => entry.url).length

export async function putBlob(blob: Blob, prefix = 'img'): Promise<string> {
  const id = newId(prefix)
  await set(id, blob, store)
  // Create URLs only for readers: importing a project must not pin every image in memory.
  return id
}

export async function getBlob(id: string): Promise<Blob | null> {
  return ((await get(id, store)) as Blob | undefined) ?? null
}

export function cachedUrl(id: string | null | undefined): string | null {
  return id ? urlCache.get(id)?.url ?? null : null
}

/** Acquire one reader, paired with releaseUrl even when loading fails or is cancelled. */
export function getUrl(id: string): Promise<string | null> {
  let entry = urlCache.get(id)
  if (!entry) urlCache.set(id, entry = { refs: 0, url: null })
  entry.refs++
  if (entry.deleted) return Promise.resolve(null)
  if (entry.url) return Promise.resolve(entry.url)
  const current = entry
  if (!current.pending) {
    current.pending = getBlob(id).then((blob) => {
      // A project switch / deletion may have released every reader while IndexedDB was loading.
      if (!blob || current.deleted || urlCache.get(id) !== current) return null
      return current.url = URL.createObjectURL(blob)
    }).finally(() => { current.pending = undefined })
  }
  return current.pending
}

/** The last reader owns revocation, including a reader still showing deleted media. */
export function releaseUrl(id: string): void {
  const entry = urlCache.get(id)
  if (!entry || --entry.refs > 0) return
  if (entry.url) URL.revokeObjectURL(entry.url)
  entry.url = null
  if (!entry.deleting) urlCache.delete(id)
}

export async function deleteMedia(id: string): Promise<void> {
  let entry = urlCache.get(id)
  if (!entry) urlCache.set(id, entry = { refs: 0, url: null })
  entry.deleted = entry.deleting = true
  try {
    await del(id, store)
  } catch (error) {
    entry.deleted = false
    throw error
  } finally {
    entry.deleting = false
    if (!entry.refs) urlCache.delete(id)
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream'
  const isBase64 = head.includes(';base64')
  const raw = isBase64 ? atob(body) : decodeURIComponent(body)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** React hook: object URL for a stored image key (null while loading / missing). */
export function useMediaUrl(id: string | null | undefined): string | null {
  const [media, setMedia] = useState<{ id: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!id) return
    let alive = true
    getUrl(id).then((url) => { if (alive) setMedia({ id, url }) }, () => { if (alive) setMedia({ id, url: null }) })
    return () => {
      alive = false
      releaseUrl(id)
    }
  }, [id])
  // Never render the old id's URL during the render before its effect cleans up.
  return media && media.id === id && media.url === cachedUrl(id) ? media.url : null
}

/** Generated placeholder portrait (SVG) used by the demo seed and by assets without photos. */
export function avatarSvg(label: string, color: string, kind: 'character' | 'location' | 'prop' | 'style' = 'character'): Blob {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
  const shape =
    kind === 'location'
      ? `<path d="M0 300 L90 170 L150 230 L230 120 L320 300 Z" fill="rgba(0,0,0,.28)"/><circle cx="240" cy="80" r="28" fill="rgba(255,255,255,.35)"/>`
      : kind === 'character'
        ? `<circle cx="160" cy="128" r="62" fill="rgba(0,0,0,.25)"/><path d="M40 320 C55 220 265 220 280 320 Z" fill="rgba(0,0,0,.25)"/>`
        : `<rect x="95" y="95" width="130" height="130" rx="18" fill="rgba(0,0,0,.25)"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#1b1d22"/></linearGradient></defs>
<rect width="320" height="320" fill="url(#g)"/>${shape}
<text x="160" y="296" font-family="Be Vietnam Pro, Arial, sans-serif" font-size="56" font-weight="700" text-anchor="middle" fill="rgba(255,255,255,.92)">${initials}</text>
</svg>`
  return new Blob([svg], { type: 'image/svg+xml' })
}

/**
 * The same avatar as a PNG: canvasapp — and development mode, which runs the same gateway code — only takes
 * JPG / PNG / WEBP, so the sample project's pictures must be raster images to be runnable there. Falls back to the
 * SVG where the page cannot draw it (tests, a browser that refuses), never throws.
 */
export async function avatarPng(label: string, color: string, kind: 'character' | 'location' | 'prop' | 'style' = 'character'): Promise<Blob> {
  const svg = avatarSvg(label, color, kind)
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return svg
  const url = URL.createObjectURL(svg)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000)
      img.onload = () => {
        clearTimeout(timer)
        resolve()
      }
      img.onerror = () => {
        clearTimeout(timer)
        reject(new Error('svg'))
      }
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 320
    const ctx = canvas.getContext('2d')
    if (!ctx) return svg
    ctx.drawImage(img, 0, 0, 320, 320)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return png && png.size > 0 ? png : svg
  } catch {
    return svg
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Images (asset photos, take posters, demo videos) are stored as Blobs in IndexedDB.
// The project JSON only keeps their keys.
import { createStore, del, get, set } from 'idb-keyval'
import { useEffect, useState } from 'react'
import { newId } from '../core/ids'

const store = createStore('ban-dung-phim', 'media')
/**
 * One object URL per media id, shared by its readers (getUrl … releaseUrl). A URL no reader holds stays IDLE — ready
 * for the next reader without a new IndexedDB read / decode (a canvas node panned out of view and back, the far / near
 * card swap, a viewer opening a poster) — until the project changes (revokeUnusedUrls), the media is deleted, or it
 * falls out of the most recent IDLE_MAX idle URLs.
 */
interface MediaUrl {
  refs: number
  url: string | null
  pending?: Promise<string | null>
  deleted?: boolean
  deleting?: boolean
  /** Project generation of the last getUrl: an idle URL of an older generation is revoked. */
  gen: number
}
const urlCache = new Map<string, MediaUrl>()
/** Ids with no reader, least recently released first. */
const idle = new Set<string>()
/** Idle URLs kept at most (the most recently released): a long pan over thousands of posters stays bounded. */
export const IDLE_MAX = 400
let generation = 0
let sweepTimer: ReturnType<typeof setTimeout> | null = null

/** Number of live cached object URLs (performance harness). */
export const urlCount = () => [...urlCache.values()].filter((entry) => entry.url).length

function dropEntry(id: string, entry: MediaUrl) {
  if (entry.url) URL.revokeObjectURL(entry.url)
  entry.url = null
  idle.delete(id)
  // A deletion still running keeps its entry (it refuses new readers); a read still running sees the entry gone.
  if (!entry.deleting && urlCache.get(id) === entry) urlCache.delete(id)
}

/**
 * Revokes idle URLs of an older project and the oldest beyond IDLE_MAX. Deferred (never inside a React commit):
 * when one card unmounts and another mounts in the same commit (far / near swap, a node remounted), the new reader's
 * getUrl runs before this and keeps the URL the card was rendered with.
 */
function scheduleSweep() {
  sweepTimer ??= setTimeout(() => {
    sweepTimer = null
    for (const id of [...idle]) {
      const entry = urlCache.get(id)
      if (!entry || entry.refs) idle.delete(id)
      else if (entry.gen !== generation) dropEntry(id, entry)
    }
    for (const id of idle) {
      if (idle.size <= IDLE_MAX) break
      const entry = urlCache.get(id)
      if (entry) dropEntry(id, entry)
      else idle.delete(id)
    }
  }, 0)
}

/**
 * The open project changed: every idle URL is revoked, and each URL still shown by the previous project's views is
 * revoked when its last reader leaves — unless a view of the new project (a shared asset image) took it first.
 */
export function revokeUnusedUrls(): void {
  generation++
  scheduleSweep()
}

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
  if (!entry) urlCache.set(id, entry = { refs: 0, url: null, gen: generation })
  entry.refs++
  entry.gen = generation
  idle.delete(id)
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

/**
 * Release one reader. The last reader of deleted media revokes its URL right away; otherwise the URL goes idle (kept
 * for this project, see MediaUrl) and the deferred sweep decides.
 */
export function releaseUrl(id: string): void {
  const entry = urlCache.get(id)
  if (!entry || entry.refs <= 0 || --entry.refs > 0) return
  if (entry.deleted) {
    dropEntry(id, entry)
    return
  }
  idle.delete(id)
  idle.add(id)
  if (entry.gen !== generation || idle.size > IDLE_MAX) scheduleSweep()
}

export async function deleteMedia(id: string): Promise<void> {
  let entry = urlCache.get(id)
  if (!entry) urlCache.set(id, entry = { refs: 0, url: null, gen: generation })
  entry.deleted = entry.deleting = true
  // Nobody shows an idle URL: revoke it now. A displayed one is revoked by its last reader (releaseUrl).
  if (!entry.refs) dropEntry(id, entry)
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
  // A re-render trigger only (the URL shown is always read from the cache below), seeded with the cached URL: a mount
  // whose URL is already live is not rendered a second time when its read resolves to that same URL.
  const [, setShown] = useState<string | null>(() => cachedUrl(id))
  useEffect(() => {
    if (!id) return
    let alive = true
    getUrl(id).then((url) => { if (alive) setShown(url) }, () => { if (alive) setShown(null) })
    return () => {
      alive = false
      releaseUrl(id)
    }
  }, [id])
  // The live URL of THIS id (held by another reader, or idle for this project) shows on the first render, before the
  // effect takes its reference: a remounted card never blinks. Never the previous id's URL, never a revoked one.
  return id ? cachedUrl(id) : null
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

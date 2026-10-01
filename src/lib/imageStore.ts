// Images (asset photos, take posters, demo videos) are stored as Blobs in IndexedDB.
// The project JSON only keeps their keys.
import { createStore, del, get, set } from 'idb-keyval'
import { useEffect, useState } from 'react'
import { newId } from '../core/ids'

const store = createStore('ban-dung-phim', 'media')
const urlCache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

export async function putBlob(blob: Blob, prefix = 'img'): Promise<string> {
  const id = newId(prefix)
  await set(id, blob, store)
  urlCache.set(id, URL.createObjectURL(blob))
  return id
}

export async function getBlob(id: string): Promise<Blob | null> {
  return ((await get(id, store)) as Blob | undefined) ?? null
}

export function cachedUrl(id: string | null | undefined): string | null {
  return id ? urlCache.get(id) ?? null : null
}

export function getUrl(id: string): Promise<string | null> {
  const hit = urlCache.get(id)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(id)
  if (!p) {
    p = getBlob(id).then((blob) => {
      pending.delete(id)
      if (!blob) return null
      const url = URL.createObjectURL(blob)
      urlCache.set(id, url)
      return url
    })
    pending.set(id, p)
  }
  return p
}

export async function deleteMedia(id: string): Promise<void> {
  const url = urlCache.get(id)
  if (url) URL.revokeObjectURL(url)
  urlCache.delete(id)
  await del(id, store)
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
  const [url, setUrl] = useState<string | null>(() => cachedUrl(id))
  useEffect(() => {
    if (!id) {
      setUrl(null)
      return
    }
    const hit = cachedUrl(id)
    if (hit) {
      setUrl(hit)
      return
    }
    let alive = true
    getUrl(id).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [id])
  return url
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

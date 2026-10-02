// Poster frame from a finished video (remote providers return only the MP4). Browser-only; resolves null on failure.
export async function posterFromVideo(video: Blob, maxWidth = 640, timeoutMs = 15_000): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null
  const url = URL.createObjectURL(video)
  const el = document.createElement('video')
  el.muted = true
  el.preload = 'auto'
  el.playsInline = true
  try {
    return await new Promise<Blob | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      const done = (b: Blob | null) => {
        clearTimeout(timer)
        resolve(b)
      }
      el.onerror = () => done(null)
      el.onloadedmetadata = () => {
        const d = Number.isFinite(el.duration) ? el.duration : 0
        el.currentTime = Math.min(1, d * 0.1)
      }
      el.onseeked = () => {
        const w = el.videoWidth
        const h = el.videoHeight
        if (!w || !h) return done(null)
        const scale = Math.min(1, maxWidth / w)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(w * scale)
        canvas.height = Math.round(h * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx) return done(null)
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((b) => done(b), 'image/jpeg', 0.86)
      }
      el.src = url
    })
  } finally {
    el.removeAttribute('src')
    el.load()
    URL.revokeObjectURL(url)
  }
}

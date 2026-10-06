import { createStore, set } from 'idb-keyval'

/** IDs are journaled by the caller BEFORE this writes anything. */
export async function synthMedia(ids: string[]): Promise<void> {
  const store = createStore('ban-dung-phim', 'media')
  for (const [n, id] of ids.entries()) {
    if (!id.startsWith('prf_')) throw new Error('Mã ảnh thử không hợp lệ.')
    const canvas = new OffscreenCanvas(320, 180)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = `hsl(${n * 29} 35% 42%)`
    ctx.fillRect(0, 0, 320, 180)
    ctx.fillStyle = 'white'
    ctx.font = '32px sans-serif'
    ctx.fillText(`Ảnh thử ${n + 1}`, 25, 100)
    await set(id, await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }), store)
  }
}

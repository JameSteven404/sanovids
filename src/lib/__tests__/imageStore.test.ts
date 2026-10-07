import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedUrl, deleteMedia, getUrl, putBlob, releaseUrl, urlCount, useMediaUrl } from '../imageStore'

const db = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }))
vi.mock('idb-keyval', () => ({ createStore: vi.fn(), ...db }))
// Drive render/effect boundaries without a DOM or a browser process.
const hook = vi.hoisted(() => ({
  state: null as { id: string; url: string | null } | null,
  effect: (() => undefined) as () => void | (() => void),
}))
vi.mock('react', () => ({
  useState: () => [hook.state, (value: typeof hook.state) => { hook.state = value }],
  useEffect: (effect: typeof hook.effect) => { hook.effect = effect },
}))
const blob = new Blob(['image'], { type: 'image/png' })
const held: string[] = []
const acquire = (id: string) => { held.push(id); return getUrl(id) }
const release = (id: string) => { held.splice(held.indexOf(id), 1); releaseUrl(id) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
beforeEach(() => {
  db.get.mockReset().mockResolvedValue(blob)
  db.set.mockReset().mockResolvedValue(undefined)
  db.del.mockReset().mockResolvedValue(undefined)
  hook.state = null
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++n}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => {
  for (const id of held.splice(0)) releaseUrl(id)
  expect(urlCount()).toBe(0)
  vi.restoreAllMocks()
})

describe('media URL readers', () => {
  it('clears the previous id during render, before the project-switch cleanup revokes it', async () => {
    expect(useMediaUrl('first')).toBeNull()
    const leave = hook.effect()
    try {
      await vi.waitFor(() => expect(hook.state?.url).toBeTruthy())
      const url = useMediaUrl('first')
      expect(url).toBe(cachedUrl('first'))
      expect(useMediaUrl('second')).toBeNull()
      expect(useMediaUrl(null)).toBeNull()
    } finally {
      leave?.()
    }
    expect(useMediaUrl('first')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('creates lazily, shares one read/URL, and revokes only after the last reader leaves', async () => {
    await putBlob(blob)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    const [a, b] = await Promise.all([acquire('shared'), acquire('shared')])
    expect(a).toBe(b)
    expect(db.get).toHaveBeenCalledTimes(1)
    expect(urlCount()).toBe(1)
    release('shared')
    expect(cachedUrl('shared')).toBe(a)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    release('shared')
    expect(cachedUrl('shared')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(a)
  })

  it('switches projects while preserving a shared image until both views leave', async () => {
    const old = await acquire('old')
    const shared = await acquire('shared')
    await acquire('shared')
    await acquire('new')
    release('old')
    release('shared')
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(old)
    expect(cachedUrl('shared')).toBe(shared)
    expect(urlCount()).toBe(2)
  })

  it('drops late reads after unmount and does not overwrite a new reader of the same id', async () => {
    const late = deferred<Blob>()
    db.get.mockReturnValueOnce(late.promise)
    const old = acquire('image')
    release('image')
    const next = await acquire('image')
    late.resolve(blob)
    expect(await old).toBeNull()
    expect(cachedUrl('image')).toBe(next)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('keeps a deleted image visible to its current readers but refuses new readers', async () => {
    const url = await acquire('deleted')
    await deleteMedia('deleted')
    expect(await acquire('deleted')).toBeNull()
    release('deleted')
    expect(cachedUrl('deleted')).toBe(url)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    release('deleted')
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url)
  })

  it('blocks a read racing a deletion even after the last displayed reader leaves', async () => {
    const deletion = deferred<void>()
    db.del.mockReturnValueOnce(deletion.promise)
    const old = acquire('pending')
    const deleting = deleteMedia('pending')
    release('pending')
    expect(await acquire('pending')).toBeNull()
    expect(await old).toBeNull()
    deletion.resolve()
    await deleting
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('can retry failed or missing reads without retaining a rejected promise', async () => {
    db.get.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce(undefined)
    await expect(acquire('retry')).rejects.toThrow('read failed')
    release('retry')
    expect(await acquire('retry')).toBeNull()
    release('retry')
    expect(await acquire('retry')).toBeTruthy()
    expect(db.get).toHaveBeenCalledTimes(3)
  })

  it('preserves the displayed URL when deletion fails and allows another reader', async () => {
    const url = await acquire('kept')
    db.del.mockRejectedValueOnce(new Error('delete failed'))
    await expect(deleteMedia('kept')).rejects.toThrow('delete failed')
    expect(await acquire('kept')).toBe(url)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })
})

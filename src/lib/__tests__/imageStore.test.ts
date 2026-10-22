import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedUrl, deleteMedia, getUrl, IDLE_MAX, putBlob, releaseUrl, revokeUnusedUrls, urlCount, useMediaUrl } from '../imageStore'

const db = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }))
vi.mock('idb-keyval', () => ({ createStore: vi.fn(), ...db }))
// Drive render/effect boundaries without a DOM or a browser process.
const hook = vi.hoisted(() => ({
  state: null as string | null,
  /** useState's initial value of the last render (a mount's seed). */
  init: undefined as unknown,
  effect: (() => undefined) as () => void | (() => void),
}))
vi.mock('react', () => ({
  useState: (init: unknown) => {
    hook.init = typeof init === 'function' ? (init as () => unknown)() : init
    return [hook.state, (value: typeof hook.state) => { hook.state = value }]
  },
  useEffect: (effect: typeof hook.effect) => { hook.effect = effect },
}))
const blob = new Blob(['image'], { type: 'image/png' })
const held: string[] = []
const acquire = (id: string) => { held.push(id); return getUrl(id) }
const release = (id: string) => { held.splice(held.indexOf(id), 1); releaseUrl(id) }
/** Lets the deferred sweep (setTimeout 0, scheduled before this) run. */
const afterSweep = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
/** One render + effect of useMediaUrl(id): the URL of that first render and the effect's cleanup (= unmount). */
function mount(id: string) {
  const firstRender = useMediaUrl(id)
  const unmount = hook.effect()
  return { firstRender, unmount: () => unmount?.() }
}
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
afterEach(async () => {
  for (const id of held.splice(0)) releaseUrl(id)
  // A project switch revokes everything nobody holds: no test leaves a URL behind.
  revokeUnusedUrls()
  await afterSweep()
  expect(urlCount()).toBe(0)
  vi.restoreAllMocks()
})

describe('media URL readers', () => {
  it('renders only the URL of the current id, and keeps it for the project after the reader leaves', async () => {
    expect(useMediaUrl('first')).toBeNull()
    const leave = hook.effect()
    try {
      await vi.waitFor(() => expect(hook.state).toBeTruthy())
      const url = useMediaUrl('first')
      expect(url).toBe(cachedUrl('first'))
      expect(useMediaUrl('second')).toBeNull()
      expect(useMediaUrl(null)).toBeNull()
    } finally {
      leave?.()
    }
    // Idle, not revoked: the next card showing it (panned back, far / near swap) needs no new read.
    await afterSweep()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(useMediaUrl('first')).toBe(cachedUrl('first'))
    revokeUnusedUrls()
    await afterSweep()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(useMediaUrl('first')).toBeNull()
  })

  it('a remounted only reader shows the picture on its first render: no revoke, no second IndexedDB read', async () => {
    const first = mount('poster')
    expect(first.firstRender).toBeNull()
    await vi.waitFor(() => expect(cachedUrl('poster')).toBeTruthy())
    const url = cachedUrl('poster')
    first.unmount() // the node leaves the view (onlyRenderVisibleElements)…
    await afterSweep()
    const again = mount('poster') // …and comes back
    try {
      expect(again.firstRender).toBe(url)
      // Seeded with it: resolving to the same URL does not render the card again.
      expect(hook.init).toBe(url)
      await afterSweep()
      expect(useMediaUrl('poster')).toBe(url)
      expect(db.get).toHaveBeenCalledTimes(1)
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    } finally {
      again.unmount()
    }
  })

  it('a card swapped in the same commit (far / near) keeps the URL it was rendered with', async () => {
    const url = await acquire('ref')
    revokeUnusedUrls() // even right after a project switch
    // React: the new card renders (cachedUrl), the old card's cleanup releases, then the new card's effect acquires.
    expect(useMediaUrl('ref')).toBe(url)
    release('ref')
    expect(await acquire('ref')).toBe(url)
    await afterSweep()
    expect(cachedUrl('ref')).toBe(url)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('creates lazily, shares one read/URL, and revokes an idle one on a project switch', async () => {
    await putBlob(blob)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    const [a, b] = await Promise.all([acquire('shared'), acquire('shared')])
    expect(a).toBe(b)
    expect(db.get).toHaveBeenCalledTimes(1)
    expect(urlCount()).toBe(1)
    release('shared')
    release('shared')
    await afterSweep()
    expect(cachedUrl('shared')).toBe(a)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    revokeUnusedUrls()
    await afterSweep()
    expect(cachedUrl('shared')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(a)
  })

  it('switching projects revokes the old views\' URLs when they leave, but not one the new project took', async () => {
    const old = await acquire('old')
    const shared = await acquire('shared')
    const idleOld = await acquire('idle-old')
    release('idle-old')
    revokeUnusedUrls()
    // The new project's views mount (a duplicated project shares asset images), then the old ones unmount.
    expect(await acquire('shared')).toBe(shared)
    const fresh = await acquire('new')
    release('old')
    release('shared')
    // Still shown until the old view leaves: nothing is revoked while a reader holds it.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(old)
    await afterSweep()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(old)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(idleOld)
    expect(cachedUrl('shared')).toBe(shared)
    expect(cachedUrl('new')).toBe(fresh)
    expect(urlCount()).toBe(2)
  })

  it('keeps at most IDLE_MAX idle URLs, revoking the least recently released first', async () => {
    const ids = Array.from({ length: IDLE_MAX + 3 }, (_, i) => `p${i}`)
    const urls = await Promise.all(ids.map((id) => getUrl(id)))
    for (const id of ids) releaseUrl(id)
    await afterSweep()
    expect(urlCount()).toBe(IDLE_MAX)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3)
    for (const url of urls.slice(0, 3)) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
    expect(cachedUrl(ids.at(-1))).toBe(urls.at(-1))
  })

  it('a read finishing after its reader left stays for the next reader of this project', async () => {
    const late = deferred<Blob>()
    db.get.mockReturnValueOnce(late.promise)
    const old = acquire('image')
    release('image')
    const next = acquire('image')
    late.resolve(blob)
    expect(await old).toBe(await next)
    expect(cachedUrl('image')).toBe(await next)
    expect(db.get).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('drops a read that finishes after a project switch swept its entry', async () => {
    const late = deferred<Blob>()
    db.get.mockReturnValueOnce(late.promise)
    const old = acquire('image')
    revokeUnusedUrls()
    release('image')
    await afterSweep()
    late.resolve(blob)
    expect(await old).toBeNull()
    expect(cachedUrl('image')).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(await acquire('image')).toBeTruthy()
    expect(db.get).toHaveBeenCalledTimes(2)
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

  it('deleting media nobody shows revokes its idle URL at once', async () => {
    const url = await acquire('gone')
    release('gone')
    await deleteMedia('gone')
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url)
    expect(cachedUrl('gone')).toBeNull()
    expect(urlCount()).toBe(0)
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

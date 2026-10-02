import { describe, expect, it } from 'vitest'
import { createEngineLock, engineLockName, type LockManagerLike } from '../engineLock'

function fakeLocks() {
  const held = new Set<string>()
  const m: LockManagerLike & { held: Set<string> } = {
    held,
    request: async (name, _opts, cb) => {
      await Promise.resolve() // granted asynchronously, like the browser
      if (held.has(name)) return cb(null)
      held.add(name)
      try {
        return await cb({ name })
      } finally {
        held.delete(name)
      }
    },
  }
  return m
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('engine lock', () => {
  it('without Web Locks the tab owns the engine synchronously', () => {
    const lock = createEngineLock(() => null)
    expect(lock.tryAcquire('a')).toBe(true)
    expect(lock.held()).toBe('a')
    expect(lock.shared()).toBe(false)
    lock.release()
    expect(lock.held()).toBeNull()
  })

  it('takes a free lock, keeps it until release, then another tab can take it', async () => {
    const locks = fakeLocks()
    const a = createEngineLock(() => locks)
    const b = createEngineLock(() => locks)
    expect(await a.tryAcquire(engineLockName('p'))).toBe(true)
    expect(a.tryAcquire(engineLockName('p'))).toBe(true) // already held: synchronous
    expect(await b.tryAcquire(engineLockName('p'))).toBe(false)
    a.release()
    await tick()
    expect(locks.held.size).toBe(0)
    expect(await b.tryAcquire(engineLockName('p'))).toBe(true)
    expect(b.held()).toBe('sanovids-engine:p')
  })

  it('taking another name releases the previous one', async () => {
    const locks = fakeLocks()
    const a = createEngineLock(() => locks)
    await a.tryAcquire('x')
    await a.tryAcquire('y')
    await tick()
    expect([...locks.held]).toEqual(['y'])
  })

  it('a grant arriving after release is given back at once', async () => {
    const locks = fakeLocks()
    const a = createEngineLock(() => locks)
    const p = a.tryAcquire('x')
    a.release()
    expect(await p).toBe(false)
    await tick()
    expect(locks.held.size).toBe(0)
    expect(a.held()).toBeNull()
  })

  it('falls back to owning the engine when the API refuses', async () => {
    const a = createEngineLock(() => ({ request: () => Promise.reject(new Error('SecurityError')) }))
    expect(await a.tryAcquire('x')).toBe(true)
    expect(a.shared()).toBe(false)
  })
})

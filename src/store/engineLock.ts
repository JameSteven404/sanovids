// "Which tab runs the job queue of a project": one tab at a time, through the Web Locks API.
// Several tabs/windows (web + installed PWA) can have the same project open. Only the tab holding the lock
// `sanovids-engine:<projectId>` submits and polls jobs; the others only display progress (they reload the runs that
// the running tab saves, see store/persist.ts). A paid job must never be submitted twice by two tabs.
//
// Without the Web Locks API (old browsers, some embedded views, tests) the tab simply owns the engine, as before.
// No React, no stores: unit-tested with a fake lock manager (store/__tests__/engineLock.test.ts).

/** The part of `navigator.locks` (LockManager) used here. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown): Promise<unknown>
}

/** `navigator.locks`, or null when the browser has no Web Locks API. */
export function browserLocks(): LockManagerLike | null {
  try {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks
    return locks && typeof locks.request === 'function' ? locks : null
  } catch {
    return null
  }
}

/** Lock name of a project's engine. */
export const engineLockName = (projectId: string) => `sanovids-engine:${projectId}`

export interface EngineLock {
  /** Name of the lock this tab holds (or owns without Web Locks), else null. */
  held(): string | null
  /** A request for `name` is in flight. */
  pending(): boolean
  /**
   * Take `name` without waiting for another tab to release it. `true` (synchronously) when this tab already holds
   * it or there is no Web Locks API; otherwise a promise: true = now held, false = another tab holds it.
   * Taking a new name releases the previous one.
   */
  tryAcquire(name: string): boolean | Promise<boolean>
  /** Let the held lock go (another tab may take over). No-op when nothing is held. */
  release(): void
  /** True when the Web Locks API is used (false = single-tab fallback). */
  shared(): boolean
}

export function createEngineLock(getLocks: () => LockManagerLike | null = browserLocks): EngineLock {
  let heldName: string | null = null
  let releaseHeld: (() => void) | null = null
  /** Name requested last; a grant for another name (released/replaced meanwhile) is given back at once. */
  let wanted: string | null = null
  let inflight: { name: string; promise: Promise<boolean> } | null = null
  let usesLocks = false

  const release = () => {
    wanted = null
    const done = releaseHeld
    heldName = null
    releaseHeld = null
    done?.()
  }

  return {
    held: () => heldName,
    pending: () => !!inflight,
    shared: () => usesLocks,
    release,
    tryAcquire(name) {
      if (heldName === name) return true
      if (heldName) release()
      wanted = name
      if (inflight?.name === name) return inflight.promise
      const locks = getLocks()
      usesLocks = !!locks
      if (!locks) {
        heldName = name
        return true
      }
      const promise = new Promise<boolean>((resolve) => {
        let settled = false
        const settle = (v: boolean) => {
          if (settled) return
          settled = true
          resolve(v)
        }
        let request: Promise<unknown>
        try {
          request = locks.request(name, { ifAvailable: true }, (lock) => {
            if (!lock) return settle(false)
            if (wanted !== name) return settle(false) // released or replaced while waiting: give it back
            return new Promise<void>((done) => {
              heldName = name
              releaseHeld = done
              settle(true)
            })
          })
        } catch {
          request = Promise.reject(new Error('locks.request threw'))
        }
        // The API exists but refuses (e.g. an opaque origin): behave like a browser without it.
        request.catch(() => {
          if (settled) return
          if (wanted === name) {
            usesLocks = false
            heldName = name
            settle(true)
          } else settle(false)
        })
      }).finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
      inflight = { name, promise }
      return promise
    },
  }
}

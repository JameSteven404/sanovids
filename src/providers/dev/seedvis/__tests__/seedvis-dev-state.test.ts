import { describe, expect, it, vi } from 'vitest'

// IndexedDB stand-in with its copy semantics: every read and write is a structured clone; a throwing updater writes nothing.
const db = vi.hoisted(() => ({ values: new Map<string, unknown>() }))
vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: async (key: string) => structuredClone(db.values.get(key)),
  update: async (key: string, fn: (value: unknown) => unknown) => { db.values.set(key, structuredClone(fn(structuredClone(db.values.get(key))))) },
}))

import { createDevSeedvis } from '../server'
import { indexedSeedvisStore, initialSeedvisState, SEEDVIS_DEV_STATE_KEY } from '../state'

const create = () => ({ route: 'generations.create', idempotencyKey: '12345678-1234-4234-8234-123456789abc',
  body: { model: 'seedance_2.5', mode: 'text-to-video', prompt: 'Một chú mèo', count: 1, duration: 5, aspect_ratio: '16:9' } }) as const
const saved = () => db.values.get(SEEDVIS_DEV_STATE_KEY) as Record<string, any>

describe('IndexedDB seedvis store', () => {
  it('validates a saved value once, re-validates what another writer saved, and writes atomically', async () => {
    db.values.clear()
    const store = indexedSeedvisStore()
    expect(await store.peek(s => s.balances.A001)).toBe(1000)
    await store.change(s => { s.balances.A001 = 900 })
    expect(saved().balances.A001).toBe(900)
    // Its own write is trusted on later reads: no request re-validates every job.
    saved().jobs = 'not checked again'
    expect(await store.peek(s => s.jobs)).toBe('not checked again')
    // Another writer (a new rev) is validated before use: a corrupt value fails closed and a failed change writes nothing.
    saved().rev = 'other-tab'
    await expect(store.peek(s => s.jobs)).rejects.toThrow()
    await expect(store.change(s => { s.balances.A001 = 1 })).rejects.toThrow()
    expect(saved()).toMatchObject({ rev: 'other-tab', balances: { A001: 900 } })
    db.values.set(SEEDVIS_DEV_STATE_KEY, { ...initialSeedvisState(), rev: 'tab-2', balances: { A001: 5, B002: 6 } })
    expect(await store.peek(s => s.balances)).toEqual({ A001: 5, B002: 6 })
    await store.reset()
    expect(await store.peek(s => s.balances.A001)).toBe(1000)
  })

  it('a second simulator instance on the same database replays the same job and charge', async () => {
    db.values.clear()
    const first = createDevSeedvis({ store: indexedSeedvisStore(), sleep: async () => {} })
    const second = createDevSeedvis({ store: indexedSeedvisStore(), sleep: async () => {} })
    const a = await first.request(create())
    const b = await second.request(create())
    expect(a).toMatchObject({ ok: true, status: 202 })
    expect(b).toMatchObject({ ok: true, status: 200, headers: { 'Idempotency-Replayed': 'true' } })
    expect((b as any).json.data.id).toBe((a as any).json.data.id)
    expect(saved().jobs).toHaveLength(1)
    expect(saved().balances.A001).toBe(990)
  })
})

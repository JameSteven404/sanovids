// Minimal transactional idb-keyval double for the real persistence code, isolated to headless stress tests.
const values = new Map<string, unknown>()
export const get = async (key: string) => structuredClone(values.get(key))
export const set = async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }
export const del = async (key: string) => { values.delete(key) }
export const clear = async () => { values.clear() }
export const update = async (key: string, fn: (value: unknown) => unknown) => set(key, fn(await get(key)))
export const createStore = () => (_mode: string, callback: (store: unknown) => unknown) => {
  let pending = 0
  const writes = new Map<string, unknown>()
  const tx = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, error: null }
  const store = {
    transaction: tx,
    get(key: string) {
      pending++
      const request = { result: structuredClone(values.get(key)), onsuccess: () => {} }
      queueMicrotask(() => {
        request.onsuccess()
        if (--pending === 0) queueMicrotask(() => {
          for (const [key, value] of writes) values.set(key, value)
          tx.oncomplete()
        })
      })
      return request
    },
    put(value: unknown, key: string) { writes.set(key, structuredClone(value)) },
  }
  return callback(store)
}

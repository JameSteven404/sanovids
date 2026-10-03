// "Tự động tải bản cập nhật" (lib/updatePrefs): validated on read, only booleans are taken, saved under its own key.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UPDATE_PREFS, parseUpdatePrefs, UPDATE_PREFS_KEY } from '../updatePrefs'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size
    },
  }
}

describe('parseUpdatePrefs', () => {
  it('defaults and garbage', () => {
    expect(DEFAULT_UPDATE_PREFS).toEqual({ autoDownload: true })
    expect(UPDATE_PREFS_KEY).toBe('bdp:pref:updates')
    for (const raw of [null, undefined, '', 'not json', '[false]', 'null', '42', '{"autoDownload":"no"}', '{"autoDownload":0}']) {
      expect(parseUpdatePrefs(raw)).toEqual({ autoDownload: true })
    }
    expect(parseUpdatePrefs('{"autoDownload":false,"extra":1}')).toEqual({ autoDownload: false })
  })
})

describe('useUpdatePrefs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reads the saved value; set() takes booleans only, ignores no-ops and saves', async () => {
    const storage = memoryStorage({ [UPDATE_PREFS_KEY]: '{"autoDownload":false}' })
    vi.stubGlobal('localStorage', storage)
    vi.resetModules()
    const { useUpdatePrefs } = await import('../updatePrefs')
    expect(useUpdatePrefs.getState().autoDownload).toBe(false)
    const listener = vi.fn()
    const off = useUpdatePrefs.subscribe(listener)
    useUpdatePrefs.getState().set({ autoDownload: 'yes' as unknown as boolean })
    useUpdatePrefs.getState().set({} as never)
    useUpdatePrefs.getState().set({ autoDownload: false }) // no change
    expect(listener).not.toHaveBeenCalled()
    useUpdatePrefs.getState().set({ autoDownload: true })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(useUpdatePrefs.getState().autoDownload).toBe(true)
    expect(storage.data.get(UPDATE_PREFS_KEY)).toBe('{"autoDownload":true}')
    off()
  })

  it('broken or missing storage → the default, and set() still works for the session', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    vi.resetModules()
    const { useUpdatePrefs } = await import('../updatePrefs')
    expect(useUpdatePrefs.getState().autoDownload).toBe(true)
    useUpdatePrefs.getState().set({ autoDownload: false })
    expect(useUpdatePrefs.getState().autoDownload).toBe(false)
  })
})

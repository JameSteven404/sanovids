// What the seeded fault-injection simulation (canvasappFuzz.ts) mocks, shared by its spec files
// (canvasapp-fuzz-*.test.ts): each declares `vi.mock` with these factories (vi.mock only works from a test file), so
// the media store and the take ids are the simulation's own — and numbered per seed (a seed must replay exactly).
// No app imports here: a factory loads this module while the modules it mocks are being loaded.
import { vi } from 'vitest'

/** The media store (lib/imageStore) of the simulation: id → blob. */
export const media = new Map<string, Blob>()
/** The id counter of core/ids newId (reset per seed). */
export const ids = { n: 0 }

/** lib/imageStore, in memory. */
export function imageStoreMock() {
  let n = 0
  return {
    putBlob: vi.fn(async (b: Blob, prefix = 'img') => {
      const id = `${prefix}_${++n}`
      media.set(id, b)
      return id
    }),
    getBlob: vi.fn(async (id: string) => media.get(id) ?? null),
    getUrl: vi.fn(async () => null),
    cachedUrl: () => null,
    deleteMedia: vi.fn(async (id: string) => void media.delete(id)),
    dataUrlToBlob: () => new Blob(),
    useMediaUrl: () => null,
  }
}

/** core/ids with newId numbered (`orig`: the real module). */
export function idsMock<T extends object>(orig: T) {
  return {
    ...orig,
    newId: (prefix = '') => {
      const id = `00000000-0000-4000-8000-${(++ids.n).toString(16).padStart(12, '0')}`
      return prefix ? `${prefix}_${id}` : id
    },
  }
}

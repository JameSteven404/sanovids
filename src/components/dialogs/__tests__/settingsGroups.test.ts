// The real Settings groups (SettingsDialog GROUPS) through the search: features that live inside a block group are
// found by their own words.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/imageStore', () => ({
  putBlob: vi.fn(async () => 'x'),
  getBlob: vi.fn(async () => null),
  getUrl: vi.fn(async () => null),
  cachedUrl: () => null,
  deleteMedia: vi.fn(async () => undefined),
  dataUrlToBlob: () => new Blob(),
  useMediaUrl: () => null,
}))

import { GROUPS } from '../SettingsDialog'
import { matchSettings } from '../settingsSearch'

const found = (q: string) => matchSettings(GROUPS, 'basic', q).map((m) => m.group.id)

describe('Settings search over the real groups', () => {
  it('"Nhập job" (a button of the canvasapp gateway block, and of the development panel) is found by its name', () => {
    for (const q of ['nhập job', 'Nhap Job', 'job', 'import job']) {
      expect(found(q)).toContain('gateway')
    }
    expect(found('nhập job')).toEqual(expect.arrayContaining(['gateway', 'dev']))
  })
})

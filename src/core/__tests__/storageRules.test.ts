import { describe, expect, it } from 'vitest'
import { backupWins, isForeignWrite, nextStamp, upsertById } from '../storageRules'

const stamp = (rev: number, tab: string, deleted?: boolean) => ({ rev, tab, at: 0, ...(deleted ? { deleted } : {}) })

describe('isForeignWrite (two tabs on one project)', () => {
  it('nothing stored yet, or nothing written since this tab loaded it: not a conflict', () => {
    expect(isForeignWrite(null, null, 'A')).toBe(false)
    expect(isForeignWrite(stamp(5, 'B'), 5, 'A')).toBe(false)
  })
  it("this tab's own latest write is never a conflict", () => {
    expect(isForeignWrite(stamp(7, 'A'), 5, 'A')).toBe(false)
  })
  it('another tab saved after this tab loaded: conflict (a stale tab must not overwrite it)', () => {
    expect(isForeignWrite(stamp(6, 'B'), 5, 'A')).toBe(true)
    // loaded before the project had any stamp, then another tab saved
    expect(isForeignWrite(stamp(1, 'B'), null, 'A')).toBe(true)
  })
  it('a deleted project is never written back', () => {
    expect(isForeignWrite(stamp(3, 'A', true), 2, 'A')).toBe(true)
  })
  it('stamps count up', () => {
    expect(nextStamp(null, 'A', 1)).toEqual({ rev: 1, tab: 'A', at: 1 })
    expect(nextStamp(stamp(4, 'B'), 'A', 2)).toEqual({ rev: 5, tab: 'A', at: 2 })
  })
})

describe('backupWins (emergency backup at startup)', () => {
  it('wins when nothing was saved since the copy it is based on', () => {
    expect(backupWins({ baseRev: 5, tab: 'A' }, stamp(5, 'A'))).toBe(true)
    expect(backupWins({ baseRev: null, tab: 'A' }, null)).toBe(true)
  })
  it('wins over an older save of the same tab (an undo restores an old updatedAt, so time is not compared)', () => {
    expect(backupWins({ baseRev: 5, tab: 'A' }, stamp(6, 'A'))).toBe(true)
  })
  it("loses to another tab's newer save and to a deleted project", () => {
    expect(backupWins({ baseRev: 5, tab: 'A' }, stamp(6, 'B'))).toBe(false)
    expect(backupWins({ baseRev: 5, tab: 'A' }, stamp(6, 'A', true))).toBe(false)
  })
})

describe('upsertById (project list)', () => {
  it('replaces by id, keeps other entries and sorts newest first', () => {
    const list = [
      { id: 'a', updatedAt: 1 },
      { id: 'b', updatedAt: 3 },
    ]
    expect(upsertById(list, { id: 'a', updatedAt: 5 }).map((m) => m.id)).toEqual(['a', 'b'])
    expect(upsertById(list, { id: 'c', updatedAt: 2 }).map((m) => m.id)).toEqual(['b', 'c', 'a'])
    expect(upsertById(null, { id: 'c', updatedAt: 2 })).toEqual([{ id: 'c', updatedAt: 2 }])
  })
})

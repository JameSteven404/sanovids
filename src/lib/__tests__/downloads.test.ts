import { describe, expect, it } from 'vitest'
import { freeNames, numberedName } from '../downloads'

describe('saving into the chosen folder never overwrites a file', () => {
  it('numbers like the browser does', () => {
    expect(numberedName('S01_T1.webm', 1)).toBe('S01_T1.webm')
    expect(numberedName('S01_T1.webm', 2)).toBe('S01_T1 (2).webm')
    expect(numberedName('S01_T1 - Hang.v2.txt', 3)).toBe('S01_T1 - Hang.v2 (3).txt')
    expect(numberedName('README', 2)).toBe('README (2)')
  })
  it('keeps a video and its prompt .txt on the same number', async () => {
    const taken = new Set(['S01_T1.webm', 'S01_T1.txt', 'S01_T1 (2).txt'])
    expect(await freeNames(['S01_T1.webm', 'S01_T1.txt'], (n) => taken.has(n))).toEqual(['S01_T1 (3).webm', 'S01_T1 (3).txt'])
    expect(await freeNames(['S02_T1.webm', 'S02_T1.txt'], async (n) => taken.has(n))).toEqual(['S02_T1.webm', 'S02_T1.txt'])
  })
})

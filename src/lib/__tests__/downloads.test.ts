import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DOWNLOAD_PREFS, DOWNLOAD_PREFS_KEY, FOLDER_TRASH_PREF_KEY, freeNames, numberedName, parseDownloadPrefs, useDownloadPrefs, validDownloadPatch } from '../downloads'

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

describe('"Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác" (folderUnlinkTrash)', () => {
  afterEach(() => {
    useDownloadPrefs.setState({ folderUnlinkTrash: true })
    vi.unstubAllGlobals()
  })

  it('is on by default and only a boolean is taken (BOOL_KEYS)', () => {
    expect(DEFAULT_DOWNLOAD_PREFS.folderUnlinkTrash).toBe(true)
    expect(validDownloadPatch({ folderUnlinkTrash: false })).toEqual({ folderUnlinkTrash: false })
    for (const bad of ['false', 0, 1, null, {}, []]) expect(validDownloadPatch({ folderUnlinkTrash: bad }), String(bad)).toEqual({})
    expect(parseDownloadPrefs(JSON.stringify({ folderUnlinkTrash: false, withPrompt: 'x' }))).toEqual({ ...DEFAULT_DOWNLOAD_PREFS, folderUnlinkTrash: false })
  })

  it('set() saves it with the other download prefs (it is in the list of stored keys)', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) })
    useDownloadPrefs.getState().set({ folderUnlinkTrash: false })
    expect(useDownloadPrefs.getState().folderUnlinkTrash).toBe(false)
    expect(JSON.parse(data.get(DOWNLOAD_PREFS_KEY)!)).toMatchObject({ folderUnlinkTrash: false, withPrompt: expect.any(Boolean) })
    // junk is ignored, the stored value stays
    useDownloadPrefs.getState().set({ folderUnlinkTrash: 'off' as never })
    expect(useDownloadPrefs.getState().folderUnlinkTrash).toBe(false)
    expect(parseDownloadPrefs(data.get(DOWNLOAD_PREFS_KEY)).folderUnlinkTrash).toBe(false)
  })

  it('an older SanoVids rewriting bdp:pref:downloads without it never turns an "off" back on (own key bdp:pref:folder-trash)', async () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) })
    useDownloadPrefs.getState().set({ folderUnlinkTrash: false })
    expect(data.get(FOLDER_TRASH_PREF_KEY)).toBe('false')
    // 0.5.x (Portable / temp copy, same storage) changes "Kèm file .txt": it writes only the keys it knows
    data.set(DOWNLOAD_PREFS_KEY, JSON.stringify({ autoDownload: false, folderName: null, withPrompt: false, askWhere: true, zipPrompts: true, nameTemplate: '{scene}_{take} - {title}' }))
    vi.resetModules()
    const fresh = await import('../downloads')
    expect(fresh.useDownloadPrefs.getState()).toMatchObject({ folderUnlinkTrash: false, withPrompt: false })
    // garbage in the own key → the downloads value (else the default)
    expect(fresh.parseFolderTrashPref('nope')).toBeUndefined()
    expect(fresh.parseFolderTrashPref(null)).toBeUndefined()
    expect(fresh.parseFolderTrashPref('true')).toBe(true)
  })

  it('set() keeps keys a newer build stored next to these prefs', () => {
    const data = new Map<string, string>([[DOWNLOAD_PREFS_KEY, JSON.stringify({ withPrompt: true, futurePref: 'x' })]])
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) })
    useDownloadPrefs.getState().set({ zipPrompts: false })
    expect(JSON.parse(data.get(DOWNLOAD_PREFS_KEY)!)).toMatchObject({ futurePref: 'x', zipPrompts: false })
  })
})

// electron/main.cjs decides what the desktop app may write (save dialog, folder nodes) and which of those files a cut
// "video → Thư mục" wire may move to the Recycle Bin (ledger + trashSavedGroups). Its <save-rules> block is run here
// as-is, with node:path's Windows and POSIX flavours and a temp folder (the main process never trusts the page).
import { createHash } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'

type PathMod = typeof nodePath.win32
type FsLike = typeof nodeFs
type SaveFile = { name: string; bytes?: Uint8Array; text?: string }
type Via = 'link' | 'again' | 'restore' | 'autosave' | 'manual'
interface LedgerFile {
  name: string
  size: number
  sha256: string
}
interface Group {
  id: string
  folder: string
  folderId: string
  takeId: string
  via: Via
  at: number
  files: LedgerFile[]
  primaryTrashed?: true
}
interface Ledger {
  v: 1
  groups: Group[]
}
type FileResult = 'trashed' | 'missing' | 'changed' | 'failed'
interface TrashOut {
  results: { id: string; takeId: string; files: { name: string; role: 'primary' | 'companion'; result: FileResult; cloud?: true }[] }[]
  keep: Group[]
  removeIds: string[]
}
interface StatLike {
  size: number
  mtimeMs?: number
  ino?: number
  blocks?: number
  isFile(): boolean
  isSymbolicLink(): boolean
}
interface TrashDeps {
  fsp: Pick<FsLike, 'lstat'>
  hashFile: (p: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>
  trash: (p: string) => Promise<void>
  pathMod: PathMod
  signal?: AbortSignal
}
interface SaveRules {
  sanitizeSaveName(raw: unknown, max?: number): string | null
  numberedSaveName(name: string, n: number): string
  folderKey(p: unknown, pathMod: PathMod): string | null
  isAllowedFolder(allowed: unknown, p: unknown, pathMod: PathMod): boolean
  addAllowedFolder(allowed: unknown, p: unknown, pathMod: PathMod): string[]
  parseSaveLocations(raw: unknown, pathMod: PathMod): { lastSaveDir: string | null; folders: string[] }
  checkSaveFiles(files: unknown): { files?: { name: string; bytes?: Uint8Array; text?: string }[]; error?: string }
  checkSaveAsArgs(args: unknown): { suggestedName?: string; title?: string; files?: { name: string }[]; error?: string }
  saveDialogFilters(name: string): { name: string; extensions: string[] }[]
  withSaveExtension(filePath: string, ext: string, pathMod: PathMod): string
  companionSaveName(chosenPath: string, companionName: string, pathMod: PathMod): string | null
  isDirectChild(dir: string, target: string, pathMod: PathMod): boolean
  writeGroupExclusive(dir: string, files: SaveFile[], fsp: FsLike, pathMod: PathMod): Promise<string[]>
  writeSaveReplacing(fsp: FsLike, target: string, data: string | Uint8Array): Promise<void>
  SAVE_MAX_FILE_BYTES: number
  SAVE_MAX_FOLDERS: number
  // ledger + Recycle Bin
  checkSaveOwner(o: unknown): { folderId: string; takeId: string; via: Via } | null
  checkTrashArgs(args: unknown, pathMod: PathMod): { folderPath?: string; folderId?: string; items?: { takeId: string; groupIds: string[] }[]; error?: string }
  parseSaveLedger(raw: unknown, allowed: unknown, pathMod: PathMod): Ledger
  ledgerGroup(dirKey: string | null, owner: unknown, names: unknown, digests: unknown, at: number, id: string, pathMod: PathMod): Group | null
  ledgerWith(ledger: Ledger, add: Group[], removeIds: string[]): Ledger
  selectTrashGroups(ledger: Ledger, dirKey: string | null, folderId: string, item: { takeId: string; groupIds: string[] }): { groups: Group[]; unknown: boolean; elsewhere: boolean }
  judgeSavedFile(entry: LedgerFile, st: StatLike | null, sha: unknown): 'ok' | 'missing' | 'changed'
  savedFileOnlineOnly(st: unknown): boolean
  saveHashTimeoutMs(size: number): number
  saveTrashSupported(dir: string, pathMod: PathMod): boolean
  trashSavedGroups(dir: string, groups: Group[], deps: TrashDeps): Promise<TrashOut>
  SAVE_LEDGER_MAX_GROUPS: number
  SAVE_TRASH_MAX_ITEMS: number
  SAVE_TRASH_MAX_GROUPS: number
  isLedgerName(name: unknown): boolean
  checkLedgerGroup(g: unknown, pathMod: PathMod): Group | null
  savedFileStatProblem(entry: LedgerFile, st: StatLike | null): '' | 'missing' | 'changed'
  sameSavedStat(a: unknown, b: unknown): boolean
  withSaveAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T>
}

function loadSaveRules(): SaveRules {
  const m = /\/\/ <save-rules>[^\n]*\n([\s\S]*?)\/\/ <\/save-rules>/.exec(mainSource)
  if (!m) throw new Error('save-rules block not found in electron/main.cjs')
  return new Function(
    `${m[1]}\nreturn { sanitizeSaveName, numberedSaveName, folderKey, isAllowedFolder, addAllowedFolder, parseSaveLocations, checkSaveFiles, checkSaveAsArgs, saveDialogFilters, withSaveExtension, companionSaveName, isDirectChild, writeGroupExclusive, writeSaveReplacing, SAVE_MAX_FILE_BYTES, SAVE_MAX_FOLDERS, checkSaveOwner, checkTrashArgs, parseSaveLedger, ledgerGroup, ledgerWith, selectTrashGroups, judgeSavedFile, savedFileOnlineOnly, saveHashTimeoutMs, saveTrashSupported, trashSavedGroups, SAVE_LEDGER_MAX_GROUPS, SAVE_TRASH_MAX_ITEMS, SAVE_TRASH_MAX_GROUPS, isLedgerName, checkLedgerGroup, savedFileStatProblem, sameSavedStat, withSaveAbort }`,
  )() as SaveRules
}

const rules = loadSaveRules()
const win = nodePath.win32
const posix = nodePath.posix

describe('electron main: file names written into folders', () => {
  it('a name can never point anywhere else', () => {
    expect(rules.sanitizeSaveName('S01_T1 - Ôm nhau.mp4')).toBe('S01_T1 - Ôm nhau.mp4')
    expect(rules.sanitizeSaveName('../../evil.txt')).toBe('-..-evil.txt')
    expect(rules.sanitizeSaveName('..\\..\\Windows\\win.ini')).toBe('-..-Windows-win.ini')
    expect(rules.sanitizeSaveName('C:\\x.txt')).toBe('C--x.txt')
    expect(rules.sanitizeSaveName('/etc/passwd')).toBe('-etc-passwd')
    expect(rules.sanitizeSaveName('..')).toBeNull()
    expect(rules.sanitizeSaveName('.')).toBeNull()
    expect(rules.sanitizeSaveName(' . ')).toBeNull()
    expect(rules.sanitizeSaveName('')).toBeNull()
    expect(rules.sanitizeSaveName(null)).toBeNull()
    expect(rules.sanitizeSaveName({ toString: () => 'x' })).toBeNull()
  })

  it('no reserved device names, no trailing dots, no control characters', () => {
    expect(rules.sanitizeSaveName('CON.txt')).toBe('_CON.txt')
    expect(rules.sanitizeSaveName('aux')).toBe('_aux')
    expect(rules.sanitizeSaveName('LPT1.mp4')).toBe('_LPT1.mp4')
    expect(rules.sanitizeSaveName('clip.mp4...')).toBe('clip.mp4')
    expect(rules.sanitizeSaveName('a\u0000b\u001fc.txt')).toBe('a-b-c.txt')
  })

  it('cuts long names but keeps the extension', () => {
    const out = rules.sanitizeSaveName('x'.repeat(400) + '.webm')!
    expect(out.length).toBeLessThanOrEqual(180)
    expect(out.endsWith('.webm')).toBe(true)
  })

  it('numbers instead of overwriting', () => {
    expect(rules.numberedSaveName('clip.mp4', 1)).toBe('clip.mp4')
    expect(rules.numberedSaveName('clip.mp4', 2)).toBe('clip (2).mp4')
    expect(rules.numberedSaveName('README', 3)).toBe('README (3)')
  })
})

describe('electron main: only folders the user picked are writable', () => {
  it('compares absolute paths exactly (case-insensitive on Windows, trailing separator ignored)', () => {
    const allowed = rules.addAllowedFolder([], 'C:\\Users\\me\\Videos\\Phim', win)
    expect(rules.isAllowedFolder(allowed, 'C:\\Users\\me\\Videos\\Phim', win)).toBe(true)
    expect(rules.isAllowedFolder(allowed, 'c:\\users\\ME\\videos\\phim\\', win)).toBe(true)
    expect(rules.isAllowedFolder(allowed, 'C:/Users/me/Videos/Phim', win)).toBe(true)
  })

  it('never a parent, a sub-folder, a sibling, a traversal or a relative path', () => {
    const allowed = rules.addAllowedFolder([], 'C:\\Users\\me\\Videos\\Phim', win)
    expect(rules.isAllowedFolder(allowed, 'C:\\Users\\me\\Videos', win)).toBe(false)
    expect(rules.isAllowedFolder(allowed, 'C:\\Users\\me\\Videos\\Phim\\sub', win)).toBe(false)
    expect(rules.isAllowedFolder(allowed, 'C:\\Users\\me\\Videos\\Phim2', win)).toBe(false)
    expect(rules.isAllowedFolder(allowed, 'C:\\Users\\me\\Videos\\Phim\\..\\..\\Desktop', win)).toBe(false)
    expect(rules.isAllowedFolder(allowed, 'Videos\\Phim', win)).toBe(false)
    expect(rules.isAllowedFolder(allowed, '', win)).toBe(false)
    expect(rules.isAllowedFolder(allowed, 42, win)).toBe(false)
    expect(rules.isAllowedFolder(allowed, 'C:\\Users\\me\\Videos\\Phim\u0000', win)).toBe(false)
    expect(rules.isAllowedFolder('not a list', 'C:\\Users\\me\\Videos\\Phim', win)).toBe(false)
  })

  it('a traversal that resolves to the picked folder is the picked folder', () => {
    const allowed = rules.addAllowedFolder([], 'C:\\Phim', win)
    expect(rules.isAllowedFolder(allowed, 'C:\\Phim\\x\\..', win)).toBe(true)
  })

  it('POSIX paths are case-sensitive', () => {
    const allowed = rules.addAllowedFolder([], '/home/me/Phim/', posix)
    expect(rules.isAllowedFolder(allowed, '/home/me/Phim', posix)).toBe(true)
    expect(rules.isAllowedFolder(allowed, '/home/me/phim', posix)).toBe(false)
    expect(rules.isAllowedFolder(allowed, '/home/me', posix)).toBe(false)
  })

  it('keeps the list short and without duplicates', () => {
    let list: string[] = []
    for (let i = 0; i < rules.SAVE_MAX_FOLDERS + 20; i++) list = rules.addAllowedFolder(list, `/f/${i}`, posix)
    list = rules.addAllowedFolder(list, '/f/30', posix)
    expect(list).toHaveLength(rules.SAVE_MAX_FOLDERS)
    expect(list[list.length - 1]).toBe('/f/30')
    expect(list.filter((x) => x === '/f/30')).toHaveLength(1)
    expect(rules.addAllowedFolder(list, 'relative', posix)).toEqual(list)
  })

  it('reads its saved state defensively', () => {
    expect(rules.parseSaveLocations(null, win)).toEqual({ lastSaveDir: null, folders: [] })
    expect(rules.parseSaveLocations({ lastSaveDir: 'rel', folders: ['C:\\A', 'C:\\a', 7, 'x'] }, win)).toEqual({ lastSaveDir: null, folders: ['c:\\a'] })
    expect(rules.parseSaveLocations({ lastSaveDir: 'D:\\Out', folders: 'nope' }, win)).toEqual({ lastSaveDir: 'D:\\Out', folders: [] })
  })

  it('a file to write must sit directly in its folder', () => {
    expect(rules.isDirectChild('C:\\Phim', 'C:\\Phim\\a.mp4', win)).toBe(true)
    expect(rules.isDirectChild('C:\\Phim', 'C:\\Phim\\sub\\a.mp4', win)).toBe(false)
    expect(rules.isDirectChild('C:\\Phim', 'C:\\a.mp4', win)).toBe(false)
    expect(rules.isDirectChild('/p', '/p/a.txt', posix)).toBe(true)
  })
})

describe('electron main: payloads from the page', () => {
  const bytes = new Uint8Array([1, 2, 3])

  it('accepts 1–4 named files, binary or text', () => {
    const ok = rules.checkSaveFiles([
      { name: 'S01_T1.mp4', bytes },
      { name: 'S01_T1.txt', text: 'prompt' },
    ])
    expect(ok.error).toBeUndefined()
    expect(ok.files!.map((f) => f.name)).toEqual(['S01_T1.mp4', 'S01_T1.txt'])
    expect(ok.files![0].bytes).toBe(bytes)
  })

  it('refuses everything else', () => {
    expect(rules.checkSaveFiles([]).error).toBeTruthy()
    expect(rules.checkSaveFiles('x').error).toBeTruthy()
    expect(rules.checkSaveFiles(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, text: '' }))).error).toBeTruthy()
    expect(rules.checkSaveFiles([{ name: '..', bytes }]).error).toBeTruthy()
    expect(rules.checkSaveFiles([{ name: 'a.mp4' }]).error).toBeTruthy()
    expect(rules.checkSaveFiles([{ name: 'a.mp4', bytes: [1, 2, 3] }]).error).toBeTruthy()
    expect(rules.checkSaveFiles([{ name: 'a.txt', text: 'x'.repeat(2_000_001) }]).error).toBeTruthy()
    expect(rules.checkSaveFiles([{ name: 'a.txt', text: '1' }, { name: 'A.TXT', text: '2' }]).error).toBeTruthy()
    // a file over the size limit (a view that claims a huge length is enough to check the rule)
    const huge = { byteLength: rules.SAVE_MAX_FILE_BYTES + 1 }
    Object.setPrototypeOf(huge, Uint8Array.prototype)
    expect(rules.checkSaveFiles([{ name: 'a.mp4', bytes: huge }]).error).toBeTruthy()
  })

  it('save dialog: suggested name, title and file filter', () => {
    const v = rules.checkSaveAsArgs({ suggestedName: 'S01_T1 - Ôm/nhau.mp4', files: [{ name: 'x.mp4', bytes }] })
    expect(v).toMatchObject({ suggestedName: 'S01_T1 - Ôm-nhau.mp4', title: 'Lưu video' })
    expect(rules.checkSaveAsArgs({ files: [{ name: 'Dự án - video chọn.zip', bytes }] })).toMatchObject({ suggestedName: 'Dự án - video chọn.zip', title: 'Lưu file .zip' })
    expect(rules.checkSaveAsArgs({ title: 'Lưu video S01·T1', files: [{ name: 'x.webm', bytes }] }).title).toBe('Lưu video S01·T1')
    expect(rules.checkSaveAsArgs(null).error).toBeTruthy()
    expect(rules.saveDialogFilters('a.mp4')).toEqual([{ name: 'Video MP4', extensions: ['mp4'] }])
    expect(rules.saveDialogFilters('a.webm')).toEqual([{ name: 'Video WebM', extensions: ['webm'] }])
    expect(rules.saveDialogFilters('noext')).toEqual([])
  })

  it('the saved file keeps its real extension; the prompt .txt is named after it', () => {
    expect(rules.withSaveExtension('D:\\Out\\Phim', 'mp4', win)).toBe('D:\\Out\\Phim.mp4')
    expect(rules.withSaveExtension('D:\\Out\\Phim.MP4', 'mp4', win)).toBe('D:\\Out\\Phim.MP4')
    expect(rules.withSaveExtension('D:\\Out\\Phim.mov', 'mp4', win)).toBe('D:\\Out\\Phim.mov.mp4')
    expect(rules.companionSaveName('D:\\Out\\Phim của tôi.mp4', 'S01_T1 - x.txt', win)).toBe('Phim của tôi.txt')
    expect(rules.companionSaveName('/out/clip.webm', 'a.txt', posix)).toBe('clip.txt')
  })
})

// Characters built from code points (no invisible characters in this file).
const RLO = String.fromCodePoint(0x202e)
const ZWSP = String.fromCodePoint(0x200b)
const BOM = String.fromCodePoint(0xfeff)
const CLAPPER = String.fromCodePoint(0x1f3ac)
/** No half of a surrogate pair on its own (encodeURIComponent refuses one). */
function wellFormed(s: string): boolean {
  try {
    encodeURIComponent(s)
    return true
  } catch {
    return false
  }
}

describe('electron main: only the file types SanoVids makes', () => {
  const bytes = new Uint8Array([1])
  it('videos, posters, the prompt .txt, the .zip and the settings .json are accepted', () => {
    for (const name of ['a.mp4', 'a.webm', 'a.mov', 'a.m4v', 'a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.zip', 'a.JSON']) {
      expect(rules.checkSaveFiles([{ name, bytes }]).error).toBeUndefined()
    }
    expect(rules.checkSaveFiles([{ name: 'a.txt', text: 'x' }]).error).toBeUndefined()
  })

  it('programs, shortcuts and Windows settings files are refused, whatever the page sends', () => {
    for (const name of ['update.exe', 'run.bat', 'x.lnk', 'a.hta', 'go.url', 'desktop.ini', 'x.scf', 'a.cmd', 'a.ps1', 'a.js', 'noext']) {
      expect(rules.checkSaveFiles([{ name, text: 'x' }]).error).toMatch(/không được phép/)
    }
    // one bad file refuses the whole group
    expect(rules.checkSaveFiles([{ name: 'S01.mp4', bytes }, { name: 'S01.bat', text: 'x' }]).error).toBeTruthy()
  })

  it('the save dialog writes only a prompt .txt next to the chosen file', () => {
    expect(rules.checkSaveAsArgs({ files: [{ name: 'clip.mp4', bytes }, { name: 'clip.txt', text: 'p' }] }).error).toBeUndefined()
    expect(rules.checkSaveAsArgs({ files: [{ name: 'clip.mp4', bytes }, { name: 'c.bat', text: 'x' }] }).error).toBeTruthy()
    expect(rules.checkSaveAsArgs({ files: [{ name: 'clip.mp4', bytes }, { name: 'd.url', text: 'x' }] }).error).toBeTruthy()
    expect(rules.checkSaveAsArgs({ files: [{ name: 'clip.mp4', bytes }, { name: 'poster.jpg', bytes }] }).error).toBeTruthy()
  })
})

describe('electron main: names that hide what they are', () => {
  it('bidi overrides, zero-width characters and BOMs are removed', () => {
    expect(rules.sanitizeSaveName(`a${RLO}gpj.exe`)).toBe('agpj.exe')
    expect(rules.sanitizeSaveName(`S01${ZWSP}.mp4`)).toBe('S01.mp4')
    expect(rules.sanitizeSaveName(`${BOM}clip.mp4`)).toBe('clip.mp4')
    expect(rules.sanitizeSaveName(RLO)).toBeNull()
    // and the type check sees the real extension
    expect(rules.checkSaveFiles([{ name: `a${RLO}4pm.exe`, text: 'x' }]).error).toBeTruthy()
  })

  it('Windows device names also with spaces before the dot ("nul .txt"), and CONIN$ / CONOUT$', () => {
    expect(rules.sanitizeSaveName('nul .txt')).toBe('_nul .txt')
    expect(rules.sanitizeSaveName('Aux .mp4')).toBe('_Aux .mp4')
    expect(rules.sanitizeSaveName('COM1 .txt')).toBe('_COM1 .txt')
    expect(rules.sanitizeSaveName('lpt1   .mp4')).toBe('_lpt1 .mp4')
    expect(rules.sanitizeSaveName('Nul ...và mẹ.mp4')).toBe('_Nul ...và mẹ.mp4')
    expect(rules.sanitizeSaveName('Con ...và mẹ.txt')).toBe('_Con ...và mẹ.txt')
    expect(rules.sanitizeSaveName('CONOUT$.txt')).toBe('_CONOUT$.txt')
    expect(rules.sanitizeSaveName('conin$')).toBe('_conin$')
    // ordinary names that only start like one
    expect(rules.sanitizeSaveName('Con mèo.mp4')).toBe('Con mèo.mp4')
    expect(rules.sanitizeSaveName('console.txt')).toBe('console.txt')
    expect(rules.sanitizeSaveName('nul-x.txt')).toBe('nul-x.txt')
  })

  it('a long name is never cut in the middle of an emoji', () => {
    const out = rules.sanitizeSaveName('a'.repeat(170) + CLAPPER + 'b'.repeat(40) + '.mp4')!
    expect(out.length).toBeLessThanOrEqual(180)
    expect(out.endsWith('.mp4')).toBe(true)
    expect(wellFormed(out)).toBe(true)
    // the cut falls right after the first half of the pair: that half is dropped
    const cut = rules.sanitizeSaveName('a'.repeat(175) + CLAPPER + 'zzzz.mp4')!
    expect(wellFormed(cut)).toBe(true)
    expect(cut).toBe('a'.repeat(175) + '.mp4')
    // a lone half sent by the page goes too
    expect(rules.sanitizeSaveName('clip' + String.fromCharCode(0xd83c) + '.mp4')).toBe('clip.mp4')
  })
})

describe('electron main: writing a group of files', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'sanovids-save-'))
  })
  afterEach(async () => {
    await nodeFs.rm(dir, { recursive: true, force: true })
  })
  const list = async () => (await nodeFs.readdir(dir)).sort()
  const video = (name: string, text = 'VIDEO'): SaveFile => ({ name, bytes: new TextEncoder().encode(text) })
  const p = nodePath

  it('writes the group under its names, with no temp file left', async () => {
    const names = await rules.writeGroupExclusive(dir, [video('S01_T1.mp4'), { name: 'S01_T1.txt', text: 'prompt' }], nodeFs, p)
    expect(names).toEqual(['S01_T1.mp4', 'S01_T1.txt'])
    expect(await list()).toEqual(['S01_T1.mp4', 'S01_T1.txt'])
    expect(await nodeFs.readFile(p.join(dir, 'S01_T1.mp4'), 'utf8')).toBe('VIDEO')
    expect(await nodeFs.readFile(p.join(dir, 'S01_T1.txt'), 'utf8')).toBe('prompt')
  })

  it('never overwrites: the whole group gets the next free number', async () => {
    await nodeFs.writeFile(p.join(dir, 'S01_T1.txt'), 'mine')
    const names = await rules.writeGroupExclusive(dir, [video('S01_T1.mp4'), { name: 'S01_T1.txt', text: 'prompt' }], nodeFs, p)
    expect(names).toEqual(['S01_T1 (2).mp4', 'S01_T1 (2).txt'])
    expect(await nodeFs.readFile(p.join(dir, 'S01_T1.txt'), 'utf8')).toBe('mine')
    expect(await list()).toEqual(['S01_T1 (2).mp4', 'S01_T1 (2).txt', 'S01_T1.txt'])
  })

  it('a write cut short (disk full) leaves nothing behind: no half file, no .part, not the first file', async () => {
    let n = 0
    const failing = {
      ...nodeFs,
      writeFile: async (file: string, data: string | Uint8Array, opts?: { flag?: string }) => {
        if (++n === 2) {
          // creates the file, then fails in the middle like a full disk
          await nodeFs.writeFile(file, 'half', { flag: 'wx' })
          throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
        }
        return nodeFs.writeFile(file, data, opts)
      },
    } as unknown as FsLike
    await expect(rules.writeGroupExclusive(dir, [video('S01_T1.mp4'), { name: 'S01_T1.txt', text: 'prompt' }], failing, p)).rejects.toMatchObject({
      code: 'ENOSPC',
    })
    expect(await list()).toEqual([])
  })

  it('drives without hard links (FAT / exFAT): renamed after checking the name is free', async () => {
    const noLinks = { ...nodeFs, link: async () => Promise.reject(Object.assign(new Error('no links'), { code: 'EPERM' })) } as unknown as FsLike
    expect(await rules.writeGroupExclusive(dir, [video('a.mp4')], noLinks, p)).toEqual(['a.mp4'])
    expect(await rules.writeGroupExclusive(dir, [video('a.mp4', 'NEW')], noLinks, p)).toEqual(['a (2).mp4'])
    expect(await nodeFs.readFile(p.join(dir, 'a.mp4'), 'utf8')).toBe('VIDEO')
    expect(await list()).toEqual(['a (2).mp4', 'a.mp4'])
  })

  it('a rename Windows still holds for a moment (antivirus) is tried again', async () => {
    let busy = 2
    const held = {
      ...nodeFs,
      link: async () => Promise.reject(Object.assign(new Error('no links'), { code: 'EPERM' })),
      rename: async (a: string, b: string) => (busy-- > 0 ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : nodeFs.rename(a, b)),
    } as unknown as FsLike
    expect(await rules.writeGroupExclusive(dir, [video('b.mp4')], held, p)).toEqual(['b.mp4'])
    expect(await list()).toEqual(['b.mp4'])
  })

  it('replacing the file chosen in the save dialog swaps it in at once', async () => {
    const target = p.join(dir, 'chosen.mp4')
    await nodeFs.writeFile(target, 'OLD')
    await rules.writeSaveReplacing(nodeFs, target, 'NEW')
    expect(await nodeFs.readFile(target, 'utf8')).toBe('NEW')
    expect(await list()).toEqual(['chosen.mp4'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The ledger of folder-node writes and the move to the Recycle Bin (plan 3.2.3 / 3.2.4 / 3.2.9).
// ---------------------------------------------------------------------------------------------------------------

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const ID1 = '0123456789abcdef'
const ID2 = 'fedcba9876543210'
const ID3 = 'aaaaaaaaaaaaaaaa'
const owner = (via: Via = 'link', takeId = 't1', folderId = 'f1') => ({ folderId, takeId, via })
const fileEntry = (name: string, data: string): LedgerFile => ({ name, size: Buffer.byteLength(data), sha256: sha(data) })
const winKey = 'd:\\phim'
const winGroup = (over: Partial<Group> = {}): Group => ({
  id: ID1,
  folder: winKey,
  folderId: 'f1',
  takeId: 't1',
  via: 'link',
  at: 1,
  files: [fileEntry('S01_T1 - Mở đầu.mp4', 'VIDEO'), fileEntry('S01_T1 - Mở đầu.txt', 'prompt')],
  ...over,
})

describe('electron main: who a folder write belongs to (owner) and what trashSaved may name', () => {
  it('owner: folder node id + take id + where the write comes from', () => {
    for (const via of ['link', 'again', 'restore', 'autosave', 'manual'] as Via[]) expect(rules.checkSaveOwner(owner(via))).toEqual(owner(via))
    expect(rules.checkSaveOwner({ ...owner(), extra: 'x' })).toEqual(owner()) // only the known fields
    for (const bad of [null, undefined, 'link', 7, [], { ...owner(), via: 'cut' }, { ...owner(), via: '' }, { ...owner(), takeId: '../t1' }]) {
      expect(rules.checkSaveOwner(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(rules.checkSaveOwner({ ...owner(), folderId: 'x'.repeat(101) })).toBeNull()
    expect(rules.checkSaveOwner({ ...owner(), folderId: 'f 1' })).toBeNull()
    expect(rules.checkSaveOwner({ ...owner(), takeId: 5 })).toBeNull()
  })

  it('trashSaved arguments: an absolute folder, a node id, 1–200 distinct takes with 1–20 group ids each', () => {
    const ok = rules.checkTrashArgs({ folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: 't1', groupIds: [ID1, ID2, ID1] }, { takeId: 't2', groupIds: [ID3] }] }, win)
    expect(ok).toEqual({ folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: 't1', groupIds: [ID1, ID2] }, { takeId: 't2', groupIds: [ID3] }] })
    const item = (takeId: string) => ({ takeId, groupIds: [ID1] })
    const max = Array.from({ length: rules.SAVE_TRASH_MAX_ITEMS }, (_, i) => item(`t${i}`))
    expect(rules.checkTrashArgs({ folderPath: 'D:\\Phim', folderId: 'f1', items: max }, win).error).toBeUndefined()
    const tooManyIds = Array.from({ length: rules.SAVE_TRASH_MAX_GROUPS + 1 }, (_, i) => i.toString(16).padStart(16, '0'))
    const bad: unknown[] = [
      null,
      'x',
      { folderPath: 'Phim', folderId: 'f1', items: [item('t1')] }, // relative
      { folderPath: '', folderId: 'f1', items: [item('t1')] },
      { folderPath: 'D:\\Phim\u0000', folderId: 'f1', items: [item('t1')] },
      { folderPath: 'D:\\Phim', folderId: '', items: [item('t1')] },
      { folderPath: 'D:\\Phim', folderId: 'f/1', items: [item('t1')] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: 'all' },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [...max, item('one-more')] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [item('t1'), item('t1')] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: 't1', groupIds: [] }] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: 't1', groupIds: tooManyIds }] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: 't1', groupIds: [ID1.toUpperCase()] }] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: 't1', groupIds: [ID1.slice(1)] }] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: 't1', groupIds: ['S01_T1.mp4'] }] }, // never a file name
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [{ takeId: 't1', groupIds: ID1 }] },
      { folderPath: 'D:\\Phim', folderId: 'f1', items: [null] },
    ]
    for (const b of bad) expect(rules.checkTrashArgs(b, win).error, JSON.stringify(b)?.slice(0, 120)).toBeTruthy()
    expect(rules.checkTrashArgs({ folderPath: '/home/me/Phim', folderId: 'f1', items: [item('t1')] }, posix).error).toBeUndefined()
  })
})

describe('electron main: the saved-files ledger (userData/saved-files.json)', () => {
  const allowed = [winKey]

  it('a recorded group: names as written (" (n)" included), sizes, SHA-256, the folder key and the owner', () => {
    const g = rules.ledgerGroup(winKey, owner(), ['S01_T1 (2).mp4', 'S01_T1 (2).txt'], [{ size: 5, sha256: sha('VIDEO') }, { size: 6, sha256: sha('prompt') }], 7, ID1, win)
    expect(g).toEqual({
      id: ID1,
      folder: winKey,
      folderId: 'f1',
      takeId: 't1',
      via: 'link',
      at: 7,
      files: [
        { name: 'S01_T1 (2).mp4', size: 5, sha256: sha('VIDEO') },
        { name: 'S01_T1 (2).txt', size: 6, sha256: sha('prompt') },
      ],
    })
    // the longest names a write produces (180 + " (n)") are still recordable
    const long = 'x'.repeat(176) + ' (12).mp4'
    expect(rules.ledgerGroup(winKey, owner(), [long], [{ size: 1, sha256: sha('x') }], 1, ID1, win)).not.toBeNull()
    // anything doubtful → not recorded (the write still happened; it can just never be moved)
    const d = [{ size: 5, sha256: sha('VIDEO') }]
    expect(rules.ledgerGroup(winKey, null, ['a.mp4'], d, 1, ID1, win)).toBeNull()
    expect(rules.ledgerGroup(winKey, owner(), ['a.mp4', 'a.txt'], d, 1, ID1, win)).toBeNull()
    expect(rules.ledgerGroup(winKey, owner(), ['a.zip'], d, 1, ID1, win)).toBeNull()
    expect(rules.ledgerGroup(winKey, owner(), ['settings.json'], d, 1, ID1, win)).toBeNull()
    expect(rules.ledgerGroup(winKey, owner(), ['..\\a.mp4'], d, 1, ID1, win)).toBeNull()
    expect(rules.ledgerGroup(winKey, owner(), ['a.mp4'], d, 1, 'not-an-id', win)).toBeNull()
    expect(rules.ledgerGroup(null, owner(), ['a.mp4'], d, 1, ID1, win)).toBeNull()
    expect(rules.ledgerGroup('D:\\Phim', owner(), ['a.mp4'], d, 1, ID1, win)).toBeNull() // not a folder key (case)
    expect(rules.ledgerGroup(winKey, owner(), ['a.mp4'], [{ size: -1, sha256: sha('x') }], 1, ID1, win)).toBeNull()
    expect(rules.ledgerGroup(winKey, owner(), ['a.mp4'], [{ size: 5, sha256: 'xyz' }], 1, ID1, win)).toBeNull()
  })

  it('reads its file defensively: garbage or another version → empty (nothing can be moved)', () => {
    for (const raw of [null, undefined, 'x', 7, [], { v: 2, groups: [winGroup()] }, { v: 1, groups: 'x' }, { groups: [winGroup()] }]) {
      expect(rules.parseSaveLedger(raw, allowed, win), JSON.stringify(raw)).toEqual({ v: 1, groups: [] })
    }
    expect(rules.parseSaveLedger({ v: 1, groups: [winGroup()] }, allowed, win)).toEqual({ v: 1, groups: [winGroup()] })
    expect(rules.parseSaveLedger({ v: 1, groups: [winGroup()] }, 'nope', win)).toEqual({ v: 1, groups: [] })
  })

  it('drops every group that is not exactly what main writes', () => {
    const f = (over: Partial<LedgerFile>) => [{ ...fileEntry('a.mp4', 'VIDEO'), ...over }]
    const bad: Partial<Group>[] = [
      { id: 'xyz' },
      { id: ID1.toUpperCase() },
      { folder: 'D:\\Phim' }, // not a folder key
      { folder: 'relative' },
      { folder: 'e:\\other' }, // not in the allowlist
      { folderId: '' },
      { takeId: 'a/b' },
      { via: 'cut' as Via },
      { at: -1 },
      { at: Number.NaN },
      { files: [] },
      { files: [1, 2, 3, 4, 5].map((i) => fileEntry(`a${i}.txt`, 'x')) },
      { files: f({ name: '../a.mp4' }) },
      { files: f({ name: '..' }) },
      { files: f({ name: 'a.zip' }) },
      { files: f({ name: 'a.json' }) },
      { files: f({ name: 'a.exe' }) },
      { files: f({ name: 'CON.mp4' }) },
      { files: f({ name: 'a.mp4 ' }) },
      { files: f({ size: rules.SAVE_MAX_FILE_BYTES + 1 }) },
      { files: f({ size: 1.5 }) },
      { files: f({ size: '5' as unknown as number }) },
      { files: f({ sha256: 'g'.repeat(64) }) },
      { files: f({ sha256: sha('x').toUpperCase() }) },
      { files: [fileEntry('a.mp4', 'x'), fileEntry('A.MP4', 'y')] },
    ]
    for (const over of bad) {
      const ids = rules.parseSaveLedger({ v: 1, groups: [winGroup(over), winGroup({ id: ID2 })] }, allowed, win).groups.map((g) => g.id)
      expect(ids, JSON.stringify(over)).toEqual([ID2])
    }
    // the same id twice: neither can be trusted
    expect(rules.parseSaveLedger({ v: 1, groups: [winGroup(), winGroup({ takeId: 't2' }), winGroup({ id: ID2 })] }, allowed, win).groups.map((g) => g.id)).toEqual([ID2])
    // only known fields are kept; primaryTrashed only when exactly true
    const extra = { ...winGroup(), path: 'C:\\Windows', primaryTrashed: 'yes' }
    expect(rules.parseSaveLedger({ v: 1, groups: [extra] }, allowed, win).groups[0]).toEqual(winGroup())
    expect(rules.parseSaveLedger({ v: 1, groups: [winGroup({ primaryTrashed: true })] }, allowed, win).groups[0].primaryTrashed).toBe(true)
    // POSIX keys are case-sensitive paths
    const pg = winGroup({ folder: '/home/me/Phim' })
    expect(rules.parseSaveLedger({ v: 1, groups: [pg] }, ['/home/me/Phim'], posix).groups).toHaveLength(1)
    expect(rules.parseSaveLedger({ v: 1, groups: [pg] }, ['/home/me/phim'], posix).groups).toHaveLength(0)
  })

  it('keeps the newest SAVE_LEDGER_MAX_GROUPS groups', () => {
    const hex = (i: number) => i.toString(16).padStart(16, '0')
    const many = Array.from({ length: rules.SAVE_LEDGER_MAX_GROUPS + 5 }, (_, i) => winGroup({ id: hex(i), at: i }))
    const parsed = rules.parseSaveLedger({ v: 1, groups: many }, allowed, win)
    expect(parsed.groups).toHaveLength(rules.SAVE_LEDGER_MAX_GROUPS)
    expect(parsed.groups[0].id).toBe(hex(5))
    const added = rules.ledgerWith(parsed, [winGroup({ id: ID1 })], [])
    expect(added.groups).toHaveLength(rules.SAVE_LEDGER_MAX_GROUPS)
    expect(added.groups.at(-1)!.id).toBe(ID1)
    expect(added.groups[0].id).toBe(hex(6))
  })

  it('ledgerWith: removes, replaces a kept group in place, appends new ones', () => {
    const l: Ledger = { v: 1, groups: [winGroup({ id: ID1 }), winGroup({ id: ID2 }), winGroup({ id: ID3 })] }
    const reduced = winGroup({ id: ID2, primaryTrashed: true, files: [fileEntry('S01_T1 - Mở đầu.txt', 'prompt')] })
    const next = rules.ledgerWith(l, [reduced, winGroup({ id: 'bbbbbbbbbbbbbbbb' })], [ID1])
    expect(next.groups.map((g) => g.id)).toEqual([ID2, ID3, 'bbbbbbbbbbbbbbbb'])
    expect(next.groups[0]).toEqual(reduced)
    expect(l.groups).toHaveLength(3) // the old ledger is not modified
    expect(rules.ledgerWith(l, [], []).groups).toEqual(l.groups)
  })

  it('selecting what a cut wire may move: its own groups of this node / take / folder, never autosave', () => {
    const l: Ledger = {
      v: 1,
      groups: [
        winGroup({ id: ID1 }),
        winGroup({ id: ID2, via: 'autosave' }),
        winGroup({ id: ID3, folder: 'e:\\cu' }),
        winGroup({ id: 'bbbbbbbbbbbbbbbb', takeId: 't2' }),
        winGroup({ id: 'cccccccccccccccc', folderId: 'f2' }),
        winGroup({ id: 'dddddddddddddddd' }), // same owner, but not one of this wire's groups
      ],
    }
    const pick = (groupIds: string[], takeId = 't1') => rules.selectTrashGroups(l, winKey, 'f1', { takeId, groupIds })
    expect(pick([ID1]).groups.map((g) => g.id)).toEqual([ID1])
    expect(pick([ID1, ID2, ID3, 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc']).groups.map((g) => g.id)).toEqual([ID1])
    expect(pick([ID2])).toEqual({ groups: [], unknown: true, elsewhere: false }) // autosave: never
    expect(pick([ID3])).toEqual({ groups: [], unknown: true, elsewhere: true }) // written into the node's old folder
    expect(pick(['bbbbbbbbbbbbbbbb'])).toEqual({ groups: [], unknown: true, elsewhere: false }) // another take's group
    expect(pick(['cccccccccccccccc'])).toEqual({ groups: [], unknown: true, elsewhere: false }) // another node's group
    expect(pick(['eeeeeeeeeeeeeeee'])).toEqual({ groups: [], unknown: true, elsewhere: false }) // not in the ledger
    expect(pick(['bbbbbbbbbbbbbbbb'], 't2').groups.map((g) => g.id)).toEqual(['bbbbbbbbbbbbbbbb'])
  })
})

describe('electron main: is the saved file still exactly the one SanoVids wrote?', () => {
  const entry = fileEntry('a.mp4', 'VIDEO')
  const st = (over: Partial<StatLike> = {}): StatLike => ({ size: 5, mtimeMs: 1, ino: 1, blocks: 8, isFile: () => true, isSymbolicLink: () => false, ...over })

  it('decision table', () => {
    expect(rules.judgeSavedFile(entry, st(), sha('VIDEO'))).toBe('ok')
    expect(rules.judgeSavedFile(entry, null, sha('VIDEO'))).toBe('missing')
    expect(rules.judgeSavedFile(entry, st({ isSymbolicLink: () => true }), sha('VIDEO'))).toBe('changed')
    expect(rules.judgeSavedFile(entry, st({ isFile: () => false }), sha('VIDEO'))).toBe('changed') // a folder now
    expect(rules.judgeSavedFile(entry, st({ size: 6 }), sha('VIDEO'))).toBe('changed')
    expect(rules.judgeSavedFile(entry, st(), sha('VIDEo'))).toBe('changed')
    expect(rules.judgeSavedFile(entry, st(), undefined)).toBe('changed') // never 'ok' without the hash
    expect(rules.judgeSavedFile(entry, st(), sha('VIDEO').toUpperCase())).toBe('changed')
  })

  it('online-only placeholders (no data on the disk) are recognised; small MFT-resident files are not', () => {
    expect(rules.savedFileOnlineOnly(st({ size: 50_000_000, blocks: 0 }))).toBe(true)
    expect(rules.savedFileOnlineOnly(st({ size: 4096, blocks: 0 }))).toBe(true)
    expect(rules.savedFileOnlineOnly(st({ size: 600, blocks: 0 }))).toBe(false) // a short prompt .txt inside the MFT
    expect(rules.savedFileOnlineOnly(st({ size: 50_000_000, blocks: 97_664 }))).toBe(false)
    expect(rules.savedFileOnlineOnly(st({ size: 50_000_000, blocks: undefined }))).toBe(false)
    expect(rules.savedFileOnlineOnly(null)).toBe(false)
  })

  it('helpers: ledger names, the cheap checks, unchanged-while-hashed, the watchdog race', async () => {
    expect(rules.isLedgerName('S01_T1 - Mở đầu (3).webm')).toBe(true)
    for (const bad of ['a.zip', 'a.json', 'a', '.mp4', 'a/b.mp4', 'a.mp4.', 'nul.txt', 7, null]) expect(rules.isLedgerName(bad), String(bad)).toBe(false)
    expect(rules.checkLedgerGroup(winGroup(), win)).toEqual(winGroup())
    expect(rules.checkLedgerGroup({ ...winGroup(), files: 'x' }, win)).toBeNull()
    expect(rules.savedFileStatProblem(entry, st())).toBe('')
    expect(rules.savedFileStatProblem(entry, null)).toBe('missing')
    expect(rules.savedFileStatProblem(entry, st({ size: 4 }))).toBe('changed')
    expect(rules.sameSavedStat(st(), st())).toBe(true)
    for (const over of [{ size: 6 }, { mtimeMs: 2 }, { ino: 2 }]) expect(rules.sameSavedStat(st(), st(over))).toBe(false)
    expect(rules.sameSavedStat(null, st())).toBe(false)
    expect(await rules.withSaveAbort(Promise.resolve(3))).toBe(3)
    const ctl = new AbortController()
    const pending = rules.withSaveAbort(new Promise(() => undefined), ctl.signal)
    ctl.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await expect(rules.withSaveAbort(Promise.resolve(1), ctl.signal)).rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('hash time limit: 60 s, more for big files (10 MB/s)', () => {
    expect(rules.saveHashTimeoutMs(0)).toBe(60_000)
    expect(rules.saveHashTimeoutMs(100 * 1024 * 1024)).toBe(60_000)
    expect(rules.saveHashTimeoutMs(1024 * 1024 * 1024)).toBe(102_400)
  })

  it('network shares and device paths have no Recycle Bin: never tried', () => {
    expect(rules.saveTrashSupported('D:\\Phim', win)).toBe(true)
    expect(rules.saveTrashSupported('\\\\nas\\share\\Phim', win)).toBe(false)
    expect(rules.saveTrashSupported('//nas/share/Phim', win)).toBe(false)
    expect(rules.saveTrashSupported('\\\\?\\D:\\Phim', win)).toBe(false)
    expect(rules.saveTrashSupported('/home/me/Phim', posix)).toBe(true)
  })
})

describe('electron main: moving a cut wire’s files to the Recycle Bin (trashSavedGroups)', () => {
  let root = ''
  let dir = ''
  let bin = ''
  let key = ''
  const p = nodePath
  const trashed: string[] = []
  const hashed: string[] = []
  const hashFile = async (file: string) => {
    hashed.push(p.basename(file))
    return sha(await nodeFs.readFile(file))
  }
  /** Stands in for shell.trashItem: moves the file out of the folder into a "bin" folder. */
  const trash = async (file: string) => {
    trashed.push(file)
    await nodeFs.rename(file, p.join(bin, `${trashed.length}-${p.basename(file)}`))
  }
  const deps = (over: Partial<TrashDeps> = {}): TrashDeps => ({ fsp: nodeFs, hashFile, trash, pathMod: p, ...over })
  const list = async () => (await nodeFs.readdir(dir)).sort()
  const binList = async () => (await nodeFs.readdir(bin)).map((n) => n.replace(/^\d+-/, '')).sort()
  /** lstat that reports `over` for the files whose name ends with `suffix` (a link, a cloud placeholder…). */
  const lstatWith = (suffix: string, over: Record<string, unknown>) =>
    ({
      lstat: async (file: string) => {
        const s = await nodeFs.lstat(file)
        return file.endsWith(suffix) ? Object.assign(Object.create(Object.getPrototypeOf(s) as object) as object, s, over) : s
      },
    }) as unknown as Pick<FsLike, 'lstat'>

  /** Writes a group like files:writeToFolder does and returns its ledger group. */
  const save = async (files: { name: string; data: string }[], id = ID1, own = owner()): Promise<Group> => {
    const names = await rules.writeGroupExclusive(dir, files.map((f) => ({ name: f.name, text: f.data })), nodeFs, p)
    const g = rules.ledgerGroup(key, own, names, files.map((f) => ({ size: Buffer.byteLength(f.data), sha256: sha(f.data) })), Date.now(), id, p)
    expect(g).not.toBeNull()
    return g!
  }
  const VIDEO = [
    { name: 'S01_T1 - Mở đầu.mp4', data: 'VIDEO-BYTES' },
    { name: 'S01_T1 - Mở đầu.txt', data: 'a prompt' },
  ]

  beforeEach(async () => {
    root = await nodeFs.mkdtemp(p.join(nodeOs.tmpdir(), 'sanovids-trash-'))
    dir = p.join(root, 'Phim')
    bin = p.join(root, 'bin')
    await nodeFs.mkdir(dir)
    await nodeFs.mkdir(bin)
    key = rules.folderKey(dir, p)!
    trashed.length = 0
    hashed.length = 0
  })
  afterEach(async () => {
    await nodeFs.rm(root, { recursive: true, force: true })
  })

  it('unchanged video + prompt .txt → both to the Recycle Bin, the group leaves the ledger', async () => {
    const g = await save(VIDEO)
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results).toEqual([
      {
        id: ID1,
        takeId: 't1',
        files: [
          { name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'trashed' },
          { name: 'S01_T1 - Mở đầu.txt', role: 'companion', result: 'trashed' },
        ],
      },
    ])
    expect(out.removeIds).toEqual([ID1])
    expect(out.keep).toEqual([])
    expect(await list()).toEqual([])
    expect(await binList()).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
    // trash() always gets the absolute path of a file directly inside the folder
    for (const t of trashed) {
      expect(p.isAbsolute(t)).toBe(true)
      expect(rules.isDirectChild(dir, t, p)).toBe(true)
    }
  })

  it('same size but other bytes → changed: kept (it is the user’s now), the .txt is not touched', async () => {
    const g = await save(VIDEO)
    await nodeFs.writeFile(p.join(dir, 'S01_T1 - Mở đầu.mp4'), 'VIDEO-BYTEZ')
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files).toEqual([{ name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'changed' }])
    expect(out.removeIds).toEqual([ID1])
    expect(trashed).toEqual([])
    expect(await list()).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
  })

  it('other size → changed without even hashing it', async () => {
    const g = await save(VIDEO)
    await nodeFs.appendFile(p.join(dir, 'S01_T1 - Mở đầu.mp4'), '+edit')
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files[0].result).toBe('changed')
    expect(hashed).toEqual([])
    expect(trashed).toEqual([])
  })

  it('renamed / moved away → missing: nothing touched, not even the file under its new name', async () => {
    const g = await save(VIDEO)
    await nodeFs.rename(p.join(dir, 'S01_T1 - Mở đầu.mp4'), p.join(dir, 'Cảnh mở đầu - bản cuối.mp4'))
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files).toEqual([{ name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'missing' }])
    expect(out.removeIds).toEqual([ID1])
    expect(trashed).toEqual([])
    expect(await list()).toEqual(['Cảnh mở đầu - bản cuối.mp4', 'S01_T1 - Mở đầu.txt'])
  })

  it('replaced by another file under the same name → changed', async () => {
    const g = await save(VIDEO)
    const file = p.join(dir, 'S01_T1 - Mở đầu.mp4')
    await nodeFs.rm(file)
    await nodeFs.writeFile(file, 'another video, other length')
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files[0].result).toBe('changed')
    expect(await list()).toContain('S01_T1 - Mở đầu.mp4')
  })

  it('a link (or anything not a regular file) under the recorded name → changed, never followed', async () => {
    const g = await save(VIDEO)
    const out = await rules.trashSavedGroups(dir, [g], deps({ fsp: lstatWith('.mp4', { isSymbolicLink: () => true }) }))
    expect(out.results[0].files).toEqual([{ name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'changed' }])
    expect(hashed).toEqual([])
    expect(trashed).toEqual([])
    const asDir = await rules.trashSavedGroups(dir, [g], deps({ fsp: lstatWith('.mp4', { isFile: () => false }) }))
    expect(asDir.results[0].files[0].result).toBe('changed')
  })

  it('a real symbolic link to another file is never followed (when the OS lets the test create one)', async () => {
    const outside = p.join(root, 'outside.mp4')
    await nodeFs.writeFile(outside, 'VIDEO-BYTES')
    const g = await save(VIDEO)
    const file = p.join(dir, 'S01_T1 - Mở đầu.mp4')
    await nodeFs.rm(file)
    try {
      await nodeFs.symlink(outside, file, 'file')
    } catch {
      return // Windows without Developer Mode: covered by the test above
    }
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files[0].result).toBe('changed')
    expect(trashed).toEqual([])
    expect(await nodeFs.readFile(outside, 'utf8')).toBe('VIDEO-BYTES')
  })

  it('the .txt was edited, the video was not → the video goes, the .txt stays', async () => {
    const g = await save(VIDEO)
    await nodeFs.writeFile(p.join(dir, 'S01_T1 - Mở đầu.txt'), 'my notes')
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files).toEqual([
      { name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'trashed' },
      { name: 'S01_T1 - Mở đầu.txt', role: 'companion', result: 'changed' },
    ])
    expect(out.removeIds).toEqual([ID1])
    expect(await list()).toEqual(['S01_T1 - Mở đầu.txt'])
  })

  it('the video stays (edited) → its .txt stays too', async () => {
    const g = await save(VIDEO)
    await nodeFs.writeFile(p.join(dir, 'S01_T1 - Mở đầu.mp4'), 'edited')
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files.map((f) => f.role)).toEqual(['primary'])
    expect(await list()).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
  })

  it('files not in the ledger — siblings with nearly the same name, the user’s own files — are never touched', async () => {
    await nodeFs.writeFile(p.join(dir, 'S01_T1 - Mở đầu.mp4.bak'), 'VIDEO-BYTES')
    await nodeFs.writeFile(p.join(dir, 's01_t1 - mở đầu (copy).mp4'), 'VIDEO-BYTES')
    const g = await save(VIDEO) // → "S01_T1 - Mở đầu.mp4" / ".txt"
    const again = await save(VIDEO, ID2) // "Lưu thêm bản nữa" → " (2)"
    expect(again.files.map((f) => f.name)).toEqual(['S01_T1 - Mở đầu (2).mp4', 'S01_T1 - Mở đầu (2).txt'])
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files.every((f) => f.result === 'trashed')).toBe(true)
    expect(await list()).toEqual(['S01_T1 - Mở đầu (2).mp4', 'S01_T1 - Mở đầu (2).txt', 'S01_T1 - Mở đầu.mp4.bak', 's01_t1 - mở đầu (copy).mp4'])
  })

  it('every copy this wire wrote ("Lưu thêm bản nữa") goes when all its groups are named', async () => {
    const g1 = await save(VIDEO, ID1)
    const g2 = await save(VIDEO, ID2, owner('again'))
    const out = await rules.trashSavedGroups(dir, [g1, g2], deps())
    expect(out.removeIds).toEqual([ID1, ID2])
    expect(await list()).toEqual([])
  })

  it('groups of another folder or written by the scene’s auto-save wire are never touched', async () => {
    const auto = await save(VIDEO, ID1, owner('autosave'))
    const other = { ...(await save([{ name: 'S02_T1.mp4', data: 'V2' }], ID2)), folder: rules.folderKey(p.join(root, 'Khác'), p)! }
    const out = await rules.trashSavedGroups(dir, [auto, other], deps())
    expect(out).toEqual({ results: [], keep: [], removeIds: [] })
    expect(trashed).toEqual([])
    expect(hashed).toEqual([])
    expect(await list()).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt', 'S02_T1.mp4'])
  })

  it('a ledger entry with a doctored name is never used to reach outside the folder', async () => {
    await nodeFs.writeFile(p.join(root, 'secret.mp4'), 'VIDEO-BYTES')
    const g: Group = { ...(await save(VIDEO)), files: [{ name: '..' + p.sep + 'secret.mp4', size: 11, sha256: sha('VIDEO-BYTES') }] }
    const out = await rules.trashSavedGroups(dir, [g], deps())
    expect(out.results[0].files[0].result).toBe('changed')
    expect(trashed).toEqual([])
    expect(await nodeFs.readFile(p.join(root, 'secret.mp4'), 'utf8')).toBe('VIDEO-BYTES')
  })

  it('the Recycle Bin refuses (file in use, no Recycle Bin on that drive) → failed: the file stays, the group stays for "Thử lại"', async () => {
    const g = await save(VIDEO)
    const refusing = async () => {
      throw new Error('Failed to move item to trash')
    }
    const out = await rules.trashSavedGroups(dir, [g], deps({ trash: refusing }))
    expect(out.results[0].files).toEqual([{ name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'failed' }])
    expect(out.keep).toEqual([g])
    expect(out.removeIds).toEqual([])
    expect(await list()).toEqual(['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'])
  })

  it('trash() fails but the file is gone anyway → missing (dropped)', async () => {
    const g = await save([VIDEO[0]])
    const goneThenFail = async (file: string) => {
      await nodeFs.rename(file, p.join(bin, 'x.mp4'))
      throw new Error('reported a failure')
    }
    const out = await rules.trashSavedGroups(dir, [g], deps({ trash: goneThenFail }))
    expect(out.results[0].files[0].result).toBe('missing')
    expect(out.removeIds).toEqual([ID1])
  })

  it('the video went but its .txt could not → only the .txt stays in the ledger, and a retry moves it alone', async () => {
    const g = await save(VIDEO)
    const noTxt = async (file: string) => {
      if (file.endsWith('.txt')) throw new Error('in use')
      return trash(file)
    }
    const out = await rules.trashSavedGroups(dir, [g], deps({ trash: noTxt }))
    expect(out.results[0].files.map((f) => f.result)).toEqual(['trashed', 'failed'])
    expect(out.removeIds).toEqual([])
    expect(out.keep).toEqual([{ ...g, primaryTrashed: true, files: [g.files[1]] }])
    const retry = await rules.trashSavedGroups(dir, out.keep, deps())
    expect(retry.results[0].files).toEqual([{ name: 'S01_T1 - Mở đầu.txt', role: 'companion', result: 'trashed' }])
    expect(retry.removeIds).toEqual([ID1])
    expect(await list()).toEqual([])
  })

  it('hashing fails or times out → failed (kept, nothing moved)', async () => {
    const g = await save(VIDEO)
    const timeouts: number[] = []
    const slow = async (_file: string, timeoutMs: number) => {
      timeouts.push(timeoutMs)
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    }
    const out = await rules.trashSavedGroups(dir, [g], deps({ hashFile: slow }))
    expect(out.results[0].files).toEqual([{ name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'failed' }])
    expect(out.keep).toEqual([g])
    expect(timeouts).toEqual([60_000])
    expect(trashed).toEqual([])
  })

  it('rewritten while it was being hashed (other mtime) → changed, not moved', async () => {
    const g = await save(VIDEO)
    const touching = async (file: string) => {
      const h = await hashFile(file)
      await nodeFs.utimes(file, new Date(2030, 0, 1), new Date(2030, 0, 1))
      return h
    }
    const out = await rules.trashSavedGroups(dir, [g], deps({ hashFile: touching }))
    expect(out.results[0].files[0].result).toBe('changed')
    expect(trashed).toEqual([])
  })

  it('an online-only (cloud placeholder) file is kept without being read', async () => {
    const big = 'V'.repeat(5000)
    const g = await save([{ name: 'S01_T1.mp4', data: big }, { name: 'S01_T1.txt', data: 'p' }])
    const out = await rules.trashSavedGroups(dir, [g], deps({ fsp: lstatWith('.mp4', { blocks: 0 }) }))
    expect(out.results[0].files).toEqual([{ name: 'S01_T1.mp4', role: 'primary', result: 'failed', cloud: true }])
    expect(out.keep).toEqual([g])
    expect(hashed).toEqual([])
    expect(trashed).toEqual([])
    // the same file once it is back on the disk
    const local = await rules.trashSavedGroups(dir, [g], deps())
    expect(local.results[0].files.map((f) => f.result)).toEqual(['trashed', 'trashed'])
  })

  it('after the watchdog nothing more is moved (failed, kept)', async () => {
    const g = await save(VIDEO)
    const ctl = new AbortController()
    ctl.abort()
    const out = await rules.trashSavedGroups(dir, [g], deps({ signal: ctl.signal }))
    expect(out.results[0].files).toEqual([{ name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'failed' }])
    expect(out.keep).toEqual([g])
    expect(trashed).toEqual([])
    expect(hashed).toEqual([])
  })

  it('a trash() that hangs is abandoned when the watchdog fires (failed while the file is still there)', async () => {
    const g = await save([VIDEO[0]])
    const ctl = new AbortController()
    const hanging = () => {
      setTimeout(() => ctl.abort(), 10)
      return new Promise<void>(() => undefined)
    }
    const out = await rules.trashSavedGroups(dir, [g], deps({ trash: hanging, signal: ctl.signal }))
    expect(out.results[0].files[0].result).toBe('failed')
    expect(out.keep).toEqual([g])
  })

  it('network share (no Recycle Bin): failed without reading or moving anything', async () => {
    const unc = '\\\\nas\\share\\Phim'
    const g = winGroup({ folder: rules.folderKey(unc, win)! })
    const touched: string[] = []
    const fsp = {
      lstat: async (f: string) => {
        touched.push(f)
        throw new Error('must not be called')
      },
    } as unknown as Pick<FsLike, 'lstat'>
    const out = await rules.trashSavedGroups(unc, [g], {
      fsp,
      hashFile: async () => {
        touched.push('hash')
        return ''
      },
      trash: async () => {
        touched.push('trash')
      },
      pathMod: win,
    })
    expect(out.results[0].files).toEqual([{ name: 'S01_T1 - Mở đầu.mp4', role: 'primary', result: 'failed' }])
    expect(out.keep).toEqual([g])
    expect(touched).toEqual([])
  })
})

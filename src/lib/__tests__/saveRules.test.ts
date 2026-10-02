// electron/main.cjs decides what the desktop app may write (save dialog, folder nodes). Its <save-rules> block is run
// here as-is, with node:path's Windows and POSIX flavours (the main process never trusts the page).
import { promises as nodeFs } from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import mainSource from '../../../electron/main.cjs?raw'

type PathMod = typeof nodePath.win32
type FsLike = typeof nodeFs
type SaveFile = { name: string; bytes?: Uint8Array; text?: string }
interface SaveRules {
  sanitizeSaveName(raw: unknown): string | null
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
}

function loadSaveRules(): SaveRules {
  const m = /\/\/ <save-rules>[^\n]*\n([\s\S]*?)\/\/ <\/save-rules>/.exec(mainSource)
  if (!m) throw new Error('save-rules block not found in electron/main.cjs')
  return new Function(
    `${m[1]}\nreturn { sanitizeSaveName, numberedSaveName, folderKey, isAllowedFolder, addAllowedFolder, parseSaveLocations, checkSaveFiles, checkSaveAsArgs, saveDialogFilters, withSaveExtension, companionSaveName, isDirectChild, writeGroupExclusive, writeSaveReplacing, SAVE_MAX_FILE_BYTES, SAVE_MAX_FOLDERS }`,
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

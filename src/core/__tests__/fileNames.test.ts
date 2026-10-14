import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanFileBase, cleanTakeFileName, companionFor, cutText, freeNames, MAX_BASE_BYTES, MAX_BASE_LENGTH, MAX_BASE_NFD, numberedName, safeFileName, splitExt, uniqueInSet } from '../fileNames'

describe('file names are safe on every OS', () => {
  it('keeps ordinary Vietnamese names as they are', () => {
    expect(safeFileName('S01_T1 - Ôm nhau')).toBe('S01_T1 - Ôm nhau')
    expect(cleanFileBase('  Cảnh   mở đầu  ')).toBe('Cảnh mở đầu')
  })

  it('never lets a name become a path', () => {
    expect(cleanFileBase('../../Windows/system32')).toBe('-..-Windows-system32')
    expect(cleanFileBase('a/b\\c')).toBe('a-b-c')
    expect(cleanFileBase('C:\\evil')).toBe('C--evil')
    expect(cleanFileBase('..')).toBe('')
    expect(cleanFileBase('.')).toBe('')
    expect(safeFileName('..')).toBe('video')
  })

  it('drops forbidden characters, control characters, leading / trailing dots and spaces', () => {
    expect(cleanFileBase('what?<now>*"|')).toBe('what--now----')
    expect(cleanFileBase('tab\there\u0000')).toBe('tab-here-')
    expect(cleanFileBase('.hidden')).toBe('hidden')
    expect(cleanFileBase('ends with dots...')).toBe('ends with dots')
    expect(cleanFileBase('   ')).toBe('')
  })

  it('never uses a Windows device name', () => {
    expect(cleanFileBase('CON')).toBe('_CON')
    expect(cleanFileBase('nul.txt')).toBe('_nul.txt')
    expect(cleanFileBase('com1')).toBe('_com1')
    expect(cleanFileBase('console')).toBe('console')
  })

  it('cuts very long names', () => {
    expect(cleanFileBase('x'.repeat(500)).length).toBe(120)
  })

  it('never a Windows device name with spaces before the dot either ("nul .txt"), nor CONIN$ / CONOUT$', () => {
    expect(cleanFileBase('nul .txt')).toBe('_nul .txt')
    expect(cleanFileBase('Aux .mp4')).toBe('_Aux .mp4')
    expect(cleanFileBase('COM1 .x')).toBe('_COM1 .x')
    expect(cleanFileBase('Con ...và mẹ')).toBe('_Con ...và mẹ')
    expect(cleanFileBase('CONOUT$.txt')).toBe('_CONOUT$.txt')
    expect(cleanFileBase('conin$')).toBe('_conin$')
    // names that only start like one stay
    expect(cleanFileBase('Con mèo')).toBe('Con mèo')
    expect(cleanFileBase('Nul và mẹ')).toBe('Nul và mẹ')
  })

  it('drops invisible characters that would disguise a name', () => {
    const rlo = String.fromCodePoint(0x202e)
    const zwsp = String.fromCodePoint(0x200b)
    const bom = String.fromCodePoint(0xfeff)
    expect(cleanFileBase(`a${rlo}4pm.exe`)).toBe('a4pm.exe')
    expect(cleanFileBase(`S01${zwsp}_T1`)).toBe('S01_T1')
    expect(cleanFileBase(`${bom}Cảnh`)).toBe('Cảnh')
  })

  it('never cuts an emoji in half (it would become a broken character on disk)', () => {
    const clapper = String.fromCodePoint(0x1f3ac)
    const out = cleanFileBase('a'.repeat(119) + clapper + 'xyz')
    expect(out).toBe('a'.repeat(119))
    expect(cleanFileBase('a'.repeat(118) + clapper + 'xyz')).toBe('a'.repeat(118) + clapper)
    expect(cutText('ab' + clapper, 3)).toBe('ab')
    expect(cutText('abc', 5)).toBe('abc')
    // a lone half is dropped
    expect(cleanFileBase('Cảnh' + String.fromCharCode(0xd83c))).toBe('Cảnh')
  })

  it('is not fooled by non-strings', () => {
    expect(cleanFileBase(undefined)).toBe('')
    expect(cleanFileBase(42)).toBe('')
  })
})

describe('"Tên file" of a take', () => {
  it('sanitizes and drops an extension SanoVids adds itself', () => {
    expect(cleanTakeFileName('Cảnh mở đầu.mp4')).toBe('Cảnh mở đầu')
    expect(cleanTakeFileName('  final cut.WEBM ')).toBe('final cut')
    expect(cleanTakeFileName('v1.2 draft')).toBe('v1.2 draft')
    expect(cleanTakeFileName('a/b')).toBe('a-b')
  })

  it('empty or unusable = back to the default name (null)', () => {
    expect(cleanTakeFileName('')).toBeNull()
    expect(cleanTakeFileName('   ')).toBeNull()
    expect(cleanTakeFileName('..')).toBeNull()
    expect(cleanTakeFileName('.mp4')).toBeNull()
    expect(cleanTakeFileName(null)).toBeNull()
    expect(cleanTakeFileName({})).toBeNull()
  })
})

describe('Windows and Mac filename budgets (same project, same name)', () => {
  it.each(['NFC', 'NFD'] as const)('keeps short %s names and limits long Vietnamese / emoji names without splitting a grapheme', (form) => {
    expect(cleanFileBase('S01_T1 - Cảnh ở Huế'.normalize(form))).toBe('S01_T1 - Cảnh ở Huế')
    for (const raw of ['ệ'.repeat(120), '😀'.repeat(120), '漢'.repeat(120), 'q\u0301'.repeat(120), 'a'.repeat(119) + 'q\u0301']) {
      const out = cleanFileBase(raw.normalize(form))
      expect(out).toBe(cleanFileBase(raw))
      expect(out).toBe(out.normalize('NFC'))
      expect(out.length).toBeLessThanOrEqual(MAX_BASE_LENGTH)
      expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(MAX_BASE_BYTES)
      expect(out.normalize('NFD').length).toBeLessThanOrEqual(MAX_BASE_NFD)
      const segments = [...new Intl.Segmenter('vi', { granularity: 'grapheme' }).segment(raw.normalize('NFC'))].map((s) => s.segment)
      expect(segments.slice(0, [...new Intl.Segmenter('vi', { granularity: 'grapheme' }).segment(out)].length).join('')).toBe(out)
      const final = numberedName(`${out}.jpeg`, 1799999999999)
      expect(new TextEncoder().encode(final).length).toBeLessThanOrEqual(240)
      expect(final.normalize('NFD').length).toBeLessThanOrEqual(240)
    }
  })

  it('uses the exact byte boundary, trims trailing spaces and keeps reserved names within every budget', () => {
    expect(cleanFileBase('ệ'.repeat(120))).toBe('ệ'.repeat(66))
    // This Greek letter is three UTF-8 bytes but four NFD units: NFD is the limiting budget.
    expect(cleanFileBase('\u1f82'.repeat(120))).toBe('\u1f82'.repeat(50))
    expect(cleanFileBase('a'.repeat(119) + 'q\u0301')).toBe('a'.repeat(119))
    expect(cleanFileBase('x'.repeat(119) + ' .more')).toBe('x'.repeat(119))
    const reserved = cleanFileBase('CON.' + 'ệ'.repeat(120))
    expect(reserved.startsWith('_CON.')).toBe(true)
    expect(new TextEncoder().encode(reserved).length).toBeLessThanOrEqual(MAX_BASE_BYTES)
    expect(cleanTakeFileName('ệ'.repeat(120) + '.mp4')).toBe(cleanFileBase('ệ'.repeat(120)))
  })

  it('a cut that leaves a bare device name still gets the "_" (the check runs after the cut)', () => {
    // One grapheme ("á" + 299 marks) is over every budget, so the cut drops it and leaves "NUL " → "NUL".
    expect(cleanFileBase('NUL ' + 'a' + '́'.repeat(300))).toBe('_NUL')
    expect(cleanFileBase('CON x' + '́'.repeat(300))).toBe('_CON')
    // The "_" itself needs room: a reserved name at the exact length budget is cut once more, never over it.
    const atLimit = cleanFileBase('com1.' + 'x'.repeat(MAX_BASE_LENGTH - 5))
    expect(atLimit).toBe('_com1.' + 'x'.repeat(MAX_BASE_LENGTH - 6))
    expect(atLimit.length).toBe(MAX_BASE_LENGTH)
  })

  it('is idempotent: cleaning a cleaned name changes nothing (migrate re-cleans Take.fileName on every load)', () => {
    const pool = ['a', 'Z', ' ', '.', '-', 'ệ', 'ở', 'đ', '́', '̣', 'q', '😀', '👨‍👩‍👧', '🇻🇳', '漢', 'ᾂ', 'é', '‍', 'NUL', 'CON', 'com1', 'lpt²', '\t', '/']
    let seed = 0x5a17c0de
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return seed % n
    }
    const cases = ['NUL ' + 'a' + '́'.repeat(300), 'CON x' + '́'.repeat(300), 'com1.' + 'x'.repeat(200), 'ệ'.repeat(120), '😀'.repeat(120)]
    for (let i = 0; i < 3000; i++) {
      let s = ''
      for (let n = next(4) === 0 ? next(300) : next(50); n > 0; n--) s += pool[next(pool.length)]
      cases.push(s)
    }
    for (const raw of cases) {
      const once = cleanFileBase(raw)
      expect(cleanFileBase(once), JSON.stringify(raw)).toBe(once)
      expect(once.length).toBeLessThanOrEqual(MAX_BASE_LENGTH)
      expect(new TextEncoder().encode(once).length).toBeLessThanOrEqual(MAX_BASE_BYTES)
      expect(once.normalize('NFD').length).toBeLessThanOrEqual(MAX_BASE_NFD)
      expect(once).not.toMatch(/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(\..*)?$/i)
    }
  })
})

describe('cutting without slowing down every render (cleanFileBase runs in TakeNode titles and per-take saves)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  /** A fresh fileNames module whose Intl.Segmenter is `Segmenter` (undefined = an engine without it). */
  async function withSegmenter(Segmenter: unknown) {
    vi.resetModules()
    vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: Segmenter } }))
    return import('../fileNames')
  }

  it('segments only names over a budget, and loads without touching Intl.Segmenter', async () => {
    let created = 0
    let segmented = 0
    const Real = Intl.Segmenter
    class Counting extends Real {
      constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
        super(...args)
        created++
      }
      segment(input: string) {
        segmented++
        return super.segment(input)
      }
    }
    const m = await withSegmenter(Counting)
    expect(created).toBe(0)
    for (const name of ['S01_T1 - Cảnh mở đầu ở Huế', 'ệ'.repeat(66), 'x'.repeat(MAX_BASE_LENGTH), 'NUL']) m.cleanFileBase(name)
    expect(segmented).toBe(0)
    expect(m.cleanFileBase('ệ'.repeat(120))).toBe('ệ'.repeat(66))
    expect(segmented).toBe(1)
    expect(created).toBe(1)
  })

  it('an engine without Intl.Segmenter still loads and cuts between code points (never half of an emoji)', async () => {
    const m = await withSegmenter(undefined)
    expect(m.cleanFileBase('S01_T1 - Cảnh ở Huế')).toBe('S01_T1 - Cảnh ở Huế')
    expect(m.cleanFileBase('ệ'.repeat(120))).toBe('ệ'.repeat(66))
    expect(m.cleanFileBase('😀'.repeat(120))).toBe('😀'.repeat(50))
    expect(m.cleanFileBase('a'.repeat(119) + 'q́')).toBe('a'.repeat(119) + 'q')
    // By code point the marks are kept up to the byte budget (4 + 2 + 97 × 2 = 200): not a device name, no "_".
    expect(m.cleanFileBase('NUL ' + 'a' + '́'.repeat(300))).toBe('NUL á' + '́'.repeat(97))
  })
})

describe('numbering and companions', () => {
  it('numbers like the browser does', () => {
    expect(numberedName('clip.mp4', 1)).toBe('clip.mp4')
    expect(numberedName('clip.mp4', 3)).toBe('clip (3).mp4')
    expect(splitExt('.env')).toEqual({ base: '.env', ext: '' })
  })

  it('keeps names unique inside a zip (case-insensitive, like Windows)', () => {
    const used = new Set<string>(['prompts.txt'])
    expect(uniqueInSet('Cảnh.mp4', used)).toBe('Cảnh.mp4')
    expect(uniqueInSet('cảnh.mp4', used)).toBe('cảnh (2).mp4')
    expect(uniqueInSet('Cảnh.mp4', used)).toBe('Cảnh (3).mp4')
    expect(uniqueInSet('PROMPTS.txt', used)).toBe('PROMPTS (2).txt')
  })

  it('names the prompt .txt after the chosen video name', () => {
    expect(companionFor('Phim của tôi.mp4', 'S01_T1 - title.txt')).toBe('Phim của tôi.txt')
    expect(companionFor('noext', 'a.txt')).toBe('noext.txt')
  })

  it('a video and its .txt share one free number', async () => {
    const taken = new Set(['a.mp4', 'a (2).txt'])
    expect(await freeNames(['a.mp4', 'a.txt'], (n) => taken.has(n))).toEqual(['a (3).mp4', 'a (3).txt'])
  })
})

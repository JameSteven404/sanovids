import { describe, expect, it } from 'vitest'
import { TAKE_CHROME, TAKE_POSTER_H } from '../canvasModel'
import { footerTitle, starTitle, titleLine, TITLE_LINE_EDIT_H, TITLE_LINE_GAP, TITLE_LINE_H } from '../takeNodeModel'

/** Rows of a project saved before 0.6.0 (old ROW_H) and the take card's natural height now (poster + chrome). */
const LEGACY_ROW_H = 248
const TAKE_CARD_H = TAKE_POSTER_H + TAKE_CHROME

describe('take title line (above the card, top-left)', () => {
  it('shows the code, and the custom file name only when the user set one', () => {
    const plain = titleLine({ code: 'S03·T2', fileName: null, hidden: 0, provider: 'dev', renaming: false })
    expect(plain).toEqual({
      chipTitle: 'S03·T2 — bấm đúp để đổi tên file video',
      name: null,
      nameTitle: null,
      showProvider: true,
      showStar: true,
      moreTitle: null,
    })
    const named = titleLine({ code: 'S03·T2', fileName: 'Cảnh ôm nhau', hidden: 2, provider: 'canvasapp', renaming: false })
    expect(named.name).toBe('Cảnh ôm nhau')
    expect(named.nameTitle).toBe('Tên file: Cảnh ôm nhau\nBấm đúp để đổi tên')
    expect(named.moreTitle).toBe('2 take khác của cảnh này đang ẩn — bấm để xem tất cả')
    expect(titleLine({ code: 'S01·T1', fileName: '', hidden: 0, provider: 'dev', renaming: false }).name).toBeNull()
  })

  it('renaming: the input takes the line, ★ and DEV make room (the code chip stays)', () => {
    const r = titleLine({ code: 'S03·T2', fileName: 'x', hidden: 1, provider: 'dev', renaming: true })
    expect(r.showStar).toBe(false)
    expect(r.showProvider).toBe(false)
    expect(r.chipTitle).toContain('S03·T2')
    expect(r.moreTitle).not.toBeNull()
  })

  it('old demo takes carry no provider chip', () => {
    expect(titleLine({ code: 'S01·T1', fileName: null, hidden: 0, provider: 'mock', renaming: false }).showProvider).toBe(false)
  })

  it('the line fits in the room an old 248px row leaves under a take (17px)', () => {
    expect(TITLE_LINE_H + TITLE_LINE_GAP).toBe(17)
    expect(TITLE_LINE_H + TITLE_LINE_GAP).toBeLessThanOrEqual(LEGACY_ROW_H - TAKE_CARD_H)
  })
  it('the rename input fits there too: it never reaches into the take card of the row above (a 20px one did)', () => {
    expect(LEGACY_ROW_H - TAKE_CARD_H).toBeCloseTo(19.125, 3)
    expect(TITLE_LINE_EDIT_H + TITLE_LINE_GAP).toBeLessThanOrEqual(LEGACY_ROW_H - TAKE_CARD_H)
    expect(TITLE_LINE_EDIT_H).toBeGreaterThanOrEqual(TITLE_LINE_H)
  })
})

describe('take footer: the settings stay visible', () => {
  it('tooltip: settings, the custom name when set, and how to rename', () => {
    expect(footerTitle('30s · 480P · 16:9', null)).toBe('30s · 480P · 16:9\nBấm đúp để đổi tên file video')
    expect(footerTitle('30s · 480P · 16:9', 'Cảnh ôm nhau')).toBe('30s · 480P · 16:9\nTên file: Cảnh ôm nhau\nBấm đúp để đổi tên file video')
  })
  it('★ tooltip', () => {
    expect(starTitle(false, false)).toBe('Chỉ chọn được take đã tạo xong')
    expect(starTitle(true, false)).toBe('Chọn take này cho cảnh (★)')
    expect(starTitle(true, true)).toBe('Bỏ chọn take này')
  })
})

// core/folderTrash: which take → folder wires a jump cut / brought back, the main process's answer per take (checked,
// then summed up), batching, and every sentence of "Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác".
import { describe, expect, it } from 'vitest'
import type { TrashSavedTakeResult } from '../../lib/desktopFiles'
import {
  addedSaveLinks,
  checkTrashAnswer,
  CLICK_TO_CUT_TRASH_NOTE,
  FOLDER_UNLINK_TRASH_ROW,
  isTargeted,
  notLinkedText,
  offUnlinkText,
  outcomeOfResult,
  removedSaveLinks,
  restoreToastText,
  SAVE_CUT_BUTTON_TITLE,
  saveWireTitle,
  TRASH_BATCH_MAX,
  TRASH_CONFIRM_MIN,
  TRASH_GROUPS_MAX,
  trashBatches,
  trashConfirmText,
  trashFlushText,
  trashingToastText,
  trashPendingSuffix,
  trashSummaryText,
  unlinkToast,
  type UnlinkKind,
  type UnlinkOutcome,
} from '../folderTrash'
import type { SaveFolder } from '../types'

const folder = (id: string, over: Partial<SaveFolder> = {}): SaveFolder => ({ id, name: id, path: `D:\\${id}`, position: { x: 0, y: 0 }, mode: 'copy', ...over })

describe('limits', () => {
  it('match the main process (checkTrashArgs: ≤ 200 items, ≤ 20 groups) and the plan (ask from 5 videos)', () => {
    expect(TRASH_BATCH_MAX).toBe(200)
    expect(TRASH_GROUPS_MAX).toBe(20)
    expect(TRASH_CONFIRM_MIN).toBe(5)
  })
})

describe('which save wires an undo / redo jump cut or brought back', () => {
  it('compares the take lists of folder nodes present on both sides only', () => {
    const before = [folder('f1', { takes: ['t1', 't2'], autoScenes: ['s1'] }), folder('f2', { takes: ['t3'] }), folder('gone', { takes: ['t9'] })]
    const after = [folder('f1', { takes: ['t2', 't4'] }), folder('f2'), folder('new', { takes: ['t8'] })]
    expect(removedSaveLinks(before, after)).toEqual([
      { folderId: 'f1', takeId: 't1' },
      { folderId: 'f2', takeId: 't3' },
    ])
    expect(addedSaveLinks(before, after)).toEqual([{ folderId: 'f1', takeId: 't4' }])
    // auto-save wires (scene → folder) are never part of it
    expect(removedSaveLinks([folder('f1', { autoScenes: ['s1'] })], [folder('f1')])).toEqual([])
    expect(removedSaveLinks(undefined, after)).toEqual([])
    expect(addedSaveLinks(before, undefined)).toEqual([])
    expect(removedSaveLinks(before, before)).toEqual([])
  })

  it('re-exports isTargeted', () => {
    expect(isTargeted(folder('f', { autoScenes: ['s'] }), { id: 't', sceneId: 's' })).toBe(true)
  })
})

describe('trashBatches', () => {
  it('splits 450 takes into 200 + 200 + 50 (one Delete can cut more than one call may carry)', () => {
    const items = Array.from({ length: 450 }, (_, i) => i)
    expect(trashBatches(items).map((b) => b.length)).toEqual([200, 200, 50])
    expect(trashBatches(items).flat()).toEqual(items)
    expect(trashBatches([])).toEqual([])
    expect(trashBatches([1, 2, 3], 0)).toEqual([[1], [2], [3]])
  })
})

const files = (...f: [string, 'primary' | 'companion', 'trashed' | 'missing' | 'changed' | 'failed'][]) => f.map(([name, role, result]) => ({ name, role, result }))

describe('checkTrashAnswer', () => {
  it('keeps one valid answer per asked take; the rest is unanswered', () => {
    const raw = {
      ok: true,
      results: [
        { takeId: 't1', files: files(['a.mp4', 'primary', 'trashed']) },
        { takeId: 't1', files: [] }, // a second answer for t1: ignored
        { takeId: 'other', files: [] }, // not asked
        { takeId: 't2', files: [{ name: 'x', role: 'boss', result: 'trashed' }] }, // malformed
        { takeId: 't3', unknown: true, elsewhere: true, files: [] },
        { takeId: 't4', unknown: false, elsewhere: true, files: [] },
        null,
        'x',
      ],
    }
    const { results, unanswered } = checkTrashAnswer(raw, ['t1', 't2', 't3', 't4', 't5'])
    expect(results).toEqual([
      { takeId: 't1', files: files(['a.mp4', 'primary', 'trashed']) },
      { takeId: 't3', unknown: true, elsewhere: true, files: [] },
      { takeId: 't4', files: [] },
    ])
    expect(unanswered).toEqual(['t2', 't5'])
    expect(checkTrashAnswer(null, ['t1'])).toEqual({ results: [], unanswered: ['t1'] })
    // `cloud` (an online-only file) is kept next to 'failed' only
    const cloud = checkTrashAnswer(
      {
        results: [
          { takeId: 't1', files: [{ name: 'a.mp4', role: 'primary', result: 'failed', cloud: true }] },
          { takeId: 't2', files: [{ name: 'b.mp4', role: 'primary', result: 'trashed', cloud: true }] },
          { takeId: 't3', files: [{ name: 'c.mp4', role: 'primary', result: 'failed', cloud: 'yes' }] },
        ],
      },
      ['t1', 't2', 't3'],
    )
    expect(cloud.results.map((x) => x.files[0])).toEqual([
      { name: 'a.mp4', role: 'primary', result: 'failed', cloud: true },
      { name: 'b.mp4', role: 'primary', result: 'trashed' },
      { name: 'c.mp4', role: 'primary', result: 'failed' },
    ])
    expect(checkTrashAnswer({ results: 'no' }, [])).toEqual({ results: [], unanswered: [] })
  })
})

describe('outcomeOfResult', () => {
  const r = (f: ReturnType<typeof files>, extra: Partial<TrashSavedTakeResult> = {}): TrashSavedTakeResult => ({ takeId: 't', files: f, ...extra })

  it('one copy with its .txt moved', () => {
    expect(outcomeOfResult(r(files(['S01_T1 - Mở đầu.mp4', 'primary', 'trashed'], ['S01_T1 - Mở đầu.txt', 'companion', 'trashed'])))).toEqual({
      kind: 'trashed',
      copies: 1,
      files: 2,
      name: 'S01_T1 - Mở đầu.mp4',
      withTxt: true,
      txtKept: false,
      failed: 0,
      cloud: 0,
      earlier: false,
      trashedNames: ['S01_T1 - Mở đầu.mp4', 'S01_T1 - Mở đầu.txt'],
    })
  })

  it('video moved, its modified .txt kept', () => {
    const o = outcomeOfResult(r(files(['a.mp4', 'primary', 'trashed'], ['a.txt', 'companion', 'changed'])))
    expect(o).toMatchObject({ kind: 'trashed', copies: 1, files: 1, withTxt: false, txtKept: true })
  })

  it('several copies ("Lưu thêm bản nữa"): every unchanged one counts', () => {
    const o = outcomeOfResult(r(files(['a.mp4', 'primary', 'trashed'], ['a.txt', 'companion', 'trashed'], ['a (2).mp4', 'primary', 'trashed'], ['a (3).mp4', 'primary', 'changed'])))
    expect(o).toMatchObject({ kind: 'trashed', copies: 2, files: 3, name: 'a.mp4', withTxt: false })
  })

  it('nothing moved: failed before changed before missing', () => {
    expect(outcomeOfResult(r(files(['a.mp4', 'primary', 'changed'], ['b.mp4', 'primary', 'failed'])))).toMatchObject({ kind: 'failed', name: 'b.mp4', failed: 1 })
    expect(outcomeOfResult(r(files(['a.mp4', 'primary', 'missing'], ['b.mp4', 'primary', 'changed'])))).toMatchObject({ kind: 'changed', name: 'b.mp4' })
    expect(outcomeOfResult(r(files(['a.mp4', 'primary', 'missing'], ['a.txt', 'companion', 'missing'])))).toMatchObject({ kind: 'missing', copies: 0 })
    expect(outcomeOfResult(r([]))).toMatchObject({ kind: 'missing' })
  })

  it('partly moved: a file that failed is counted (Thử lại)', () => {
    expect(outcomeOfResult(r(files(['a.mp4', 'primary', 'trashed'], ['b.mp4', 'primary', 'failed'])))).toMatchObject({ kind: 'trashed', copies: 1, failed: 1 })
  })

  it('"Thử lại" of a .txt whose video went before: main answers the companion alone (never "missing")', () => {
    expect(outcomeOfResult(r(files(['a.txt', 'companion', 'trashed'])))).toEqual({
      kind: 'trashed',
      copies: 0,
      files: 1,
      name: 'a.txt',
      withTxt: false,
      txtKept: false,
      failed: 0,
      cloud: 0,
      earlier: true,
      trashedNames: ['a.txt'],
    })
    expect(outcomeOfResult(r(files(['a.txt', 'companion', 'failed'])))).toMatchObject({ kind: 'failed', name: 'a.txt', failed: 1, earlier: true })
    expect(outcomeOfResult(r(files(['a.txt', 'companion', 'changed'])))).toMatchObject({ kind: 'changed', name: 'a.txt', earlier: true })
    expect(outcomeOfResult(r(files(['a.txt', 'companion', 'missing'])))).toMatchObject({ kind: 'missing', earlier: true })
    // a companion after a primary that was NOT moved cannot be that primary's (main reports none then): an earlier rest
    expect(outcomeOfResult(r(files(['b.mp4', 'primary', 'changed'], ['a.txt', 'companion', 'trashed'])))).toMatchObject({ kind: 'trashed', copies: 0, name: 'a.txt', earlier: true })
    // after a moved primary it is that copy's .txt
    expect(outcomeOfResult(r(files(['b.mp4', 'primary', 'trashed'], ['b.txt', 'companion', 'trashed'])))).toMatchObject({ copies: 1, withTxt: true, earlier: false })
    // a moved copy plus the rest of an earlier one that still cannot move
    expect(outcomeOfResult(r(files(['a.txt', 'companion', 'failed'], ['b.mp4', 'primary', 'trashed'])))).toMatchObject({ kind: 'trashed', copies: 1, failed: 1, earlier: true })
  })

  it('OneDrive online-only (cloud): kept without "Thử lại" — a real failure still wins', () => {
    const cloudy = [{ name: 'a.mp4', role: 'primary' as const, result: 'failed' as const, cloud: true as const }]
    expect(outcomeOfResult(r(cloudy))).toMatchObject({ kind: 'cloud', name: 'a.mp4', failed: 0, cloud: 1 })
    expect(outcomeOfResult(r([...cloudy, ...files(['b.mp4', 'primary', 'failed'])]))).toMatchObject({ kind: 'failed', name: 'b.mp4', failed: 1, cloud: 1 })
    expect(outcomeOfResult(r([...cloudy, ...files(['b.mp4', 'primary', 'changed'])]))).toMatchObject({ kind: 'cloud', name: 'a.mp4' })
    expect(outcomeOfResult(r([...cloudy, ...files(['b.mp4', 'primary', 'trashed'])]))).toMatchObject({ kind: 'trashed', copies: 1, failed: 0, cloud: 1 })
  })

  it('unknown / elsewhere', () => {
    expect(outcomeOfResult(r([], { unknown: true })).kind).toBe('unknown')
    expect(outcomeOfResult(r([], { unknown: true, elsewhere: true })).kind).toBe('elsewhere')
  })
})

const o = (kind: UnlinkKind, extra: Partial<UnlinkOutcome> = {}): UnlinkOutcome => ({ kind, code: 'S01·T1', folder: 'Phim', ...extra })

describe('unlinkToast: the exact sentences (plan §3.2.7)', () => {
  it('moved', () => {
    expect(unlinkToast(o('trashed', { copies: 1, files: 1, name: 'S01_T1 - Mở đầu.mp4' }))).toEqual({
      text: 'Đã bỏ nối S01·T1 khỏi “Phim” và chuyển “S01_T1 - Mở đầu.mp4” vào Thùng rác.',
      tone: 'success',
    })
    expect(unlinkToast(o('trashed', { copies: 1, files: 2, name: 'a.mp4', withTxt: true }))!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim” và chuyển “a.mp4” và file prompt .txt vào Thùng rác.')
    expect(unlinkToast(o('trashed', { copies: 1, files: 1, name: 'a.mp4', txtKept: true }))!.text).toBe(
      'Đã bỏ nối S01·T1 khỏi “Phim” và chuyển “a.mp4” vào Thùng rác; giữ file prompt .txt vì đã bị sửa.',
    )
    expect(unlinkToast(o('trashed', { copies: 3, files: 5, name: 'a.mp4' }))!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim” và chuyển 3 bản (5 file) vào Thùng rác.')
    const partial = unlinkToast(o('trashed', { copies: 1, files: 1, name: 'a.mp4', someFailed: 1 }))!
    expect(partial).toMatchObject({ tone: 'warning', retry: true })
  })

  it('kept', () => {
    expect(unlinkToast(o('changed', { name: 'a.mp4' }))).toEqual({ text: 'Đã bỏ nối S01·T1 khỏi “Phim”. Giữ lại “a.mp4” vì file đã bị sửa sau khi lưu.', tone: 'warning', ms: 9000 })
    expect(unlinkToast(o('missing'))!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. Không thấy file đã lưu trong thư mục (đã đổi tên, chuyển hoặc xoá?) nên không xoá gì.')
    expect(unlinkToast(o('unknown'))).toEqual({
      text: 'Đã bỏ nối S01·T1 khỏi “Phim”. File của video này được lưu từ bản SanoVids cũ nên không chắc là file nào — đã giữ lại, xoá tay nếu cần.',
      tone: 'info',
      ms: 9000,
    })
    expect(unlinkToast(o('elsewhere'))!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. File đã lưu nằm ở thư mục cũ của node này nên SanoVids không xoá.')
    expect(unlinkToast(o('failed', { name: 'a.mp4' }))).toEqual({
      text: 'Đã bỏ nối S01·T1 khỏi “Phim” nhưng không chuyển được “a.mp4” vào Thùng rác (file đang mở trong chương trình khác, hoặc Thùng rác của ổ này đang tắt / đầy / không có). File vẫn còn.',
      tone: 'warning',
      ms: 12000,
      retry: true,
    })
    expect(unlinkToast(o('cloud', { name: 'a.mp4' }))).toEqual({ text: 'Đã bỏ nối S01·T1 khỏi “Phim”. Giữ “a.mp4” vì file đang chỉ có trên OneDrive (chưa tải về máy).', tone: 'info' })
    expect(unlinkToast(o('queued'))!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. Thư mục đang không mở được — file sẽ vào Thùng rác khi thư mục có lại.')
    expect(unlinkToast(o('pick'))!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. Thư mục chưa được chọn trên máy này nên SanoVids không xoá được file — xoá tay nếu cần.')
    expect(unlinkToast(o('noBlob'))!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. Giữ file trong thư mục vì SanoVids không còn bản video này.')
    expect(unlinkToast(o('unsaved'))!.text).toBe('Đã bỏ nối S01·T1 khỏi thư mục “Phim”.')
    expect(unlinkToast(o('preexisting'))!.text).toBe('Đã bỏ nối S01·T1 khỏi “Phim”. File trong thư mục có từ trước khi nối dây này nên được giữ.')
    expect(unlinkToast(o('off'))!.text).toBe('Đã bỏ nối S01·T1 khỏi thư mục “Phim” (file đã lưu vẫn còn).')
    expect(unlinkToast(o('off'))!.text).toBe(offUnlinkText('S01·T1', 'Phim'))
    expect(unlinkToast(o('linked'))!.text).toMatch(/^Đã bỏ nối S01·T1 khỏi thư mục “Phim” \(file đã lưu vẫn còn/)
    expect(unlinkToast(o('skip'))).toBeNull()
  })
})

describe('trashSummaryText (Delete of several wires)', () => {
  it('what moved, then what was kept', () => {
    const t = trashSummaryText([
      o('trashed', { copies: 1, files: 2 }),
      o('trashed', { copies: 1, files: 1 }),
      o('changed'),
      o('missing'),
      o('unknown'),
      o('unsaved'),
      o('skip'),
    ])
    expect(t).toEqual({ text: 'Đã chuyển 2 video (3 file) đã lưu vào Thùng rác (thư mục “Phim”) · giữ 1 file đã bị sửa · 1 file không thấy · 1 file lưu từ bản cũ (giữ lại).', tone: 'warning', ms: 9000 })
    expect(trashSummaryText([o('trashed', { copies: 1, files: 1 }), o('trashed', { copies: 1, files: 1, folder: 'Khác' })])!.text).toBe('Đã chuyển 2 video (2 file) đã lưu vào Thùng rác (2 thư mục).')
    expect(trashSummaryText([o('failed')])).toMatchObject({ retry: true, tone: 'warning' })
    expect(trashSummaryText([o('trashed', { copies: 1, files: 1 }), o('cloud')])).toEqual({
      text: 'Đã chuyển 1 video (1 file) đã lưu vào Thùng rác (thư mục “Phim”) · 1 file chỉ có trên OneDrive (giữ lại).',
      tone: 'success',
      ms: 9000,
    })
    // nothing worth saying (never saved, setting off)
    expect(trashSummaryText([o('unsaved'), o('off'), o('skip')])).toBeNull()
    expect(trashSummaryText([o('preexisting')])!.text).toBe('Không chuyển file đã lưu nào vào Thùng rác (thư mục “Phim”) · 1 video có file từ trước khi nối (giữ lại).')
  })
})

describe('other sentences', () => {
  it('the confirmation, Hoàn tác, the folder coming back, an old toast, the slow toast', () => {
    expect(trashConfirmText(5, ['Phim', 'Phim'])).toBe('Bỏ nối 5 video khỏi thư mục “Phim” và chuyển các file SanoVids đã lưu của chúng vào Thùng rác của Windows?')
    expect(trashConfirmText(7, ['Phim', 'B', 'C'])).toBe('Bỏ nối 7 video khỏi 3 thư mục và chuyển các file SanoVids đã lưu của chúng vào Thùng rác của Windows?')
    expect(restoreToastText(true, 'S01·T1', 'Phim')).toBe('Đã lưu lại S01·T1 vào “Phim” (bản cũ vẫn nằm trong Thùng rác).')
    expect(restoreToastText(false, 'S01·T1', 'Phim', 'Ổ đĩa đã đầy')).toBe(
      'Không lưu lại được S01·T1 vào “Phim”: Ổ đĩa đã đầy. Bản cũ vẫn nằm trong Thùng rác của Windows — mở Thùng rác để khôi phục.',
    )
    expect(trashFlushText(3, 'Phim')).toBe('Đã chuyển 3 file chờ xoá vào Thùng rác (thư mục “Phim”).')
    expect(notLinkedText('S01·T1', 'Phim')).toBe('S01·T1 không còn nối với “Phim” — nối lại để lưu.')
    expect(trashingToastText('S01·T1', 'Phim')).toBe('Đã bỏ nối S01·T1 khỏi “Phim” — đang chuyển file vào Thùng rác…')
  })

  it('Settings row, wire tooltips, folder node', () => {
    expect(FOLDER_UNLINK_TRASH_ROW.label).toBe('Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác')
    expect(FOLDER_UNLINK_TRASH_ROW.keywords).toBe('xoá xóa file thùng rác recycle bin bỏ nối cắt dây thư mục gỡ đồng bộ')
    expect(FOLDER_UNLINK_TRASH_ROW.hint).toMatch(/không xoá file nào\.$/)
    expect(CLICK_TO_CUT_TRASH_NOTE).toBe('Dây video → Thư mục còn chuyển file đã lưu vào Thùng rác nếu bật ở “Tải video”.')
    expect(saveWireTitle(true, true)).toBe('Bấm để bỏ nối và chuyển file đã lưu vào Thùng rác · Ctrl/Shift + bấm: chọn dây')
    expect(saveWireTitle(false, true)).toBe('Bấm để chọn dây · Delete: bỏ nối và chuyển file đã lưu vào Thùng rác')
    // setting off / other wires: the old tooltips
    expect(saveWireTitle(true, false)).toBe('Bấm để bỏ nối · Ctrl/Shift + bấm: chọn dây')
    expect(saveWireTitle(false, false)).toBe('Bấm để chọn dây · Delete: bỏ nối')
    expect(SAVE_CUT_BUTTON_TITLE).toBe('Bỏ nối và chuyển file đã lưu vào Thùng rác (Delete)')
    expect(trashPendingSuffix(2)).toBe(' · 2 file chờ xoá')
    expect(trashPendingSuffix(0)).toBe('')
  })
})

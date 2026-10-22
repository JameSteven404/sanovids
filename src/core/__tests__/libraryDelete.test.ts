// What a library delete takes, asks and says (core/libraryDelete). Pure: no stores.
import { describe, expect, it } from 'vitest'
import type { Asset, Project, Scene } from '../types'
import {
  assetSceneCounts,
  assetUsage,
  BACKSPACE_HINT,
  deleteButtonState,
  hiddenSuffix,
  libraryCollapsedHint,
  libraryDeleteQuestion,
  libraryDeleteText,
  libraryDeleteTitle,
  libraryFooterHint,
  libraryNothingToDeleteHint,
  librarySelectionCounts,
  nextFocusAfterDelete,
  planLibraryDelete,
} from '../libraryDelete'

const asset = (id: string, name: string, over: Partial<Asset> = {}): Asset => ({
  id, kind: 'character', name, tag: name, description: '', imageIds: [id + '1'], color: '#fff', position: null, ...over,
})

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
  id, order, title: '', prompt: '', refs: [], videoRefs: [], presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null, lastFrame: null, color: null, position: { x: 0, y: 0 }, note: '', ...over,
})

// Library order: elara, lumi, cave, spare, door. Scenes are stored out of order on purpose (usedBy follows scene.order).
// s3 names Lumi (@image_1) and Elara (@image_2) in its prompt; s1 / s2 only link their pictures.
const project: Pick<Project, 'assets' | 'scenes'> = {
  assets: [
    asset('elara', 'Elara', { position: { x: 0, y: 0 } }),
    asset('lumi', 'Lumi'),
    asset('cave', 'Cave'),
    asset('spare', 'Spare'),
    asset('door', 'Door', { position: { x: 10, y: 10 } }),
  ],
  scenes: [
    scene('s3', 3, { refs: ['lumi', 'elara'], prompt: '@image_1 meets @image_2' }),
    scene('s1', 1, { refs: ['elara'], firstFrame: 'door' }),
    scene('s2', 2, { refs: ['cave'], lastFrame: 'elara', prompt: 'a cave' }),
    scene('s4', 4, { firstFrame: 'door', lastFrame: 'door' }),
  ],
}
const names = (id: string) => project.assets.find((a) => a.id === id)?.name ?? '?'

describe('planLibraryDelete', () => {
  it('takes selected ∩ visible ∩ existing, in library order; hidden selected items are kept', () => {
    const plan = planLibraryDelete(project, ['spare', 'ghost', 'elara', 'cave', 'elara'], ['cave', 'spare', 'elara', 'lumi'])
    expect(plan.ids).toEqual(['elara', 'cave', 'spare'])
    expect(plan.hidden).toEqual([])
    const filtered = planLibraryDelete(project, ['spare', 'elara', 'cave'], ['cave'])
    expect(filtered.ids).toEqual(['cave'])
    expect(filtered.hidden).toEqual(['elara', 'spare'])
  })

  it('without a filter (the asset dialog) every existing selected item goes', () => {
    expect(planLibraryDelete(project, ['door', 'ghost'], null).ids).toEqual(['door'])
    expect(planLibraryDelete(project, [], null).ids).toEqual([])
  })

  it('usedBy: scenes using an item as reference image or first / last frame, in scene order, each once', () => {
    const plan = planLibraryDelete(project, ['elara'], null)
    expect(plan.usedBy).toEqual(['s1', 's2', 's3'])
    expect(plan.refScenes).toEqual(['s1', 's3'])
    expect(plan.frameScenes).toEqual(['s2'])
    expect(plan.usingAssets).toEqual(['elara'])
    expect(plan.onCanvas).toEqual(['elara'])
    // a scene with the same item as both frames counts once
    const door = planLibraryDelete(project, ['door'], null)
    expect(door.usedBy).toEqual(['s1', 's4'])
    expect(door.refScenes).toEqual([])
    expect(door.frameScenes).toEqual(['s1', 's4'])
  })

  it('unused items are not "using" anything', () => {
    const plan = planLibraryDelete(project, ['spare', 'cave'], null)
    expect(plan.usingAssets).toEqual(['cave'])
    expect(plan.usedBy).toEqual(['s2'])
    expect(planLibraryDelete(project, ['spare'], null)).toMatchObject({ usedBy: [], usingAssets: [], onCanvas: [] })
  })

  it('assetUsage of nothing is empty', () => {
    expect(assetUsage(project, [])).toEqual({ usedBy: [], refScenes: [], frameScenes: [], usingAssets: new Set() })
  })
})

describe('assetSceneCounts (the card badge "dùng ở N cảnh")', () => {
  it('counts reference images AND first / last frames, a scene once per item', () => {
    expect(assetSceneCounts(project.scenes)).toEqual({ elara: 3, lumi: 1, cave: 1, door: 2 })
  })

  it('agrees with what a delete asks about: a card saying "chưa dùng" is never asked about', () => {
    const counts = assetSceneCounts(project.scenes)
    for (const a of project.assets) {
      const plan = planLibraryDelete(project, [a.id], null)
      expect(counts[a.id] ?? 0, a.id).toBe(plan.usedBy.length)
      // asked ⇒ used (a used item is asked about only when the delete blocks a scene: GT1 Q7a)
      if (libraryDeleteQuestion(plan, names, false)) expect(counts[a.id] ?? 0, a.id).toBeGreaterThan(0)
    }
    expect(libraryDeleteQuestion(planLibraryDelete(project, ['spare'], null), names, false)).toBeNull()
    // a frame-only item is in use (it was "chưa dùng" when only refs were counted)
    expect(assetSceneCounts([scene('x', 1, { lastFrame: 'spare' })])).toEqual({ spare: 1 })
  })
})

describe('the question: only when the delete would block scenes (GT1 Q7a, core/placeholders assetDeleteImpact)', () => {
  it('no question when nothing is used, or when the item is only linked (no prompt names its picture, no frame)', () => {
    expect(libraryDeleteQuestion(planLibraryDelete(project, ['spare'], null), names, false)).toBeNull()
    expect(libraryDeleteQuestion(planLibraryDelete(project, [], null), names, false)).toBeNull()
    const cave = planLibraryDelete(project, ['cave'], null)
    expect(cave.usedBy).toEqual(['s2'])
    expect(cave.impact.needsConfirm).toBe(false)
    expect(libraryDeleteQuestion(cave, names, false)).toBeNull()
  })

  it('one item a prompt names: its name, the scenes that keep red text and stop running, how to undo', () => {
    const plan = planLibraryDelete(project, ['lumi'], null)
    expect(plan.impact).toMatchObject({ sceneIds: ['s3'], placeholders: 1, needsConfirm: true })
    const q = libraryDeleteQuestion(plan, names, false)!
    expect(q).toBe('Xoá “Lumi” khỏi thư viện? 1 cảnh đang dùng nhân vật này sẽ giữ chữ đỏ và chưa chạy được cho tới khi bạn gắn nhân vật khác (Ctrl+Z để hoàn tác).')
    expect(libraryDeleteTitle(plan)).toBe('Xoá khỏi thư viện?')
  })

  it('several items: one question for all of them, counted', () => {
    const plan = planLibraryDelete(project, ['lumi', 'cave', 'spare'], null)
    expect(libraryDeleteQuestion(plan, names, false)).toBe(
      'Xoá 3 mục khỏi thư viện? 1 cảnh đang dùng các mục này sẽ giữ chữ đỏ và chưa chạy được cho tới khi bạn gắn nhân vật khác (Ctrl+Z để hoàn tác).',
    )
    expect(libraryDeleteTitle(plan)).toBe('Xoá 3 mục khỏi thư viện?')
  })

  it('frames are named; a frame-only item says nothing about red text', () => {
    const q = libraryDeleteQuestion(planLibraryDelete(project, ['door'], null), names, false)!
    expect(q).toContain('2 cảnh mất khung đầu / khung cuối')
    expect(q).not.toContain('chữ đỏ')
    const elara = libraryDeleteQuestion(planLibraryDelete(project, ['elara'], null), names, false)!
    expect(elara).toContain('1 cảnh đang dùng nhân vật này sẽ giữ chữ đỏ')
    expect(elara).toContain('1 cảnh mất khung đầu / khung cuối')
  })

  it('Mac wording: ⌘Z, never Ctrl', () => {
    const q = libraryDeleteQuestion(planLibraryDelete(project, ['lumi'], null), names, true)!
    expect(q).toContain('⌘Z')
    expect(q).not.toContain('Ctrl')
  })
})

describe('the toast after a delete (its prompt part: core/staleTokens mediaChangeNote)', () => {
  const renumbered = { text: ' · đánh lại số @image trong 2 prompt', tone: 'info' as const }
  it('one unused item', () => {
    expect(libraryDeleteText(planLibraryDelete(project, ['spare'], null), names, null)).toEqual({ text: 'Đã xoá “Spare” khỏi thư viện.', tone: 'info' })
  })
  it('one item in use: the scenes and the renumbered prompts; longer on screen', () => {
    const t = libraryDeleteText(planLibraryDelete(project, ['elara'], null), names, renumbered)
    expect(t.text).toBe('Đã xoá “Elara” khỏi thư viện và 3 cảnh · đánh lại số @image trong 2 prompt.')
    expect(t.ms).toBe(8000)
  })
  it('several items: how many are in use where', () => {
    expect(libraryDeleteText(planLibraryDelete(project, ['spare', 'cave', 'lumi'], null), names, renumbered).text).toBe(
      'Đã xoá 3 mục khỏi thư viện (2 mục đang dùng ở 2 cảnh) · đánh lại số @image trong 2 prompt.',
    )
    expect(libraryDeleteText(planLibraryDelete(project, ['cave', 'lumi'], null), names, null).text).toBe('Đã xoá 2 mục khỏi thư viện (đang dùng ở 2 cảnh).')
    const unused = libraryDeleteText(planLibraryDelete(project, ['spare'], null), names, null)
    expect(unused.ms).toBeUndefined()
    expect(libraryDeleteText({ ...planLibraryDelete(project, ['spare'], null), ids: ['spare', 'x'] }, names, null).ms).toBe(8000)
  })
  it('red placeholders left / numbers left stale: the warning note, its tone and its time', () => {
    const red = { text: ' — prompt giữ chữ đỏ @image_?1(Lumi) (chặn Chạy) để bạn gắn ảnh thay thế', tone: 'warning' as const, ms: 10000 }
    const t = libraryDeleteText(planLibraryDelete(project, ['lumi'], null), names, red)
    expect(t.text).toBe('Đã xoá “Lumi” khỏi thư viện và 1 cảnh — prompt giữ chữ đỏ @image_?1(Lumi) (chặn Chạy) để bạn gắn ảnh thay thế.')
    expect(t.tone).toBe('warning')
    expect(t.ms).toBe(10000)
    const stale = libraryDeleteText(planLibraryDelete(project, ['lumi'], null), names, { text: ' · tự đánh lại số đang tắt — hãy sửa số @image trong S03', tone: 'warning', ms: 8000 })
    expect(stale.text).toBe('Đã xoá “Lumi” khỏi thư viện và 1 cảnh · tự đánh lại số đang tắt — hãy sửa số @image trong S03.')
    expect(stale.ms).toBe(8000)
  })
  it('selected items hidden by the search / tab are kept, and the toast says so', () => {
    const plan = planLibraryDelete(project, ['spare', 'elara', 'lumi'], ['spare'])
    expect(libraryDeleteText(plan, names, null).text).toBe('Đã xoá “Spare” khỏi thư viện. Giữ 2 mục đang chọn nhưng bị ẩn bởi ô tìm / thẻ lọc.')
  })
})

describe('hints', () => {
  it('nothing selected: how to select, with the platform keys', () => {
    expect(libraryNothingToDeleteHint(false, false)).toBe('Chưa chọn thẻ nào trong Thư viện — bấm vào thẻ (Ctrl/Shift + bấm để chọn nhiều) rồi bấm Delete.')
    const mac = libraryNothingToDeleteHint(true, false)
    expect(mac).toContain('⌘/Shift + bấm')
    expect(mac).toContain('rồi bấm ⌫')
    expect(mac).not.toContain('Ctrl')
  })
  it('every selected card hidden: how to see them', () => {
    expect(libraryNothingToDeleteHint(false, true)).toContain('đang bị ẩn bởi ô tìm / thẻ lọc')
  })
  it('the section collapsed: nothing happens there, and the hint says how to go on (per command)', () => {
    expect(libraryCollapsedHint('delete')).toBe('Thư viện đang thu gọn — mở Thư viện để xoá các thẻ đã chọn, hoặc bấm vào canvas để xoá trên canvas.')
    expect(libraryCollapsedHint('select-all')).toBe('Thư viện đang thu gọn — mở Thư viện để chọn thẻ, hoặc bấm vào canvas để chọn mọi cảnh.')
  })

  it('Backspace names the Delete key and why', () => {
    expect(BACKSPACE_HINT).toBe('Bấm phím Delete (Del) để xoá — Backspace dành cho bộ gõ tiếng Việt.')
  })
})

describe('library footer', () => {
  it('counts selected / visible / hidden', () => {
    const c = librarySelectionCounts(['a', 'b', 'c'], new Set(['a', 'c', 'z']))
    expect(c).toEqual({ selected: 3, visible: 2, hidden: 1 })
    expect(hiddenSuffix(c)).toBe(' (1 đang ẩn)')
    expect(hiddenSuffix(librarySelectionCounts(['a'], new Set(['a'])))).toBe('')
  })
  it('the trash button counts what it deletes: the visible selected cards', () => {
    const c = librarySelectionCounts(['a', 'b', 'c'], new Set(['a', 'c']))
    expect(deleteButtonState(c, false)).toEqual({ label: 'Xoá 2 mục khỏi thư viện (Delete) — hoàn tác được', enabled: true })
    expect(deleteButtonState(c, true).label).toBe('Xoá 2 mục khỏi thư viện (⌫) — hoàn tác được')
  })
  it('every selected card hidden: the button is off and says why', () => {
    const off = deleteButtonState(librarySelectionCounts(['a'], new Set()), false)
    expect(off.enabled).toBe(false)
    expect(off.label).toContain('đang bị ẩn')
  })
  it('the hint names multi-select, connect and delete keys per platform', () => {
    expect(libraryFooterHint(false)).toBe('Kéo thả vào cảnh để nối · Ctrl/Shift + bấm: chọn nhiều · C: nối · Delete: xoá')
    expect(libraryFooterHint(true)).toBe('Kéo thả vào cảnh để nối · ⌘/Shift + bấm: chọn nhiều · C: nối · ⌫: xoá')
  })
})

describe('nextFocusAfterDelete', () => {
  const list = ['a', 'b', 'c', 'd', 'e']
  it('the card right after the last deleted one', () => {
    expect(nextFocusAfterDelete(list, ['b'])).toBe('c')
    expect(nextFocusAfterDelete(list, ['b', 'c'])).toBe('d')
  })
  it('not adjacent: after the last deleted one', () => {
    expect(nextFocusAfterDelete(list, ['a', 'c'])).toBe('d')
  })
  it('at the end: the nearest card before it', () => {
    expect(nextFocusAfterDelete(list, ['e'])).toBe('d')
    expect(nextFocusAfterDelete(list, ['d', 'e'])).toBe('c')
  })
  it('everything deleted, or nothing visible deleted: null', () => {
    expect(nextFocusAfterDelete(list, list)).toBeNull()
    expect(nextFocusAfterDelete(list, ['zz'])).toBeNull()
    expect(nextFocusAfterDelete([], ['a'])).toBeNull()
  })
})

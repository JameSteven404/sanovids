// Library delete end to end (libraryActions) with the real project / UI stores: the delete goes at once unless it would
// block scenes (red placeholders in prompts naming a deleted picture, a lost first / last frame: GT1 Q7a), which asks
// ONE question in the app's own dialog (store/confirm, never window.confirm); one undo step, drafts committed first,
// selections cleaned, media never deleted, and where the delete keys act (isLibraryKeyTarget, drag & drop). The replacement text of a deleted item's tokens belongs to the placeholder
// track: these tests only check that no numbered token points at the deleted item (or at another picture) and that
// Hoàn tác gives the prompts back verbatim.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const h = vi.hoisted(() => ({ deleteMedia: vi.fn(async () => {}) }))
vi.mock('../lib/imageStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/imageStore')>()
  return { ...real, deleteMedia: h.deleteMedia }
})

import { canvasEvents, edgeId, WIRES_CUT_EVENT, type WireCutDetail } from '../actions'
import { imageSlotsFor, parseTokens } from '../core/compile'
import type { Project, Scene } from '../core/types'
import {
  assetDragEnded,
  deleteLibraryAssets,
  deleteLibrarySelection,
  isLibraryKeyTarget,
  libraryArea,
  noteAssetDropOutside,
  noteLibraryPointer,
  registerLibraryView,
  resetLibraryActionsForTests,
  selectAllInLibrary,
} from '../libraryActions'
import { register as registerDraft } from '../lib/promptDrafts'
import { redo, undo, useProject } from '../store/project'
import { requestImages } from '../store/runs'
import { answerConfirm, useConfirm } from '../store/confirm'
import { useUI } from '../store/ui'

const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
  id,
  order,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: order * 400 },
  note: '',
  ...over,
})

const PROMPT_S1 = '@image_1 @image_2 with @image_3 in @image_4'
const project = (): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [
    { id: 'a', kind: 'character', name: 'Elara', tag: 'Elara', description: '', imageIds: ['i1', 'i2'], color: '#fff', position: null },
    { id: 'b', kind: 'character', name: 'Lumi', tag: 'Lumi', description: '', imageIds: ['i3'], color: '#fff', position: null },
    { id: 'c', kind: 'location', name: 'Cave', tag: 'Cave', description: '', imageIds: ['i4'], color: '#fff', position: null },
    { id: 'd', kind: 'prop', name: 'Spare', tag: 'Spare', description: '', imageIds: ['i5'], color: '#fff', position: null },
    { id: 'e', kind: 'location', name: 'Door', tag: 'Door', description: '', imageIds: ['i6'], color: '#fff', position: { x: -400, y: 0 } },
  ],
  scenes: [
    scene('s1', 1, { refs: ['a', 'b', 'c'], prompt: PROMPT_S1 }),
    scene('s2', 2, { refs: ['b'], prompt: '@image_1 waves' }),
    scene('s3', 3, { firstFrame: 'e', settings: { model: 'minimax_h3', mode: 'transform', duration: 6, resolution: '768p', ratio: '16:9' } }),
    scene('s4', 4, { prompt: 'empty room' }),
  ],
})

const st = () => useProject.getState()
const history = () => useProject.temporal.getState()
const sc = (id: string) => st().project.scenes.find((s) => s.id === id)!
const assetIds = () => st().project.assets.map((a) => a.id)
const toasts = () => useUI.getState().toasts
const lastToast = () => toasts()[toasts().length - 1]

/** Image keys the numbered tokens of a scene's prompt resolve to, in order (undefined = points at nothing). */
function resolvedKeys(s: Scene): (string | undefined)[] {
  const slots = imageSlotsFor(st().project.assets, s.refs)
  return parseTokens(s.prompt)
    .filter((t) => t.kind === 'image')
    .map((t) => {
      const slot = slots[t.n - 1]
      return slot ? `${slot.assetId}:${slot.imageId}` : undefined
    })
}

/** A fake element inside one area of the page (duck-typed like libraryActions reads it). */
function el(area: '.sb-library' | '.toasts' | '.modal-backdrop' | null, tagName = 'DIV') {
  return {
    tagName,
    blur: vi.fn(),
    closest: (selector: string) => (area && selector.split(',').map((s) => s.trim()).includes(area) ? {} : null),
  }
}
const BODY = { tagName: 'BODY', closest: () => null }

let visible: string[]
let collapsed: boolean
let focusCard: Mock<(id: string) => void>
let confirm: Mock<(question: string) => boolean>
let unregister: () => void
let offConfirm: () => void

beforeEach(() => {
  vi.useFakeTimers()
  resetLibraryActionsForTests()
  st().loadProject(project())
  history().clear()
  useUI.setState({ librarySelection: [], selectedIds: [], toasts: [], view: 'canvas', dialog: { kind: 'none' }, draggingAssetIds: null })
  confirm = vi.fn((_question: string) => true)
  // The question shows in the app's own dialog (store/confirm → ConfirmSheet): answered here as the user would. No
  // window.confirm in the stub — using it would throw.
  offConfirm = useConfirm.subscribe((s) => {
    if (s.request) answerConfirm(confirm(s.request.text))
  })
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  visible = ['a', 'b', 'c', 'd', 'e']
  collapsed = false
  focusCard = vi.fn((_id: string) => {})
  unregister = registerLibraryView({ visibleIds: () => visible, collapsed: () => collapsed, focusCard })
})

afterEach(() => {
  offConfirm()
  answerConfirm(false)
  unregister()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // Never: duplicated projects share blobs, queued takes and the undo history still read them.
  expect(h.deleteMedia).not.toHaveBeenCalled()
})

describe('unused items: one press, no question', () => {
  it('deletes at once as ONE undo step, with Hoàn tác; undo / redo give back the exact projects', () => {
    const before = st().project
    useUI.setState({ librarySelection: ['d'] })
    expect(deleteLibrarySelection()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(assetIds()).toEqual(['a', 'b', 'c', 'e'])
    expect(history().pastStates).toHaveLength(1)
    const after = st().project
    expect(lastToast()).toMatchObject({ text: 'Đã xoá “Spare” khỏi thư viện.', tone: 'info' })
    expect(lastToast().action?.label).toBe('Hoàn tác')
    undo()
    expect(st().project).toBe(before)
    redo()
    expect(st().project).toBe(after)
  })

  it('the toast button undoes it while nothing newer happened', () => {
    useUI.setState({ librarySelection: ['d'] })
    deleteLibrarySelection()
    lastToast().action!.run()
    expect(assetIds()).toContain('d')
  })

  it('the toast button refuses once a newer edit exists (Ctrl+Z steps back instead)', () => {
    useUI.setState({ librarySelection: ['d'] })
    deleteLibrarySelection()
    const action = lastToast().action!
    st().updateScene('s4', { title: 'later edit' })
    action.run()
    expect(assetIds()).not.toContain('d')
    expect(sc('s4').title).toBe('later edit')
    expect(lastToast().tone).toBe('warning')
  })

  it('nothing is selected afterwards; the keyboard focus moves to the next card', () => {
    useUI.setState({ librarySelection: ['b', 'd'] })
    visible = ['a', 'c', 'd', 'e'] // b hidden by the search
    deleteLibrarySelection()
    expect(useUI.getState().librarySelection).toEqual(['b'])
    expect(focusCard).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(focusCard).toHaveBeenCalledWith('e')
  })
})

describe('items whose delete would block scenes: one question with the counts', () => {
  it('asks once; Cancel leaves everything untouched', () => {
    confirm.mockReturnValue(false)
    const before = st().project
    useUI.setState({ librarySelection: ['b'] })
    expect(deleteLibrarySelection()).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    const question = String(confirm.mock.calls[0][0])
    expect(question).toBe('Xoá “Lumi” khỏi thư viện? 2 cảnh đang dùng nhân vật này sẽ giữ chữ đỏ và chưa chạy được cho tới khi bạn gắn nhân vật khác (Ctrl+Z để hoàn tác).')
    expect(useConfirm.getState().request).toBeNull()
    expect(st().project).toBe(before)
    expect(history().pastStates).toHaveLength(0)
    expect(useUI.getState().librarySelection).toEqual(['b'])
    expect(toasts()).toHaveLength(0)
  })

  it('accepted: gone from every scene in one step; no numbered token points at it or at another picture; undo is verbatim', () => {
    const before = st().project
    useUI.setState({ librarySelection: ['b'] })
    expect(deleteLibrarySelection()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(history().pastStates).toHaveLength(1)
    expect(sc('s1').refs).toEqual(['a', 'c'])
    expect(sc('s2').refs).toEqual([])
    // Elara's two pictures and the cave keep their tokens; nothing resolves to Lumi, nothing dangles onto another picture.
    expect(resolvedKeys(sc('s1'))).toEqual(['a:i1', 'a:i2', 'c:i4'])
    expect(resolvedKeys(sc('s2'))).toEqual([])
    for (const s of st().project.scenes) expect(resolvedKeys(s).every((k) => k !== undefined && !k.startsWith('b:'))).toBe(true)
    expect(lastToast().text).toContain('Đã xoá “Lumi” khỏi thư viện và 2 cảnh')
    expect(lastToast().action?.label).toBe('Hoàn tác')
    undo()
    expect(st().project).toBe(before)
    expect(sc('s1').prompt).toBe(PROMPT_S1)
    expect(sc('s2').prompt).toBe('@image_1 waves')
  })

  it('a first / last frame counts as in use; the canvas animates the wires that go; undo brings the frame back', () => {
    const cuts: string[][] = []
    const onCut = (e: Event) => cuts.push((e as CustomEvent<WireCutDetail>).detail.ids)
    canvasEvents.addEventListener(WIRES_CUT_EVENT, onCut)
    try {
      useUI.setState({ librarySelection: ['e'] })
      deleteLibrarySelection()
    } finally {
      canvasEvents.removeEventListener(WIRES_CUT_EVENT, onCut)
    }
    expect(String(confirm.mock.calls[0][0])).toContain('1 cảnh mất khung đầu / khung cuối')
    expect(sc('s3').firstFrame).toBeNull()
    expect(cuts).toEqual([[edgeId('first', 'e', 's3')]])
    undo()
    expect(sc('s3').firstFrame).toBe('e')
  })

  it('several items, some in use: one question for all of them', () => {
    useUI.setState({ librarySelection: ['d', 'b', 'c'] })
    deleteLibrarySelection()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(String(confirm.mock.calls[0][0])).toBe('Xoá 3 mục khỏi thư viện? 2 cảnh đang dùng các mục này sẽ giữ chữ đỏ và chưa chạy được cho tới khi bạn gắn nhân vật khác (Ctrl+Z để hoàn tác).')
    expect(assetIds()).toEqual(['a', 'e'])
    expect(history().pastStates).toHaveLength(1)
    expect(lastToast().text).toContain('Đã xoá 3 mục khỏi thư viện (2 mục đang dùng ở 2 cảnh)')
  })

  it('an item only linked (no prompt names its picture, no frame): at once, links gone in the same step, no question', () => {
    // s2 links Lumi without naming her; s1 does not link her at all
    const p = project()
    p.scenes = p.scenes.map((s) => (s.id === 's2' ? { ...s, prompt: 'waves' } : s.id === 's1' ? { ...s, refs: ['a', 'c'], prompt: '@image_1 @image_2 in @image_3' } : s))
    st().loadProject(p)
    history().clear()
    const before = st().project
    useUI.setState({ librarySelection: ['b'] })
    expect(deleteLibrarySelection()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(sc('s2').refs).toEqual([])
    expect(lastToast().text).toBe('Đã xoá “Lumi” khỏi thư viện và 1 cảnh.')
    expect(history().pastStates).toHaveLength(1)
    undo()
    expect(st().project).toBe(before)
  })

  it('the question waits for its answer in the app\'s dialog: nothing changes meanwhile; confirmed later, one step', () => {
    offConfirm() // nobody answers right away
    const before = st().project
    const closed = vi.fn()
    expect(deleteLibraryAssets(['b'], { onDeleted: closed })).toBe(false)
    const req = useConfirm.getState().request!
    expect(req).toMatchObject({ title: 'Xoá khỏi thư viện?', confirmLabel: 'Xoá', danger: true })
    expect(st().project).toBe(before)
    expect(closed).not.toHaveBeenCalled()
    answerConfirm(true)
    expect(assetIds()).not.toContain('b')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(history().pastStates).toHaveLength(1)
    // cancelled: nothing, and the dialog stays open
    useUI.setState({ librarySelection: ['a'] })
    expect(deleteLibrarySelection()).toBe(false)
    answerConfirm(false)
    expect(assetIds()).toContain('a')
    expect(history().pastStates).toHaveLength(1)
  })

  it('renumbering off: the other numbers stay as written, the deleted item\x27s own turn red, and the toast warns which scenes to fix', () => {
    st().updateProjectSettings({ autoRenumber: false })
    history().clear()
    useUI.setState({ librarySelection: ['a'] })
    deleteLibrarySelection()
    // GT1 (Q8b): only the removed pictures\x27 tokens become red placeholders; @image_3 / @image_4 are left as written
    expect(sc('s1').prompt).toBe('@image_?1(Elara) @image_?2(Elara · ảnh 2) with @image_3 in @image_4')
    expect(lastToast().tone).toBe('warning')
    expect(lastToast().text).toContain('tự đánh lại số đang tắt — hãy sửa số @image trong S01')
  })

  it('the prompt being typed in a scene using the item is committed first, and renumbered with the change', () => {
    const flush = vi.fn(() => st().updateScene('s1', { prompt: 'draft @image_4 near @image_3' }))
    const off = registerDraft('s1', flush)
    try {
      useUI.setState({ librarySelection: ['b'] })
      deleteLibrarySelection()
    } finally {
      off()
    }
    expect(flush).toHaveBeenCalledTimes(1)
    expect(sc('s1').prompt.startsWith('draft @image_3 ')).toBe(true)
    expect(resolvedKeys(sc('s1'))).toEqual(['c:i4'])
  })
})

describe('selections and what Delete takes', () => {
  it('only visible selected cards go; hidden ones stay selected and the toast says so', () => {
    visible = ['a', 'c', 'd'] // b and e hidden by the search / kind tab
    useUI.setState({ librarySelection: ['d', 'b'], selectedIds: ['d', 's4'] })
    deleteLibrarySelection()
    expect(confirm).not.toHaveBeenCalled()
    expect(assetIds()).toEqual(['a', 'b', 'c', 'e'])
    expect(useUI.getState().librarySelection).toEqual(['b'])
    // the canvas selection forgets the deleted id too (the canvas keeps unknown ids on its own)
    expect(useUI.getState().selectedIds).toEqual(['s4'])
    expect(lastToast().text).toContain('Giữ 1 mục đang chọn nhưng bị ẩn bởi ô tìm / thẻ lọc.')
  })

  it('nothing selected on screen: a hint (replaced, never stacked), no history step', () => {
    const before = st().project
    expect(deleteLibrarySelection()).toBe(false)
    expect(deleteLibrarySelection()).toBe(false)
    expect(toasts()).toHaveLength(1)
    expect(lastToast().text).toContain('Chưa chọn thẻ nào trong Thư viện')
    expect(st().project).toBe(before)
    expect(history().pastStates).toHaveLength(0)
    // every selected card hidden
    visible = ['a']
    useUI.setState({ librarySelection: ['b'] })
    expect(deleteLibrarySelection()).toBe(false)
    expect(toasts()).toHaveLength(1)
    expect(lastToast().text).toContain('đang bị ẩn bởi ô tìm / thẻ lọc')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('library collapsed: nothing deleted or selected, but a hint says why (one toast, replaced, never silent)', () => {
    useUI.setState({ librarySelection: ['d'] })
    collapsed = true
    expect(deleteLibrarySelection()).toBe(false)
    expect(toasts().map((t) => t.text)).toEqual(['Thư viện đang thu gọn — mở Thư viện để xoá các thẻ đã chọn, hoặc bấm vào canvas để xoá trên canvas.'])
    expect(selectAllInLibrary()).toBe(false)
    expect(toasts().map((t) => t.text)).toEqual(['Thư viện đang thu gọn — mở Thư viện để chọn thẻ, hoặc bấm vào canvas để chọn mọi cảnh.'])
    expect(assetIds()).toContain('d')
    expect(useUI.getState().librarySelection).toEqual(['d'])
    expect(history().pastStates).toHaveLength(0)
  })

  it('library not mounted: nothing at all', () => {
    useUI.setState({ librarySelection: ['d'] })
    unregister()
    expect(deleteLibrarySelection()).toBe(false)
    expect(selectAllInLibrary()).toBe(false)
    expect(assetIds()).toContain('d')
    expect(toasts()).toHaveLength(0)
  })

  it('Ctrl+A selects every visible card', () => {
    visible = ['c', 'a']
    useUI.setState({ librarySelection: ['b'] })
    expect(selectAllInLibrary()).toBe(true)
    expect(useUI.getState().librarySelection).toEqual(['c', 'a'])
  })

  it('the asset dialog uses the same rule: an unused item at once, one in use after the question', () => {
    expect(deleteLibraryAssets(['d'])).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockReturnValue(false)
    expect(deleteLibraryAssets(['b'])).toBe(false)
    expect(assetIds()).toContain('b')
    expect(deleteLibraryAssets(['ghost'])).toBe(false)
  })

  it('a queued take still sends the pictures of its snapshot after the item is deleted', () => {
    useUI.setState({ librarySelection: ['b'] })
    deleteLibrarySelection()
    const sent = requestImages({ refsSnapshot: ['a', 'b'], imageKeysSnapshot: ['a:i1', 'a:i2', 'b:i3'] }, st().project.assets, 9)
    expect(sent.map((x) => `${x.assetId}:${x.imageId}`)).toEqual(['a:i1', 'a:i2', 'b:i3'])
  })
})

describe('where the delete keys act', () => {
  it('nothing without a mounted library; focus inside the library always counts', () => {
    unregister()
    expect(isLibraryKeyTarget(el('.sb-library') as unknown as EventTarget)).toBe(false)
    unregister = registerLibraryView({ visibleIds: () => visible, collapsed: () => false })
    expect(isLibraryKeyTarget(el('.sb-library') as unknown as EventTarget)).toBe(true)
    expect(isLibraryKeyTarget(el(null, 'BUTTON') as unknown as EventTarget)).toBe(false)
  })

  it('focus on the page itself follows the last click: library → library, anywhere else → canvas (default: canvas)', () => {
    const body = BODY as unknown as EventTarget
    expect(libraryArea()).toBeNull()
    expect(isLibraryKeyTarget(body)).toBe(false)
    expect(isLibraryKeyTarget(null)).toBe(false)
    noteLibraryPointer(el('.sb-library') as unknown as EventTarget)
    expect(isLibraryKeyTarget(body)).toBe(true)
    expect(isLibraryKeyTarget(null)).toBe(true)
    noteLibraryPointer(el(null) as unknown as EventTarget)
    expect(libraryArea()).toBe('app')
    expect(isLibraryKeyTarget(body)).toBe(false)
  })

  it('a click on a toast (Hoàn tác) or in a dialog does not move the area', () => {
    noteLibraryPointer(el('.sb-library') as unknown as EventTarget)
    noteLibraryPointer(el('.toasts', 'BUTTON') as unknown as EventTarget)
    noteLibraryPointer(el('.modal-backdrop') as unknown as EventTarget)
    expect(libraryArea()).toBe('library')
    expect(isLibraryKeyTarget(el('.toasts', 'BUTTON') as unknown as EventTarget)).toBe(true)
  })

  it('a click outside takes the focus away from a library card that kept it (no stale focus)', () => {
    const card = el('.sb-library')
    vi.stubGlobal('document', { activeElement: card })
    noteLibraryPointer(card as unknown as EventTarget)
    noteLibraryPointer(el(null) as unknown as EventTarget)
    expect(card.blur).toHaveBeenCalledTimes(1)
    // focus elsewhere is left alone
    const field = el(null, 'TEXTAREA')
    vi.stubGlobal('document', { activeElement: field })
    noteLibraryPointer(el(null) as unknown as EventTarget)
    expect(field.blur).not.toHaveBeenCalled()
  })

  it('click a card, drag it onto a scene, press Delete: the canvas gets the key, the library keeps its items', () => {
    const card = el('.sb-library')
    vi.stubGlobal('document', { activeElement: card })
    noteLibraryPointer(card as unknown as EventTarget)
    useUI.setState({ librarySelection: ['b'] })
    // the drop (HTML5: no pointerdown there, the focus stays on the dragged card)
    noteAssetDropOutside()
    expect(card.blur).toHaveBeenCalledTimes(1)
    expect(libraryArea()).toBe('app')
    expect(isLibraryKeyTarget(BODY as unknown as EventTarget)).toBe(false)
    expect(assetIds()).toContain('b')
  })

  it('a card drag that ends on a drop target outside the library (dropEffect ≠ none): canvas keys, used group cleared', () => {
    const card = el('.sb-library')
    vi.stubGlobal('document', { activeElement: card })
    noteLibraryPointer(card as unknown as EventTarget)
    useUI.setState({ librarySelection: ['b', 'c'], draggingAssetIds: ['b', 'c'] })
    assetDragEnded('copy')
    expect(useUI.getState().draggingAssetIds).toBeNull()
    expect(libraryArea()).toBe('app')
    expect(card.blur).toHaveBeenCalledTimes(1)
    expect(useUI.getState().librarySelection).toEqual([])
    // a single dragged card stays selected (only a multi-card group is "used up")
    noteLibraryPointer(card as unknown as EventTarget)
    useUI.setState({ librarySelection: ['b'], draggingAssetIds: ['b'] })
    assetDragEnded('link')
    expect(libraryArea()).toBe('app')
    expect(useUI.getState().librarySelection).toEqual(['b'])
  })

  it('a card drag dropped nowhere or back on the library (dropEffect none): the library keeps the keys and the group', () => {
    const card = el('.sb-library')
    vi.stubGlobal('document', { activeElement: card })
    noteLibraryPointer(card as unknown as EventTarget)
    useUI.setState({ librarySelection: ['b', 'c'], draggingAssetIds: ['b', 'c'] })
    assetDragEnded('none')
    expect(useUI.getState().draggingAssetIds).toBeNull()
    expect(libraryArea()).toBe('library')
    expect(card.blur).not.toHaveBeenCalled()
    expect(useUI.getState().librarySelection).toEqual(['b', 'c'])
  })

  it('unmounting the library forgets the area', () => {
    noteLibraryPointer(el('.sb-library') as unknown as EventTarget)
    unregister()
    expect(libraryArea()).toBeNull()
  })
})

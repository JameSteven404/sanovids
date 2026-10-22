// The right-click menus per target, built from the real stores: ids / order / limits of each menu, the quick-unlink
// wording, shortcut columns only where the key does the same thing, the delete questions (a video delete always asks),
// and source guards (no handler on the node components, one host, a portal with role="menu").
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTake, edgeId, PARKED_RETRY_TEXT, rerunTake } from '../../../actions'
import type { Asset, Project, Scene, Take } from '../../../core/types'
import { useCanvasPrefs } from '../../../lib/canvasPrefs'
import { bareState, useDevAccess } from '../../../providers/devAccess'
import { useProject } from '../../../store/project'
import { useRuns } from '../../../store/runs'
import { useSceneEditor } from '../../../store/sceneEditor'
import { useUI } from '../../../store/ui'
import { canvasMenu, deleteTakeAsking, wireStack, type CanvasTarget } from '../canvasMenu'
import { useContextMenu } from '../contextMenuStore'
import { openLibraryCardMenu } from '../libraryContextMenu'
import { libraryMenu } from '../libraryMenu'
import { firstIndex, isItem, MAX_ROOT_ITEMS, type MenuEntry, type MenuItem, type MenuSpec } from '../menuModel'

const SD = { model: 'seedance_2_5', mode: 'i2v', duration: 5, resolution: '480p', ratio: '16:9' } as const
const scene = (id: string, order: number, over: Partial<Scene> = {}): Scene => ({
  id,
  order,
  title: '',
  prompt: 'Một cảnh',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { ...SD },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 420, y: order * 400 },
  note: '',
  ...over,
})
const asset = (id: string, name: string, over: Partial<Asset> = {}): Asset => ({
  id,
  kind: 'character',
  name,
  tag: name,
  description: '',
  imageIds: ['img_' + id],
  color: '#fff',
  position: { x: 0, y: 0 },
  ...over,
})
const take = (id: string, sceneId: string, over: Partial<Take> = {}): Take => ({
  id,
  sceneId,
  number: 1,
  status: 'completed',
  progress: 100,
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
  promptSnapshot: '',
  rawPromptSnapshot: '',
  refsSnapshot: [],
  videoRefsSnapshot: [],
  settings: { ...SD },
  cost: 1,
  starred: false,
  posterId: null,
  videoId: null,
  error: null,
  position: null,
  ...over,
})
const big = asset('big', 'Big', { imageIds: Array.from({ length: 30 }, (_, i) => `img_big${i}`) })
const project = (): Project => ({
  id: 'p1',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber: true },
  assets: [asset('a', 'Elara'), asset('b', 'Bran', { imageIds: ['i1', 'i2', 'i3'] }), asset('n', 'Nobody', { imageIds: [] }), big],
  scenes: [
    scene('s1', 1, { refs: ['a'], prompt: '@image_1 đi' }),
    scene('s2', 2, { firstFrame: 'a' }),
    scene('s3', 3, { refs: ['big'] }),
    scene('s4', 4),
  ],
  folders: [{ id: 'f1', name: 'Phim', path: 'D:\\Phim', position: { x: 0, y: 0 }, mode: 'copy', takes: ['t9'] }],
})

const storage = new Map<string, string>()
let confirmAnswer = true
const asked: string[] = []
beforeEach(() => {
  storage.clear()
  asked.length = 0
  confirmAnswer = true
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) })
  vi.stubGlobal('window', {
    confirm: (q: string) => {
      asked.push(q)
      return confirmAnswer
    },
  })
  useProject.getState().loadProject(project())
  useProject.temporal.getState().clear()
  useRuns.setState({ takes: [] })
  useUI.setState({ selectedIds: [], selectedEdgeIds: [], librarySelection: [], view: 'canvas', toasts: [], dialog: { kind: 'none' } })
})
afterEach(() => {
  useSceneEditor.getState().close()
  useCanvasPrefs.setState({ nodeEditor: 'click' })
  useRuns.setState({ takes: [] })
  vi.unstubAllGlobals()
})

const ctx = { flow: { x: 100, y: 100 }, at: { x: 10, y: 10 } }
const open = (target: CanvasTarget, selectedIds: string[] = [], selectedEdgeIds: string[] = []): MenuSpec => {
  useUI.setState({ selectedIds, selectedEdgeIds })
  const spec = canvasMenu(target, ctx)
  expect(spec).not.toBeNull()
  return spec!
}
const items = (spec: MenuSpec | MenuEntry[]): MenuItem[] => (Array.isArray(spec) ? spec : spec.entries).filter(isItem)
const ids = (spec: MenuSpec) => items(spec).map((i) => i.id)
const get = (spec: MenuSpec, id: string) => items(spec).find((i) => i.id === id)!

/** Rules every menu follows: ≤ 7 root items, ≤ 1 submenu level, danger last after a separator, no retired words. */
function checkRules(spec: MenuSpec) {
  const root = items(spec)
  expect(root.length).toBeLessThanOrEqual(MAX_ROOT_ITEMS)
  for (const it of root) for (const sub of items(it.submenu ?? [])) expect(sub.submenu).toBeUndefined()
  const e = spec.entries
  const dangerAt = e.findIndex((x) => isItem(x) && x.danger)
  if (dangerAt >= 0) {
    expect(e[dangerAt - 1]?.type).toBe('separator')
    expect(e.slice(dangerAt).every((x) => isItem(x) && x.danger)).toBe(true)
    const first = e[firstIndex(e)]
    expect(!!(isItem(first) && first.danger && root.length > 1)).toBe(false)
  }
  const all = [...root, ...root.flatMap((i) => items(i.submenu ?? []))]
  for (const it of all) expect(`${it.label} ${it.hint ?? ''} ${spec.title ?? ''}`).not.toMatch(/Ctrl|⌘|Shift\+|@video|video tham chiếu|Phát triển|DEV/)
}

describe('scene card menu', () => {
  it('7 items in order, delete last (danger), shortcut columns from the keymap', () => {
    useRuns.setState({ takes: [take('t1', 's1')] })
    const spec = open({ kind: 'scene', id: 's1' }, ['s1'])
    checkRules(spec)
    expect(ids(spec)).toEqual(['scene.run', 'scene.edit', 'scene.next', 'scene.duplicate', 'scene.playFrom', 'scene.unlink', 'scene.delete'])
    expect(spec.title).toBeUndefined()
    expect(get(spec, 'scene.run').label).toMatch(/^Chạy S01/)
    expect(get(spec, 'scene.run').action).toBe('scene.run')
    expect(get(spec, 'scene.edit').fixedKey).toBe('Enter')
    expect(get(spec, 'scene.duplicate').action).toBe('selection.duplicate')
    expect(get(spec, 'scene.delete')).toMatchObject({ danger: true, action: 'selection.delete' })
    expect(get(spec, 'scene.playFrom').disabled).toBeUndefined()
  })
  it('"Bỏ nối ảnh ▸" lists images and frames, wires highlighted; hidden when nothing is linked', () => {
    useProject.getState().loadProject({ ...project(), scenes: [scene('s1', 1, { refs: ['a', 'b'], lastFrame: 'a' })] })
    const spec = open({ kind: 'scene', id: 's1' }, ['s1'])
    const sub = items(get(spec, 'scene.unlink').submenu!)
    expect(sub.map((i) => i.label)).toEqual(['Elara · @image_1', 'Bran · @image_2…4', 'Khung cuối · Elara', 'Bỏ nối tất cả (3)'])
    expect(sub[0].edgeId).toBe(edgeId('ref', 'a', 's1'))
    expect(ids(open({ kind: 'scene', id: 's1' }, ['s1'])).includes('scene.unlink')).toBe(true)
    useProject.getState().loadProject(project())
    expect(ids(open({ kind: 'scene', id: 's4' }, ['s4']))).not.toContain('scene.unlink')
    expect(get(open({ kind: 'scene', id: 's4' }, ['s4']), 'scene.playFrom').disabled).toMatch(/Chưa có cảnh nào có video xong/)
  })
  it('"Sửa prompt và cấu hình" = Enter: types in the card prompt, caret at the end', () => {
    get(open({ kind: 'scene', id: 's1' }, ['s1']), 'scene.edit').run!()
    expect(useSceneEditor.getState()).toMatchObject({ sceneId: 's1', focus: 'prompt', caret: '@image_1 đi'.length })
  })
  it('node editor off: no Enter shown, the prompt opens in the right panel (the card editor stays closed)', () => {
    useCanvasPrefs.setState({ nodeEditor: 'off' })
    useUI.setState({ rightOpen: false })
    const edit = get(open({ kind: 'scene', id: 's1' }, ['s1', 's2']), 'scene.edit')
    expect(edit.fixedKey).toBeUndefined()
    edit.run!()
    expect(useUI.getState()).toMatchObject({ rightOpen: true, selectedIds: ['s1'] })
    expect(useSceneEditor.getState().sceneId).toBeNull()
  })
  it('gateway blocked: "Chạy" stays clickable for that, but not when the scene itself cannot run', () => {
    const access = useDevAccess.getState().state
    useDevAccess.setState({ state: bareState('locked') })
    try {
      useProject.getState().loadProject({ ...project(), scenes: [scene('s1', 1, { refs: ['a'], prompt: '@image_1 đi' }), scene('s2', 2, { prompt: '' })] })
      const ok = get(open({ kind: 'scene', id: 's1' }, ['s1']), 'scene.run')
      expect(ok.hint).toBeTruthy()
      expect(ok.disabled).toBeUndefined()
      const bad = get(open({ kind: 'scene', id: 's2' }, ['s2']), 'scene.run')
      expect(bad.hint).toBeTruthy()
      expect(bad.disabled).toBeTruthy()
    } finally {
      useDevAccess.setState({ state: access })
    }
  })
})

describe('image card menu: quick unlink with scenes selected', () => {
  it('one selected scene using it → first item "Bỏ nối Elara khỏi S01", focused when the menu opens', () => {
    const spec = open({ kind: 'asset', id: 'a' }, ['s1'])
    checkRules(spec)
    expect(spec.entries[firstIndex(spec.entries)]).toMatchObject({ id: 'asset.unlinkSelected', label: 'Bỏ nối Elara khỏi S01' })
    expect(spec.title).toBeUndefined()
  })
  it('several selected scenes (a first frame counts) → "… khỏi 2 cảnh đang chọn"; the rest offered as link', () => {
    const spec = open({ kind: 'asset', id: 'a' }, ['s1', 's2', 's4'])
    expect(get(spec, 'asset.unlinkSelected').label).toBe('Bỏ nối Elara khỏi 2 cảnh đang chọn')
    expect(get(spec, 'asset.linkSelected').label).toBe('Nối Elara vào S04 → @image_1')
  })
  it('link wording: several images → number range, no picture → no number, full scene → disabled with the limit', () => {
    expect(get(open({ kind: 'asset', id: 'b' }, ['s1']), 'asset.linkSelected').label).toBe('Nối Bran vào S01 → @image_2…4')
    expect(get(open({ kind: 'asset', id: 'n' }, ['s1']), 'asset.linkSelected').label).toBe('Nối Nobody vào S01 (chưa có ảnh nên chưa có số)')
    expect(get(open({ kind: 'asset', id: 'a' }, ['s3']), 'asset.linkSelected').disabled).toBe('Vượt giới hạn ảnh của Seedance 2.5 (30/30)')
  })
  it('scenes not selected that use it → "Bỏ nối khỏi cảnh khác ▸" + "Bỏ nối khỏi mọi cảnh (n)"', () => {
    const spec = open({ kind: 'asset', id: 'a' }, ['s1'])
    const sub = items(get(spec, 'asset.unlinkFrom').submenu!)
    expect(get(spec, 'asset.unlinkFrom').label).toBe('Bỏ nối khỏi cảnh khác')
    expect(sub.map((i) => i.label)).toEqual(['S02 (khung đầu)', 'Bỏ nối khỏi mọi cảnh (2)'])
  })
  it('without selected scenes: a title names the image, "Ẩn khỏi canvas" last (not dangerous), no unlink-selected', () => {
    const spec = open({ kind: 'asset', id: 'a' })
    checkRules(spec)
    expect(spec.title).toBe('Elara · nhân vật · dùng ở 2 cảnh')
    expect(ids(spec)).toEqual(['asset.unlinkFrom', 'asset.newScene', 'asset.edit', 'asset.hide'])
    expect(get(spec, 'asset.hide').danger).toBeFalsy()
    expect(get(spec, 'asset.hide').action).toBeUndefined()
    expect(get(open({ kind: 'asset', id: 'a' }, ['a']), 'asset.hide').action).toBe('selection.delete')
  })
  it('running the first item cuts the image off the selected scenes (one undo step)', () => {
    const spec = open({ kind: 'asset', id: 'a' }, ['s1', 's2'])
    const before = useProject.temporal.getState().pastStates.length
    get(spec, 'asset.unlinkSelected').run!()
    const p = useProject.getState().project
    expect(p.scenes.find((s) => s.id === 's1')!.refs).toEqual([])
    expect(p.scenes.find((s) => s.id === 's2')!.firstFrame).toBeNull()
    expect(useProject.temporal.getState().pastStates.length).toBe(before + 1)
  })
})

describe('thumbnail on a scene card', () => {
  it('"Bỏ nối {tên} khỏi {S}" first; with several selected scenes using it, the quick unlink rows', () => {
    const spec = open({ kind: 'ref', assetId: 'a', sceneId: 's1' }, ['s1', 's2'])
    checkRules(spec)
    expect(ids(spec)).toEqual(['ref.unlink', 'ref.unlinkSelected', 'ref.edit'])
    expect(get(spec, 'ref.unlink').label).toBe('Bỏ nối Elara khỏi S01')
    expect(get(spec, 'ref.unlinkSelected').label).toBe('Bỏ nối Elara khỏi 2 cảnh đang chọn')
    const alone = open({ kind: 'ref', assetId: 'a', sceneId: 's1' }, ['s1'])
    expect(ids(alone)).toEqual(['ref.unlink', 'ref.unlinkAll', 'ref.edit'])
  })
})

describe('video menus', () => {
  it('finished: 7 items, "Tạo cảnh tiếp theo từ video này", up to 3 folders, delete asks always', () => {
    useRuns.setState({ takes: [take('t1', 's1', { starred: true })] })
    const spec = open({ kind: 'take', id: 't1' }, ['t1'])
    checkRules(spec)
    expect(ids(spec)).toEqual(['take.view', 'take.star', 'take.nextScene', 'take.download', 'take.save', 'take.rerun', 'take.delete'])
    expect(spec.title).toBe('S01·T1 · 5s · 480p')
    expect(get(spec, 'take.star')).toMatchObject({ label: 'Chọn take này cho S01', checked: true })
    expect(get(spec, 'take.delete')).toMatchObject({ label: 'Xoá video…', danger: true, hint: 'Không hoàn tác được' })
    expect(items(get(spec, 'take.save').submenu!).map((i) => i.label)).toEqual(['“Phim”', 'Thư mục mới…'])
  })
  it('queued and not sent: "Huỷ" (not charged), no delete, no question', () => {
    useRuns.setState({ takes: [take('t1', 's1', { provider: 'dev', status: 'queued', progress: 0 })] })
    const spec = open({ kind: 'take', id: 't1' }, ['t1'])
    expect(ids(spec)).toEqual(['take.view', 'take.cancel'])
    expect(get(spec, 'take.cancel')).toMatchObject({ label: 'Huỷ', hint: 'Chưa gửi đi, không trừ credit' })
    get(spec, 'take.cancel').run!()
    expect(asked).toEqual([])
    expect(useRuns.getState().takes[0].status).toBe('cancelled')
  })
  it.each([
    ['sent (remote id)', { status: 'processing', remoteId: 'r1' }, 'Job đã gửi sang canvasapp giả lập vẫn chạy ở đó', /^Đã huỷ S01·T1 trong SanoVids — job đã gửi sang canvasapp giả lập vẫn chạy ở đó/],
    ['earlier send unknown', { status: 'queued', submitUnknown: true }, 'Không rõ lần gửi trước đã trừ credit dev chưa', /^Đã huỷ S01·T1\.$/],
    ['being sent (no remote id yet)', { status: 'processing' }, 'Đang gửi sang canvasapp giả lập', /^Đã huỷ S01·T1 lúc đang gửi sang canvasapp giả lập/],
  ] as const)('%s: the same "Huỷ" as the queue row / TakeViewer (actions.cancelTake): no extra question, the toast says what it means', (_name, over, hint, said) => {
    const access = useDevAccess.getState().state
    useDevAccess.setState({ state: bareState('unlocked') })
    try {
      useRuns.setState({ takes: [take('t1', 's1', { provider: 'dev', progress: 10, ...over })] })
      const cancel = get(open({ kind: 'take', id: 't1' }, ['t1']), 'take.cancel')
      expect(cancel).toMatchObject({ label: 'Huỷ', hint })
      confirmAnswer = false
      cancel.run!()
      expect(asked).toEqual([])
      expect(useRuns.getState().takes[0].status).toBe('cancelled')
      expect(useUI.getState().toasts.at(-1)?.text).toMatch(said)
      // Exactly what cancelTake itself does from the queue row: nothing more asked there either.
      useRuns.setState({ takes: [take('t1', 's1', { provider: 'dev', progress: 10, ...over })] })
      expect(cancelTake('t1')).toBe(true)
      expect(asked).toEqual([])
    } finally {
      useDevAccess.setState({ state: access })
    }
  })
  it('failed: "Xem lỗi", run again, delete; parked (newer SanoVids): only view + delete', () => {
    useRuns.setState({ takes: [take('t1', 's1', { status: 'failed' }), take('t2', 's1', { number: 2, status: 'processing', foreignStatus: 'processing' })] })
    const failed = open({ kind: 'take', id: 't1' }, ['t1'])
    checkRules(failed)
    expect(ids(failed)).toEqual(['take.view', 'take.rerun', 'take.delete'])
    expect(get(failed, 'take.view').label).toBe('Xem lỗi')
    const parked = open({ kind: 'take', id: 't2' }, ['t2'])
    expect(ids(parked)).toEqual(['take.view', 'take.delete'])
    expect(parked.title).toBe('S01·T2 · đang chạy ở bản SanoVids mới hơn')
  })
  it('a parked video (newer SanoVids) asks the shared question once, the same one the Delete key asks', () => {
    useRuns.setState({ takes: [take('t2', 's1', { number: 2, status: 'failed', foreignStatus: 'processing' })] })
    confirmAnswer = false
    expect(deleteTakeAsking('t2')).toBe(false)
    expect(asked).toEqual(['Xoá vĩnh viễn S01·T2? Video đã xoá không hoàn tác được.\nS01·T2 có thể vẫn đang chạy (và tính credit) ở bản SanoVids mới hơn: xoá ở đây không huỷ job đó.'])
    expect(useRuns.getState().takes).toHaveLength(1)
  })
  it('"Chạy lại" of a parked video (node / viewer / queue / tray buttons) is refused centrally: no question, no cost dialog', () => {
    useRuns.setState({ takes: [take('t2', 's1', { number: 2, status: 'failed', foreignStatus: 'processing' })] })
    rerunTake('t2')
    expect(asked).toEqual([])
    expect(useUI.getState().dialog).toEqual({ kind: 'none' })
    expect(useUI.getState().toasts.at(-1)?.text).toBe(PARKED_RETRY_TEXT)
  })
  it('deleting a video from the menu ALWAYS asks first (failed too); Cancel keeps it', () => {
    useRuns.setState({ takes: [take('t1', 's1', { status: 'failed' }), take('t2', 's1', { number: 2 })] })
    confirmAnswer = false
    expect(deleteTakeAsking('t1')).toBe(false)
    expect(asked).toEqual(['Xoá vĩnh viễn S01·T1? Video đã xoá không hoàn tác được.'])
    expect(useRuns.getState().takes.map((t) => t.id)).toEqual(['t1', 't2'])
    confirmAnswer = true
    expect(deleteTakeAsking('t2')).toBe(true)
    expect(asked).toHaveLength(2)
    expect(useRuns.getState().takes.map((t) => t.id)).toEqual(['t1'])
  })
  it('a "maybe billed" video: the menu asks the credit question of the Delete key once (actions.deleteFacts), never a second one', () => {
    useRuns.setState({ takes: [take('t1', 's1', { provider: 'dev', status: 'cancelled', submitUnknown: true })] })
    confirmAnswer = true
    expect(deleteTakeAsking('t1')).toBe(true)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/^Xoá vĩnh viễn S01·T1\? Video đã xoá không hoàn tác được\.\nS01·T1: không rõ canvasapp giả lập đã nhận/)
    // Same through the several-cards delete (deleteSelection asks it; the menu adds nothing).
    useRuns.setState({ takes: [take('t2', 's4', { provider: 'dev', status: 'failed', submitUnknown: true })] })
    asked.length = 0
    confirmAnswer = false
    get(open({ kind: 'multi' }, ['s1', 't2']), 'multi.delete').run!()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('không rõ canvasapp giả lập đã nhận')
  })
})

describe('several cards', () => {
  it('title counts, run / connect / unlink / duplicate, delete summary last', () => {
    const spec = open({ kind: 'multi' }, ['s1', 's4', 'a'])
    checkRules(spec)
    expect(spec.title).toBe('3 mục đang chọn · 2 cảnh, 1 ảnh')
    expect(ids(spec)).toEqual(['multi.run', 'multi.connect', 'multi.unlink', 'multi.duplicate', 'multi.delete'])
    expect(get(spec, 'multi.connect').label).toBe('Nối 1 ảnh vào 2 cảnh')
    expect(get(spec, 'multi.unlink').label).toBe('Bỏ nối 1 ảnh khỏi 1 cảnh')
    expect(get(spec, 'multi.delete').label).toBe('Xoá 2 cảnh, ẩn 1 thẻ ảnh')
  })
  it('a video in the group: delete asks first even when none is finished; disabled while one runs', () => {
    useRuns.setState({ takes: [take('t1', 's4', { status: 'failed' }), take('t2', 's1', { number: 1, status: 'processing' })] })
    const spec = open({ kind: 'multi' }, ['s1', 't1'])
    expect(get(spec, 'multi.delete').label).toBe('Xoá 1 cảnh, 1 video…')
    confirmAnswer = false
    get(spec, 'multi.delete').run!()
    expect(asked).toEqual(['Xoá vĩnh viễn S04·T1? Video đã xoá không hoàn tác được.'])
    expect(useProject.getState().project.scenes.some((s) => s.id === 's1')).toBe(true)
    expect(useRuns.getState().takes.some((t) => t.id === 't1')).toBe(true)
    const running = open({ kind: 'multi' }, ['s4', 't2'])
    expect(get(running, 'multi.delete').disabled).toBe('Có video đang chờ / đang tạo — huỷ chúng trước')
  })
})

describe('folder, wires, empty canvas', () => {
  it('folder: save the selected videos / scenes into it; remove last', () => {
    useRuns.setState({ takes: [take('t1', 's1'), take('t9', 's2')] })
    const spec = open({ kind: 'folder', id: 'f1' }, ['t1', 't9', 's2'])
    checkRules(spec)
    expect(spec.title).toBe('Thư mục “Phim”')
    expect(get(spec, 'folder.saveSelected').label).toBe('Lưu 1 video đang chọn vào đây')
    expect(get(spec, 'folder.autosaveSelected').label).toBe('Tự lưu 1 cảnh đang chọn vào đây')
    expect(ids(spec).at(-1)).toBe('folder.remove')
  })
  it('wireStack keeps cuttable wires once, top first', () => {
    expect(wireStack(['out:s1->t1', 'ref:a->s1', 'ref:a->s1', 'junk', 'save:t1->f1'])).toEqual(['ref:a->s1', 'save:t1->f1'])
  })
  it('one wire: "Bỏ nối Elara → S01" + go to both ends; several: links, separator, saves', () => {
    useRuns.setState({ takes: [take('t1', 's1')] })
    const one = open({ kind: 'edges', ids: [edgeId('ref', 'a', 's1')] })
    checkRules(one)
    expect(ids(one)).toEqual(['edge.cut', 'edge.goScene', 'edge.goSource'])
    expect(get(one, 'edge.cut').label).toBe('Bỏ nối Elara → S01')
    expect(get(one, 'edge.goSource').label).toBe('Đi tới Elara')
    const many = open({ kind: 'edges', ids: [edgeId('save', 't1', 'f1'), edgeId('first', 'a', 's2'), edgeId('autosave', 's1', 'f1')] })
    checkRules(many)
    expect(many.title).toBe('3 dây ở chỗ này')
    expect(many.entries.map((e) => (isItem(e) ? e.label.split(' ')[0] + ' ' + e.label.split(' ')[1] : e.type))).toEqual([
      'Bỏ nối',
      'separator',
      expect.stringMatching(/^Bỏ (lưu|tự)/),
      expect.stringMatching(/^Bỏ (lưu|tự)/),
    ])
  })
  it('20 wires under the pointer: every one listed (the menu scrolls), none cut off', () => {
    const many = Array.from({ length: 20 }, (_, i) => scene(`m${i}`, i + 1, { refs: ['a'] }))
    useProject.getState().loadProject({ ...project(), scenes: many })
    const w = many.map((sc) => edgeId('ref', 'a', sc.id))
    const spec = open({ kind: 'edges', ids: [...w, edgeId('save', 't9', 'f1')] })
    expect(items(spec)).toHaveLength(21)
    expect(items(spec).map((i) => i.edgeId)).toEqual([...w, edgeId('save', 't9', 'f1')])
  })
  it('several selected wires (no card selected): "Bỏ nối 2 dây đang chọn" with the Delete key', () => {
    const w = [edgeId('ref', 'a', 's1'), edgeId('first', 'a', 's2')]
    const spec = open({ kind: 'edges', ids: [w[0]] }, [], w)
    expect(get(spec, 'edge.cutSelected')).toMatchObject({ label: 'Bỏ nối 2 dây đang chọn', action: 'selection.delete' })
    expect(ids(open({ kind: 'edges', ids: [w[0]] }, ['s1'], w))).not.toContain('edge.cutSelected')
  })
  it('empty canvas: new scene / folder / images here, fit (same key, wording follows the selection)', () => {
    const spec = open({ kind: 'pane' })
    checkRules(spec)
    expect(ids(spec)).toEqual(['pane.newScene', 'pane.newFolder', 'pane.addImages', 'pane.fit'])
    expect(get(spec, 'pane.fit')).toMatchObject({ label: 'Vừa màn hình', action: 'canvas.fit' })
    expect(get(open({ kind: 'pane' }, ['s1', 's2']), 'pane.fit')).toMatchObject({ label: 'Phóng tới 2 mục đang chọn', action: 'canvas.fit' })
  })
  it('"Cảnh mới tại đây" = double-click: the new scene is selected and its card prompt open (none with the node editor off)', () => {
    get(open({ kind: 'pane' }), 'pane.newScene').run!()
    const made = useProject.getState().project.scenes.at(-1)!.id
    expect(useUI.getState().selectedIds).toEqual([made])
    expect(useSceneEditor.getState()).toMatchObject({ sceneId: made, focus: 'prompt', caret: 0 })
    useSceneEditor.getState().close()
    useCanvasPrefs.setState({ nodeEditor: 'off' })
    get(open({ kind: 'pane' }), 'pane.newScene').run!()
    expect(useProject.getState().project.scenes).toHaveLength(6)
    expect(useSceneEditor.getState().sceneId).toBeNull()
  })
})

describe('library card menu', () => {
  const commands = { toggleOnCanvas: vi.fn() }
  it('one card with a selected scene: quick unlink first, "Ẩn khỏi canvas", delete last', () => {
    useUI.setState({ selectedIds: ['s1'] })
    const spec = libraryMenu(['a'], commands)!
    checkRules(spec)
    expect(ids(spec)).toEqual(['lib.unlinkSelected', 'lib.unlinkAll', 'lib.canvas', 'lib.edit', 'lib.delete'])
    expect(get(spec, 'lib.unlinkSelected').label).toBe('Bỏ nối Elara khỏi S01')
    expect(get(spec, 'lib.canvas').label).toBe('Ẩn khỏi canvas')
    expect(get(spec, 'lib.delete').danger).toBe(true)
  })
  it('"Bỏ nối {tên} khỏi mọi cảnh (n)": cuts every scene using it (one undo step); absent when that is just the selection', () => {
    useUI.setState({ selectedIds: ['s1'] })
    const all = get(libraryMenu(['a'], commands)!, 'lib.unlinkAll')
    expect(all.label).toBe('Bỏ nối Elara khỏi mọi cảnh (2)')
    const before = useProject.temporal.getState().pastStates.length
    all.run!()
    const p = useProject.getState().project
    expect(p.scenes.find((s) => s.id === 's1')!.refs).toEqual([])
    expect(p.scenes.find((s) => s.id === 's2')!.firstFrame).toBeNull()
    expect(useProject.temporal.getState().pastStates.length).toBe(before + 1)
    useProject.getState().loadProject(project())
    useUI.setState({ selectedIds: ['s1', 's2'] })
    expect(ids(libraryMenu(['a'], commands)!)).not.toContain('lib.unlinkAll')
  })
  it('a card not linked to the selected scene offers the link with C', () => {
    useUI.setState({ selectedIds: ['s4'] })
    const spec = libraryMenu(['a'], commands)!
    expect(get(spec, 'lib.linkSelected')).toMatchObject({ label: 'Nối Elara vào S04 → @image_1', action: 'selection.connect' })
  })
  it('several cards: title, link / unlink with the selected scenes, delete all', () => {
    useUI.setState({ selectedIds: ['s1'] })
    const spec = libraryMenu(['a', 'b'], commands)!
    checkRules(spec)
    expect(spec.title).toBe('2 mục đang chọn')
    expect(ids(spec)).toEqual(['lib.linkSelected', 'lib.unlinkSelected', 'lib.delete'])
    expect(get(spec, 'lib.delete').label).toBe('Xoá 2 mục khỏi thư viện')
  })
  it('the card opener stops the native menu and selects the card at once; the menu opens once its builder is loaded', async () => {
    useUI.setState({ selectedIds: ['s1'], librarySelection: [] })
    const e = { defaultPrevented: false, preventDefault: vi.fn(), target: null, clientX: 5, clientY: 6 }
    openLibraryCardMenu(e as unknown as Parameters<typeof openLibraryCardMenu>[0], 'a', commands)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(useUI.getState().librarySelection).toEqual(['a'])
    await vi.dynamicImportSettled()
    expect(useContextMenu.getState().open).toMatchObject({ at: { x: 5, y: 6 }, spec: { label: libraryMenu(['a'], commands)!.label } })
    useContextMenu.setState({ open: null })
  })
})

describe('source guards', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  it('no node component has its own onContextMenu (one delegated handler on the stage)', () => {
    for (const f of ['SceneNode.tsx', 'TakeNode.tsx', 'AssetNode.tsx', 'FolderNode.tsx']) expect(read(`../../canvas/${f}`), f).not.toMatch(/onContextMenu/)
    const view = read('../../canvas/CanvasView.tsx')
    expect(view.match(/onContextMenu=\{ctxMenu\.onContextMenu\}/g)).toHaveLength(1)
    // One host, at the App root (outside the region boundaries): the library's menu works whatever the canvas does.
    expect(view).not.toContain('<ContextMenuHost')
    expect(read('../../../App.tsx').match(/<ContextMenuHost \/>/g)).toHaveLength(1)
    expect(read('../../canvas/SceneNode.tsx')).toContain('data-ctx="ref"')
  })
  it('the host is a portal with role="menu" and data-top-overlay, no innerHTML; menus never confirm inside menuActions', () => {
    const host = read('../ContextMenuHost.tsx')
    expect(host).toContain('createPortal(')
    expect(host).toContain('role="menu"')
    expect(host).toContain('data-top-overlay')
    expect(host).not.toMatch(/dangerouslySetInnerHTML|innerHTML/)
    expect(read('../../../menuActions.ts')).not.toMatch(/window\.confirm|confirm\(/)
  })
  it('menu code never spells a modifier key (labels come from the keymap)', () => {
    for (const f of ['../canvasMenu.ts', '../libraryMenu.ts', '../ContextMenuHost.tsx', '../canvasContextMenu.ts']) expect(read(f), f).not.toMatch(/['"`][^'"`\n]*\bCtrl\b/)
  })
})

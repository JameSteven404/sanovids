// "Thư mục" nodes on the canvas — commands shared by the node, the toolbar, the wire gestures and the connect menu:
// create a node (choosing the folder right away), choose / re-allow / open its folder, wire videos ('save') and scenes
// ('autosave') into it, and the saves themselves. The node data lives in the project store (undoable wires); where
// and how files are written is lib/saveFolders.ts. Every finished take is auto-saved to the folders it or its scene is
// wired into (onRunEvent 'completed', below) — only in the tab that runs the queue, so never twice.
import { sceneCode } from './core/compile'
import { folderMapOf, folderTargetsFor, FOLDER_H, FOLDER_W } from './core/folders'
import { newId } from './core/ids'
import type { Take, XY } from './core/types'
import { placementHint, revealNodes, takeFileBase, takeLabel } from './actions'
import { takeFiles, useDownloadPrefs } from './lib/downloads'
import {
  canUseFolders,
  checkFolderAccess,
  noteFolderSaved,
  pickFolderLocation,
  rememberFolderHandle,
  requestFolderAccess,
  revealFolder,
  setFolderBusy,
  setFolderPending,
  UNSUPPORTED_TEXT,
  useFolderStatus,
  wasSavedTo,
  writeToFolder,
} from './lib/saveFolders'
import { freeSpotFrom, undoToastAction, useProject } from './store/project'
import { onRunEvent, useRuns } from './store/runs'
import { toast, useUI } from './store/ui'

const folderOf = (id: string) => folderMapOf(useProject.getState().project.folders).get(id)
const takeOf = (id: string) => useRuns.getState().takes.find((t) => t.id === id)

/** `folderId:takeId` saved (or being saved) automatically this session: a finished take is never auto-saved twice. */
const autoSaved = new Set<string>()
/** Saves that could not be written yet (permission to give again, folder to choose again): folder id → take ids. */
const waiting = new Map<string, Set<string>>()
/** The "chờ lưu" toast shown per folder (one at a time, not one per finished video). */
const waitingToast = new Map<string, number>()

function addWaiting(folderId: string, takeId: string) {
  const set = waiting.get(folderId) ?? new Set<string>()
  set.add(takeId)
  waiting.set(folderId, set)
  setFolderPending(folderId, set.size)
}
function dropWaiting(folderId: string, takeId: string) {
  const set = waiting.get(folderId)
  if (!set?.delete(takeId)) return
  if (!set.size) waiting.delete(folderId)
  setFolderPending(folderId, set.size)
}
const toastShown = (id: number | undefined) => id !== undefined && useUI.getState().toasts.some((t) => t.id === id)

// ---------------- saving ----------------
export interface FolderSaveOptions {
  /** Background save (a take just finished): no permission prompt; a refused one waits for "Cấp lại quyền". */
  auto?: boolean
}

/**
 * Copy one finished take (video + prompt .txt when "kèm prompt" is on) into a folder node's folder, never
 * overwriting. Says what happened in a toast. Returns true when the files were written.
 */
export async function saveTakeToFolder(takeId: string, folderId: string, opts: FolderSaveOptions = {}): Promise<boolean> {
  const folder = folderOf(folderId)
  const take = takeOf(takeId)
  if (!folder || !take || take.status !== 'completed') return false
  const what = takeLabel(takeId)
  const files = await takeFiles(take, takeFileBase(takeId), useDownloadPrefs.getState().withPrompt)
  if (!files.length) {
    toast(`Không tìm thấy file video của ${what} để lưu vào “${folder.name}”.`, { tone: 'error' })
    return false
  }
  setFolderBusy(folderId, true)
  let res: Awaited<ReturnType<typeof writeToFolder>>
  try {
    res = await writeToFolder(folder, files, !opts.auto)
  } catch (e) {
    res = { ok: false, access: 'ok', message: (e as Error)?.message || String(e) }
  } finally {
    setFolderBusy(folderId, false)
  }
  const label = `${what}${files.length > 1 ? ' + prompt' : ''}`
  if (res.ok) {
    dropWaiting(folderId, takeId)
    noteFolderSaved(folderId, res.names, takeId)
    const renamed = res.names[0] && res.names[0] !== files[0].name ? ` (tên “${res.names[0]}” vì đã có file trùng tên)` : ''
    toast(`Đã lưu ${label} vào thư mục “${folder.name}”${renamed}.`, { tone: 'success' })
    return true
  }
  if (res.access === 'ask' || res.access === 'pick' || res.access === 'missing') {
    addWaiting(folderId, takeId)
    if (toastShown(waitingToast.get(folderId))) return false
    const n = waiting.get(folderId)?.size ?? 1
    const ask = res.access === 'ask'
    waitingToast.set(
      folderId,
      toast(
        ask
          ? `${n > 1 ? `${n} video` : label} đang chờ lưu vào “${folder.name}”: trình duyệt cần bạn cho phép ghi vào thư mục này lần nữa.`
          : `Chưa lưu được ${n > 1 ? `${n} video` : label} vào “${folder.name}”: ${res.message}`,
        {
          tone: 'warning',
          ms: 20000,
          action: ask
            ? { label: 'Cho phép & lưu', run: () => void grantFolderAccess(folderId) }
            : { label: 'Chọn thư mục', run: () => void chooseFolderPlace(folderId) },
        },
      ),
    )
    return false
  }
  toast(`Không lưu được ${label} vào “${folder.name}”: ${res.message}`, { tone: 'error', ms: 9000 })
  return false
}

/** Save what waited for this folder (after the permission was given back or the folder chosen again). */
async function flushWaiting(folderId: string) {
  const ids = [...(waiting.get(folderId) ?? [])]
  for (const id of ids) {
    if (!takeOf(id)) {
      dropWaiting(folderId, id)
      continue
    }
    if (!(await saveTakeToFolder(id, folderId))) break
  }
}

/** A take just finished: save it into every folder it or its scene is wired into. */
async function autoSaveFinished(takeId: string) {
  const take = takeOf(takeId)
  if (!take || take.status !== 'completed') return
  for (const folder of folderTargetsFor(useProject.getState().project.folders, take)) {
    const key = `${folder.id}:${takeId}`
    if (autoSaved.has(key) || wasSavedTo(folder.id, takeId)) continue
    autoSaved.add(key)
    await saveTakeToFolder(takeId, folder.id, { auto: true })
  }
}

const stopAutoSave = onRunEvent((e) => {
  if (e.type === 'completed') void autoSaveFinished(e.takeId)
})
// Dev hot reload: the replaced module must stop listening, or every finished video would be saved twice.
if (import.meta.hot) import.meta.hot.dispose(() => stopAutoSave())

// ---------------- wiring ----------------
/** The finished take a scene would hand over now: starred, else its latest completed one. */
function finishedChosenTake(sceneId: string): Take | undefined {
  const own = useRuns
    .getState()
    .takes.filter((t) => t.sceneId === sceneId && t.status === 'completed')
    .sort((a, b) => b.number - a.number)
  return own.find((t) => t.starred) ?? own[0]
}

/**
 * Wire videos into a folder ('save'): finished ones are copied now, running / queued ones as soon as they finish.
 * A video already saved there is not copied twice by itself: the toast offers "Lưu thêm bản nữa".
 */
export function linkTakesToFolder(takeIds: readonly string[], folderId: string) {
  const folder = folderOf(folderId)
  if (!folder) return
  const takes = takeIds.map(takeOf).filter((t): t is Take => !!t)
  const usable = takes.filter((t) => t.status === 'completed' || t.status === 'queued' || t.status === 'processing')
  if (!usable.length) {
    toast('Video này chưa có (lỗi hoặc đã huỷ) nên không lưu được.', { tone: 'warning' })
    return
  }
  useProject.getState().linkFolder(
    folderId,
    'save',
    usable.map((t) => t.id),
  )
  const later = usable.filter((t) => t.status !== 'completed')
  const finished = usable.filter((t) => t.status === 'completed')
  const already = finished.filter((t) => wasSavedTo(folderId, t.id))
  for (const t of finished) if (!already.includes(t)) void saveTakeToFolder(t.id, folderId)
  if (already.length) {
    const what = already.length === 1 ? takeLabel(already[0].id) : `${already.length} video`
    toast(`${what} đã có trong thư mục “${folder.name}” rồi.`, {
      tone: 'info',
      ms: 8000,
      action: {
        label: 'Lưu thêm bản nữa',
        run: () => {
          void (async () => {
            for (const t of already) await saveTakeToFolder(t.id, folderId)
          })()
        },
      },
    })
  }
  if (later.length) {
    const what = later.length === 1 ? takeLabel(later[0].id) : `${later.length} video`
    toast(`${what} sẽ được lưu vào “${folder.name}” ngay khi tạo xong.`, { tone: 'info', action: undoToastAction() })
  }
}

/**
 * Wire scenes into a folder ('autosave'): every take of theirs that finishes from now on is saved there. A finished
 * chosen take is offered right away ("Lưu luôn …" in the toast).
 */
export function linkScenesToFolder(sceneIds: readonly string[], folderId: string) {
  const folder = folderOf(folderId)
  if (!folder) return
  const scenes = useProject.getState().project.scenes
  const valid = sceneIds.filter((id) => scenes.some((s) => s.id === id))
  if (!valid.length) return
  const added = useProject.getState().linkFolder(folderId, 'autosave', valid)
  if (!added.length) {
    toast(`${valid.length > 1 ? 'Các cảnh này' : 'Cảnh này'} đã tự lưu vào “${folder.name}” rồi.`, { tone: 'info' })
    return
  }
  announceAutosave(added, folderId)
}

function announceAutosave(sceneIds: readonly string[], folderId: string) {
  const folder = folderOf(folderId)
  if (!folder) return
  const scenes = useProject.getState().project.scenes
  const codes = sceneIds
    .map((id) => scenes.find((s) => s.id === id))
    .filter((s) => !!s)
    .sort((a, b) => a.order - b.order)
    .map((s) => sceneCode(s.order))
  const ready = sceneIds.map(finishedChosenTake).filter((t): t is Take => !!t && !wasSavedTo(folderId, t.id))
  const where = codes.length > 3 ? `${codes.slice(0, 3).join(', ')} +${codes.length - 3}` : codes.join(', ')
  toast(`Từ giờ mọi video mới của ${where} sẽ tự lưu vào “${folder.name}”.`, {
    tone: 'success',
    ms: ready.length ? 10000 : undefined,
    action: ready.length
      ? {
          label: ready.length === 1 ? `Lưu luôn ${takeLabel(ready[0].id)}` : `Lưu luôn ${ready.length} video đã xong`,
          run: () => {
            void (async () => {
              for (const t of ready) await saveTakeToFolder(t.id, folderId)
            })()
          },
        }
      : undoToastAction(),
  })
}

// ---------------- the node itself ----------------
/** Where a new folder node goes without a drop point: middle of the visible canvas (else left of the story), on a free spot. */
function defaultFolderPosition(): XY {
  const p = useProject.getState().project
  const view = placementHint().view
  const grid = (v: number) => Math.round(v / 16) * 16
  const start = view
    ? { x: grid(view.x + view.w / 2 - FOLDER_W / 2), y: grid(view.y + view.h / 2 - FOLDER_H / 2) }
    : { x: grid(Math.min(...p.scenes.map((s) => s.position.x), 420) - FOLDER_W - 160), y: 60 }
  return freeSpotFrom(p, start)
}

/**
 * "Thư mục": let the user choose a folder on the computer, then add a folder node for it (call from a click — the
 * browser only opens its folder picker then). `takeIds` / `sceneIds` are wired in at once (same undo step).
 * Returns the new node's id, or null (cancelled / impossible here).
 */
export async function createFolderNode(opts: { position?: XY; takeIds?: string[]; sceneIds?: string[] } = {}): Promise<string | null> {
  if (!canUseFolders()) {
    toast(UNSUPPORTED_TEXT, { tone: 'warning', ms: 9000 })
    return null
  }
  const { picked, reason } = await pickFolderLocation()
  if (!picked) {
    if (reason) toast(`Không chọn được thư mục: ${reason}`, { tone: 'warning', ms: 8000 })
    return null
  }
  const wanted = newId('fld')
  if (picked.handle) await rememberFolderHandle(wanted, picked.handle)
  const takes = (opts.takeIds ?? []).map(takeOf).filter((t): t is Take => !!t && t.status !== 'failed' && t.status !== 'cancelled')
  const sceneIds = (opts.sceneIds ?? []).filter((id) => useProject.getState().project.scenes.some((s) => s.id === id))
  const id = useProject.getState().addFolder({
    id: wanted,
    name: picked.name,
    path: picked.path,
    position: opts.position ?? defaultFolderPosition(),
    takes: takes.map((t) => t.id),
    autoScenes: sceneIds,
  })
  if (id !== wanted && picked.handle) await rememberFolderHandle(id, picked.handle)
  useFolderStatus.getState().patch(id, { access: 'ok', error: null })
  useUI.getState().select([id])
  revealNodes([id])
  if (sceneIds.length) announceAutosave(sceneIds, id)
  else if (!takes.length) {
    toast(`Đã thêm thư mục “${picked.name}”. Kéo dây từ video (chấm tím) hoặc từ cảnh vào đây để lưu video.`, {
      tone: 'success',
      action: undoToastAction(),
      ms: 7000,
    })
  }
  for (const t of takes) {
    if (t.status === 'completed') await saveTakeToFolder(t.id, id)
  }
  const later = takes.filter((t) => t.status !== 'completed')
  if (later.length) toast(`${later.length === 1 ? takeLabel(later[0].id) : `${later.length} video`} sẽ được lưu vào “${picked.name}” khi tạo xong.`, { tone: 'info' })
  return id
}

/** "Chọn thư mục" on a node: point it at a (new) folder, then save what waited for it. Call from a click. */
export async function chooseFolderPlace(folderId: string): Promise<boolean> {
  const folder = folderOf(folderId)
  if (!folder) return false
  if (!canUseFolders()) {
    toast(UNSUPPORTED_TEXT, { tone: 'warning', ms: 9000 })
    return false
  }
  const { picked, reason } = await pickFolderLocation()
  if (!picked) {
    if (reason) toast(`Không chọn được thư mục: ${reason}`, { tone: 'warning', ms: 8000 })
    return false
  }
  if (picked.handle) await rememberFolderHandle(folderId, picked.handle)
  // Web keeps the path a desktop build stored (the same project may be opened there again).
  useProject.getState().updateFolder(folderId, { name: picked.name, path: picked.path ?? folder.path })
  const now = folderOf(folderId)
  if (now) await checkFolderAccess(now)
  useFolderStatus.getState().patch(folderId, { error: null })
  toast(`Thư mục “${picked.name}” đã sẵn sàng.`, { tone: 'success' })
  await flushWaiting(folderId)
  return true
}

/** "Cấp lại quyền" (web, after a restart): ask the browser again, then save what waited. Call from a click. */
export async function grantFolderAccess(folderId: string): Promise<void> {
  const folder = folderOf(folderId)
  if (!folder) return
  const access = await requestFolderAccess(folder)
  if (access === 'ok') {
    await flushWaiting(folderId)
    return
  }
  if (access === 'pick' || access === 'missing') {
    await chooseFolderPlace(folderId)
    return
  }
  toast(`Trình duyệt chưa cho phép ghi vào “${folder.name}”.`, { tone: 'warning' })
}

/** "Mở thư mục" (desktop app): show it in Explorer / Finder. */
export async function openFolderNode(folderId: string): Promise<void> {
  const folder = folderOf(folderId)
  if (!folder) return
  const err = await revealFolder(folder)
  if (err) toast(`Không mở được thư mục: ${err}`, { tone: 'warning' })
}

/** Remove a folder node from the canvas (undoable). Files already saved stay in the folder. */
export function removeFolderNode(folderId: string) {
  const folder = folderOf(folderId)
  if (!folder) return
  useProject.getState().deleteItems({ folderIds: [folderId] })
  const ui = useUI.getState()
  if (ui.selectedIds.includes(folderId)) ui.select(ui.selectedIds.filter((x) => x !== folderId))
  toast(`Đã bỏ thư mục “${folder.name}” khỏi canvas (các file đã lưu vẫn còn trong thư mục).`, { action: undoToastAction() })
}

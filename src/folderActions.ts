// "Thư mục" nodes on the canvas — commands shared by the node, the toolbar, the wire gestures and the connect menu:
// create a node (choosing the folder right away), choose / re-allow / open its folder, wire videos ('save') and scenes
// ('autosave') into it, and the saves themselves. The node data lives in the project store (undoable wires); where
// and how files are written is lib/saveFolders.ts. Every finished take is auto-saved to the folders it or its scene is
// wired into (onRunEvent 'completed', below) — only in the tab that runs the queue, so never twice.
//
// A save is written only while a wire still points the take at the folder (core/folders isTargeted): a waiting save of
// a cut wire, or "Lưu thêm bản nữa" from an old toast, writes nothing. Each write names where it comes from (SaveVia):
// the take → folder wire's own writes are recorded in the ownership record (saveFolders addOwned).
//
// "Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác" (downloads pref folderUnlinkTrash, desktop app): when a
// take → folder wire goes away by a user action — a cut (canvas/edges cutFolderEdge), Delete (actions.deleteSelection),
// a redo of a cut or an undo of the step that made the wire (onHistoryJump below) — afterSaveUnlinked asks the main
// process to move the files THAT wire wrote, unchanged, to the Recycle Bin (never the auto-save wire's, never a file
// already there, never the last copy: SanoVids must still have the video). It runs in the folder's lock, after a save
// being written. Hoàn tác / Ctrl+Z brings the wire back and writes a NEW copy (the old one stays in the Recycle Bin).
// Deleting a video / a scene, removing the folder node, choosing another folder or cutting an auto-save wire never
// touches files. Texts: core/folderTrash.
import { sceneCode } from './core/compile'
import {
  addedSaveLinks,
  notLinkedText,
  outcomeOfResult,
  removedSaveLinks,
  restoreToastText,
  TRASH_FIRST_HINT,
  TRASH_HINT_KEY,
  TRASH_SLOW_MS,
  trashFlushText,
  trashingToastText,
  trashSummaryText,
  unlinkToast,
  type SaveLinkPair,
  type UnlinkKind,
  type UnlinkOutcome,
} from './core/folderTrash'
import { folderMapOf, folderTargetsFor, FOLDER_H, FOLDER_W, isTargeted } from './core/folders'
import { newId } from './core/ids'
import type { Take, XY } from './core/types'
import { placementHint, revealNodes, takeFileBase, takeLabel } from './actions'
import type { SaveVia, TrashSavedItem } from './lib/desktopFiles'
import { takeFiles, useDownloadPrefs } from './lib/downloads'
import { getBlob } from './lib/imageStore'
import {
  addOwned,
  canTrashSaved,
  canUseFolders,
  checkFolderAccess,
  forgetSavedTake,
  markTrashWaiting,
  markWaiting,
  noteFolderSaved,
  ownedGroups,
  ownedGroupsOf,
  pickFolderLocation,
  releaseOwned,
  rememberFolderHandle,
  requestFolderAccess,
  revealFolder,
  setFolderBusy,
  setOwned,
  trashSavedFiles,
  trashWaitingTakes,
  UNSUPPORTED_TEXT,
  useFolderStatus,
  waitingTakes,
  wasSavedTo,
  writeToFolder,
} from './lib/saveFolders'
import { freeSpotFrom, onHistoryJump, undoToastAction, useProject } from './store/project'
import { onRunEvent, useRuns } from './store/runs'
import { toast, useUI, type ToastAction } from './store/ui'

const folderOf = (id: string) => folderMapOf(useProject.getState().project.folders).get(id)
const takeOf = (id: string) => useRuns.getState().takes.find((t) => t.id === id)

/** `folderId:takeId` saved (or being saved) automatically this session: a finished take is never auto-saved twice. */
const autoSaved = new Set<string>()
// Saves that could not be written yet (permission to give again, folder to choose again) wait in lib/saveFolders
// (waitingTakes / markWaiting): kept per browser / computer, so a reload or a restart does not lose them.
/** The "chờ lưu" toast shown per folder (one at a time, not one per finished video). */
const waitingToast = new Map<string, number>()
/** Folders whose waiting saves are being written by this tab (a click and the node's own check never run twice). */
const flushing = new Set<string>()
/** Folders whose cut wires waiting for them are being handled by this tab. */
const trashFlushing = new Set<string>()
/** `folderId:takeId` being written by this tab right now (also where Web Locks are missing). */
const inFlight = new Set<string>()

const toastShown = (id: number | undefined) => id !== undefined && useUI.getState().toasts.some((t) => t.id === id)

/** Nothing waits for this folder any more: its "Chưa lưu được … [Chọn thư mục]" toast goes away. */
function clearWaitingToast(folderId: string) {
  if (waitingTakes(folderId).length) return
  const id = waitingToast.get(folderId)
  waitingToast.delete(folderId)
  if (id !== undefined) useUI.getState().dismissToast(id)
}

// ---------------- saving ----------------
export interface FolderSaveOptions {
  /** Background save (a take just finished): no permission prompt; a refused one waits for "Cấp lại quyền". */
  auto?: boolean
  /**
   * Where the write comes from (recorded by the main process). Default: 'link' when the take's own wire points at the
   * folder, else 'autosave'. 'link' / 'again' / 'restore' are only kept while the take → folder wire exists.
   */
  via?: SaveVia
}

interface SaveNowOptions extends FolderSaveOptions {
  /** No toast: the caller says what happened (Hoàn tác writing a copy again). */
  quiet?: boolean
}

type SaveNowResult = { ok: true } | { ok: false; message: string }

/** Folders whose saves run one after the other in this tab when Web Locks are missing (the tail of each chain). */
const folderChains = new Map<string, Promise<void>>()

/**
 * Saves into one folder (and moving its files to the Recycle Bin) run one at a time, across tabs too (Web Locks): a save
 * noted as waiting while it is written is never written a second time by another tab or by the node's own check (they
 * read the waiting list inside the lock), and a cut wire takes along a file being written for it. Without Web Locks:
 * one chain per folder in this tab. Never nest: inside the lock call saveNow, not saveTakeToFolder.
 */
async function withFolderLock<T>(folderId: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks
  if (locks?.request) return locks.request(`sanovids:folder-save:${folderId}`, () => fn())
  const prev = folderChains.get(folderId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  folderChains.set(folderId, tail)
  void tail.then(() => {
    if (folderChains.get(folderId) === tail) folderChains.delete(folderId)
  })
  return run
}

/**
 * Copy one finished take (video + prompt .txt when "kèm prompt" is on) into a folder node's folder, never
 * overwriting — while a wire still points the take there. Says what happened in a toast. Returns true when the files
 * were written.
 */
export async function saveTakeToFolder(takeId: string, folderId: string, opts: FolderSaveOptions = {}): Promise<boolean> {
  return (await withFolderLock(folderId, () => saveNow(takeId, folderId, opts))).ok
}

/** saveTakeToFolder, inside the folder's lock. */
async function saveNow(takeId: string, folderId: string, opts: SaveNowOptions): Promise<SaveNowResult> {
  const folder = folderOf(folderId)
  const take = takeOf(takeId)
  if (!folder || !take || take.status !== 'completed') return { ok: false, message: 'Video hoặc thư mục không còn.' }
  const what = takeLabel(takeId)
  // No wire points this take at the folder any more (cut meanwhile): nothing is written, nothing waits.
  if (!isTargeted(folder, take)) {
    markWaiting(folderId, [takeId], false)
    clearWaitingToast(folderId)
    const message = notLinkedText(what, folder.name)
    if (!opts.auto && !opts.quiet) toast(message, { tone: 'warning' })
    return { ok: false, message }
  }
  const saveWired = !!folder.takes?.includes(takeId)
  const via: SaveVia = opts.via === 'autosave' || !saveWired ? 'autosave' : (opts.via ?? 'link')
  const files = await takeFiles(take, takeFileBase(takeId), useDownloadPrefs.getState().withPrompt)
  if (!files.length) {
    const message = `Không tìm thấy file video của ${what} để lưu vào “${folder.name}”.`
    if (!opts.quiet) toast(message, { tone: 'error' })
    return { ok: false, message }
  }
  // Noted as waiting while it is written: if the app is closed in the middle, it is written again later.
  const key = `${folderId}:${takeId}`
  const wasWaiting = waitingTakes(folderId).includes(takeId)
  markWaiting(folderId, [takeId], true)
  inFlight.add(key)
  setFolderBusy(folderId, true)
  let res: Awaited<ReturnType<typeof writeToFolder>>
  try {
    res = await writeToFolder(folder, files, !opts.auto, { takeId, via })
  } catch (e) {
    res = { ok: false, access: 'ok', message: (e as Error)?.message || String(e) }
  } finally {
    inFlight.delete(key)
    setFolderBusy(folderId, false)
  }
  const label = `${what}${files.length > 1 ? ' + prompt' : ''}`
  if (res.ok) {
    markWaiting(folderId, [takeId], false)
    clearWaitingToast(folderId)
    noteFolderSaved(folderId, res.names, takeId)
    // Written for the take → folder wire: that wire owns the group — also when it was cut during the write (the cut's
    // own handling runs after this, in the same lock, and takes the file along).
    if (res.recorded && via !== 'autosave' && via !== 'manual') addOwned(folderId, takeId, res.recorded)
    if (!opts.quiet) {
      const renamed = res.names[0] && res.names[0] !== files[0].name ? ` (tên “${res.names[0]}” vì đã có file trùng tên)` : ''
      toast(`Đã lưu ${label} vào thư mục “${folder.name}”${renamed}.`, { tone: 'success' })
    }
    return { ok: true }
  }
  if (res.access === 'ask' || res.access === 'pick' || res.access === 'missing') {
    // Stays in the waiting list: saved by "Cấp lại quyền" / "Chọn lại thư mục", or when the folder is back.
    if (opts.quiet || toastShown(waitingToast.get(folderId))) return { ok: false, message: res.message }
    const n = waitingTakes(folderId).length || 1
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
    return { ok: false, message: res.message }
  }
  // Another problem (disk full…): said now, not retried by itself (unless it was already waiting before).
  if (!wasWaiting) markWaiting(folderId, [takeId], false)
  if (!opts.quiet) toast(`Không lưu được ${label} vào “${folder.name}”: ${res.message}`, { tone: 'error', ms: 9000 })
  return { ok: false, message: res.message }
}

/** Waiting saves of videos that are gone (deleted, not in this project) or no longer wired to the folder are dropped. */
function pruneWaiting(folderId: string) {
  const folder = folderOf(folderId)
  const gone = waitingTakes(folderId).filter((id) => {
    const t = takeOf(id)
    return t?.status !== 'completed' || !folder || !isTargeted(folder, t)
  })
  if (gone.length) markWaiting(folderId, gone, false)
  clearWaitingToast(folderId)
}

/**
 * Save what waited for this folder (after the permission was given back, the folder chosen again, or when the node
 * finds the folder writable again). `auto`: no permission prompt (not after a click). Runs after the saves into the
 * folder being written (this tab or another), which end their own wait.
 */
async function flushWaiting(folderId: string, auto = false) {
  if (flushing.has(folderId)) return
  flushing.add(folderId)
  try {
    await withFolderLock(folderId, async () => {
      pruneWaiting(folderId)
      // Read again inside the lock: another tab may have saved some meanwhile.
      for (const id of waitingTakes(folderId)) {
        if (inFlight.has(`${folderId}:${id}`)) continue
        if (!(await saveNow(id, folderId, { auto })).ok) break
      }
    })
  } finally {
    flushing.delete(folderId)
  }
}

/**
 * A folder node is shown (or points at another folder): check it can be written, forget waiting saves of videos that
 * are gone, move the files of wires cut while it was away to the Recycle Bin, and save the waiting ones when the folder
 * is writable again (desktop: the drive is back; web: the permission was kept) — they also wait across a reload or a
 * restart.
 */
export async function refreshFolderNode(folderId: string): Promise<void> {
  const folder = folderOf(folderId)
  if (!folder) return
  const access = await checkFolderAccess(folder)
  if (!folderOf(folderId)) return
  pruneWaiting(folderId)
  if (access === 'ok' && trashWaitingTakes(folderId).length) await flushTrashWaiting(folderId)
  if (access === 'ok' && waitingTakes(folderId).length) await flushWaiting(folderId, true)
}

/** A take just finished: save it into every folder it or its scene is wired into. */
async function autoSaveFinished(takeId: string) {
  const take = takeOf(takeId)
  if (!take || take.status !== 'completed') return
  for (const folder of folderTargetsFor(useProject.getState().project.folders, take)) {
    const key = `${folder.id}:${takeId}`
    if (autoSaved.has(key) || wasSavedTo(folder.id, takeId)) continue
    autoSaved.add(key)
    // via: 'link' when the take's own wire points here (its waiting copy), else 'autosave' (saveNow decides).
    await saveTakeToFolder(takeId, folder.id, { auto: true })
  }
}

const stopAutoSave = onRunEvent((e) => {
  if (e.type === 'completed') void autoSaveFinished(e.takeId)
})

// ---------------- take → folder wires that went away: their files to the Recycle Bin ----------------
/** Where a cut came from (`retry`: "Thử lại", or the folder came back). */
export type UnlinkSource = 'cut' | 'delete' | 'history' | 'retry'

export interface UnlinkOptions {
  source: UnlinkSource
  /** Hoàn tác of the step that cut the wire, captured right after it (kept on the toasts). */
  undo?: ToastAction
  /** 'single': one toast for the one pair · 'summary': one toast for all · 'none': the caller says it. */
  toast: 'single' | 'summary' | 'none'
}

/**
 * What a cut did this session, for Hoàn tác / Ctrl+Z bringing the wire back ("projectId:folderId:takeId"):
 * trashing (being handled) · trashed (copies moved: write a new one) · queued (waiting for the folder: drop it) ·
 * kept (files left where they were: the wire owns nothing now) · legacy (saved by an older build: unknown) ·
 * unsaved (nothing was saved there: save it now if it should be) · restored (brought back). Lost on reload / with the
 * project, like the undo history.
 */
type UnlinkState = 'trashing' | 'trashed' | 'queued' | 'kept' | 'legacy' | 'unsaved' | 'restored'
const unlinked = new Map<string, UnlinkState>()
const unlinkedKey = (p: SaveLinkPair) => `${useProject.getState().project.id}:${p.folderId}:${p.takeId}`

/** Same pairs once each, grouped by folder (insertion order). */
function byFolder(pairs: readonly SaveLinkPair[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const p of pairs) {
    const list = out.get(p.folderId) ?? []
    if (!list.includes(p.takeId)) list.push(p.takeId)
    out.set(p.folderId, list)
  }
  return out
}

async function hasBlob(take: Take): Promise<boolean> {
  const id = take.videoId ?? take.posterId
  if (!id) return false
  try {
    return !!(await getBlob(id))
  } catch {
    return false
  }
}

/** The first-run tip "Tắt ở Cài đặt → Tải video." goes on the first toast that moved a file (once per device). */
function firstTrashHint(): string {
  try {
    if (localStorage.getItem(TRASH_HINT_KEY)) return ''
    localStorage.setItem(TRASH_HINT_KEY, '1')
  } catch {
    return ''
  }
  return ` ${TRASH_FIRST_HINT}`
}

interface FolderPass {
  outcomes: Map<string, UnlinkOutcome>
  /** Pairs to offer "Thử lại" for. */
  retry: SaveLinkPair[]
}

/**
 * One folder's cut wires, inside its lock (after a save being written for them). Each pair: dropped from the waiting
 * saves; then, only when the setting is on (desktop), the folder node and its path exist, the take exists, is finished
 * and no wire targets the folder for it any more, SanoVids still has the video, and the wire itself wrote groups
 * (ownership record) → those groups go to files:trashSaved. The ownership record of a pair is released once dealt with,
 * except while its files wait for the folder or could not be moved (Thử lại).
 */
async function unlinkInFolder(folderId: string, takeIds: readonly string[], onSlow?: () => void): Promise<FolderPass> {
  const pass: FolderPass = { outcomes: new Map(), retry: [] }
  const folder = folderOf(folderId)
  const name = folder?.name ?? 'Thư mục'
  const prefOn = useDownloadPrefs.getState().folderUnlinkTrash
  const canTrash = canTrashSaved()
  const ask: TrashSavedItem[] = []
  /** Pairs whose ownership record goes (dealt with: what is left in the folder is the user's now). */
  const release: string[] = []
  const settle = (takeId: string, kind: UnlinkKind, state: UnlinkState | null, extra: Partial<UnlinkOutcome> = {}) => {
    pass.outcomes.set(takeId, { kind, code: takeLabel(takeId), folder: name, ...extra })
    const key = unlinkedKey({ folderId, takeId })
    if (state) unlinked.set(key, state)
    else unlinked.delete(key)
  }
  if (!folder) {
    releaseOwned(folderId, takeIds)
    for (const takeId of takeIds) settle(takeId, 'skip', null)
    return pass
  }
  // Wired again meanwhile (Ctrl+Z, a new wire): the wire owns its files again — nothing is moved, nothing waits.
  const relinked: string[] = []
  const cut = takeIds.filter((takeId) => {
    if (!folder.takes?.includes(takeId)) return true
    relinked.push(takeId)
    settle(takeId, 'skip', null)
    return false
  })
  if (relinked.length) markTrashWaiting(folderId, relinked, false)
  // Never written by itself any more (bug A), nor moved later by an earlier cut.
  markWaiting(folderId, cut, false)
  markTrashWaiting(folderId, cut, false)
  clearWaitingToast(folderId)
  const owned = ownedGroupsOf(cut.map((takeId) => ({ folderId, takeId })))
  for (let i = 0; i < cut.length; i++) {
    const takeId = cut[i]
    const take = takeOf(takeId)
    if (!take) {
      release.push(takeId)
      settle(takeId, 'skip', null)
    } else if (!prefOn || !canTrash) {
      release.push(takeId)
      settle(takeId, 'off', 'kept')
    } else if (isTargeted(folder, take)) {
      // Its scene still auto-saves into this folder: the files stay there.
      release.push(takeId)
      settle(takeId, 'linked', 'kept')
    } else if (take.status !== 'completed') {
      release.push(takeId)
      settle(takeId, 'unsaved', 'unsaved')
    } else if (owned[i] === null) {
      // No record of what this wire wrote: saved by an older build (or the record was lost) — never guess.
      if (wasSavedTo(folderId, takeId)) settle(takeId, 'unknown', 'legacy')
      else settle(takeId, 'unsaved', 'unsaved')
    } else if (!owned[i]!.length) {
      release.push(takeId)
      settle(takeId, 'preexisting', 'kept')
    } else if (!folder.path) {
      release.push(takeId)
      settle(takeId, 'pick', 'kept')
    } else if (!(await hasBlob(take))) {
      // Never the last copy: SanoVids must still have this video.
      release.push(takeId)
      settle(takeId, 'noBlob', 'kept')
    } else ask.push({ takeId, groupIds: owned[i]! })
  }
  if (ask.length) {
    const slow = onSlow ? setTimeout(onSlow, TRASH_SLOW_MS) : undefined
    let res: Awaited<ReturnType<typeof trashSavedFiles>>
    try {
      res = await trashSavedFiles(folder, ask)
    } finally {
      if (slow) clearTimeout(slow)
    }
    for (const r of res.results) {
      const o = outcomeOfResult(r)
      if (o.copies) forgetSavedTake(folderId, r.takeId, o.copies, o.trashedNames)
      // Some file could not be moved: the record stays (Thử lại sends the same groups; moved ones are gone from it).
      // An online-only file (cloud) is kept like a changed one: no "Thử lại", the record goes.
      if (o.failed) pass.retry.push({ folderId, takeId: r.takeId })
      else release.push(r.takeId)
      // A video moved now or by an earlier call of this cut ("Thử lại" of its .txt): Hoàn tác writes a copy again.
      settle(r.takeId, o.kind, o.copies || o.earlier ? 'trashed' : o.kind === 'unknown' || o.kind === 'elsewhere' ? 'legacy' : 'kept', {
        copies: o.copies || undefined,
        files: o.files || undefined,
        name: o.name,
        withTxt: o.withTxt || undefined,
        txtKept: o.txtKept || undefined,
        someFailed: o.kind === 'trashed' && o.failed ? o.failed : undefined,
      })
    }
    const queued: string[] = []
    for (const p of res.problems) {
      for (const takeId of p.takeIds) {
        if (p.access === 'missing') {
          // The folder cannot be reached: its files go when it is back (the groups stay in the ownership record).
          queued.push(takeId)
          settle(takeId, 'queued', 'queued')
        } else if (p.access === 'pick' || p.access === 'unsupported') {
          release.push(takeId)
          settle(takeId, p.access === 'pick' ? 'pick' : 'off', 'kept')
        } else {
          pass.retry.push({ folderId, takeId })
          settle(takeId, 'failed', 'kept')
        }
      }
    }
    if (queued.length) markTrashWaiting(folderId, queued, true)
  }
  releaseOwned(folderId, release)
  return pass
}

/** Outcomes a history jump / retry says nothing about (the wire just changed, nothing was saved or moved). */
const QUIET_KINDS = new Set<UnlinkKind>(['skip', 'off', 'unsaved', 'linked'])

/**
 * Take → folder wires went away by a user action (`pairs`, after the store change): move what each wire itself wrote
 * to the Recycle Bin when allowed (see unlinkInFolder), then say so — one toast for one pair ('single', with Hoàn tác
 * or "Thử lại"), one summary toast ('summary'), or nothing ('none'). Each folder in its lock. Never throws.
 */
export async function afterSaveUnlinked(pairs: readonly SaveLinkPair[], opts: UnlinkOptions): Promise<UnlinkOutcome[]> {
  const groups = byFolder(pairs)
  for (const [folderId, takeIds] of groups) for (const takeId of takeIds) unlinked.set(unlinkedKey({ folderId, takeId }), 'trashing')
  const single = opts.toast === 'single' && pairs.length === 1 ? pairs[0] : null
  let interim: number | undefined
  const onSlow = single
    ? () => {
        interim = toast(trashingToastText(takeLabel(single.takeId), folderOf(single.folderId)?.name ?? 'Thư mục'), {
          persistent: true,
          ...(opts.undo ? { action: opts.undo } : {}),
        })
      }
    : undefined
  let passes: FolderPass[] = []
  try {
    // Every folder's lock is asked for now (in order with saves / restores asked for later).
    passes = await Promise.all(
      [...groups].map(([folderId, takeIds]) =>
        withFolderLock(folderId, () => unlinkInFolder(folderId, takeIds, onSlow)).catch((e: unknown) => {
          console.error('[folders] unlink failed', e)
          return { outcomes: new Map<string, UnlinkOutcome>(), retry: [] } as FolderPass
        }),
      ),
    )
  } finally {
    if (interim !== undefined) useUI.getState().dismissToast(interim)
  }
  const outcomes: UnlinkOutcome[] = []
  const retry: SaveLinkPair[] = []
  ;[...groups].forEach(([, takeIds], i) => {
    for (const takeId of takeIds) {
      const o = passes[i]?.outcomes.get(takeId)
      if (o) outcomes.push(o)
    }
    retry.push(...(passes[i]?.retry ?? []))
  })
  if (opts.toast !== 'none') sayUnlinked(outcomes, retry, opts)
  return outcomes
}

function sayUnlinked(outcomes: readonly UnlinkOutcome[], retry: readonly SaveLinkPair[], opts: UnlinkOptions) {
  const quietJump = opts.source === 'history' || opts.source === 'retry'
  const shown = quietJump ? outcomes.filter((o) => !QUIET_KINDS.has(o.kind)) : outcomes
  if (!shown.length) return
  const retryAction: ToastAction | undefined = retry.length
    ? { label: 'Thử lại', run: () => void afterSaveUnlinked(retry, { source: 'retry', toast: retry.length === 1 ? 'single' : 'summary', undo: opts.undo }) }
    : undefined
  const t = opts.toast === 'single' && outcomes.length === 1 ? unlinkToast(outcomes[0]) : trashSummaryText(shown)
  if (!t) return
  const hint = shown.some((o) => o.kind === 'trashed') ? firstTrashHint() : ''
  const action = t.retry ? retryAction : quietJump ? undefined : opts.undo
  toast(`${t.text}${hint}`, { tone: t.tone, ...(t.ms ? { ms: t.ms } : {}), ...(action ? { action } : {}) })
}

/**
 * Hoàn tác / Ctrl+Z (or a redo) brought take → folder wires back: undo what their cut did — a copy that went to the
 * Recycle Bin is written again (a NEW copy, whatever the setting: the app moved a file away, it puts one back), a
 * pending move is dropped, a wire whose files were kept owns nothing (a later cut keeps them too), a save that never
 * happened is written now. Inside each folder's lock, after the cut's own handling.
 */
async function restoreAfterUndo(pairs: readonly SaveLinkPair[]): Promise<void> {
  const groups = byFolder(pairs.filter((p) => unlinked.has(unlinkedKey(p))))
  await Promise.all(
    [...groups].map(([folderId, takeIds]) =>
      withFolderLock(folderId, async () => {
        const ok: string[] = []
        const failed: { takeId: string; message: string }[] = []
        for (const takeId of takeIds) {
          const key = unlinkedKey({ folderId, takeId })
          const state = unlinked.get(key)
          const folder = folderOf(folderId)
          if (!state || !folder || !folder.takes?.includes(takeId)) continue
          // 'trashing': its cut has not been handled yet — it will see the wire back and leave everything as it is.
          if (state === 'trashing' || state === 'restored') continue
          unlinked.set(key, 'restored')
          if (state === 'queued') markTrashWaiting(folderId, [takeId], false)
          else if (state === 'kept') {
            if (ownedGroups(folderId, takeId) === null) setOwned(folderId, takeId, [])
          } else if (state === 'unsaved') {
            const take = takeOf(takeId)
            if (take?.status === 'completed' && !wasSavedTo(folderId, takeId)) await saveNow(takeId, folderId, { auto: true, via: 'link' })
          } else if (state === 'trashed') {
            const res = await saveNow(takeId, folderId, { via: 'restore', quiet: true })
            if (res.ok) ok.push(takeId)
            else failed.push({ takeId, message: res.message })
          }
        }
        const name = folderOf(folderId)?.name ?? 'Thư mục'
        if (ok.length) toast(restoreToastText(true, ok.length === 1 ? takeLabel(ok[0]) : `${ok.length} video`, name), { tone: 'success' })
        if (failed.length) {
          const what = failed.length === 1 ? takeLabel(failed[0].takeId) : `${failed.length} video`
          toast(restoreToastText(false, what, name, failed[0].message.replace(/[.。]\s*$/, '')), { tone: 'warning', ms: 12000 })
        }
      }).catch((e: unknown) => console.error('[folders] restore failed', e)),
    ),
  )
}

/** The folder is back: wires cut while it was away take their files to the Recycle Bin now (if still allowed). */
async function flushTrashWaiting(folderId: string): Promise<void> {
  if (trashFlushing.has(folderId)) return
  const takeIds = trashWaitingTakes(folderId)
  if (!takeIds.length) return
  trashFlushing.add(folderId)
  try {
    const outcomes = await afterSaveUnlinked(
      takeIds.map((takeId) => ({ folderId, takeId })),
      { source: 'retry', toast: 'none' },
    )
    const moved = outcomes.filter((o) => o.kind === 'trashed')
    const files = moved.reduce((n, o) => n + (o.files ?? o.copies ?? 1), 0)
    const others = outcomes.filter((o) => o.kind !== 'trashed' && !QUIET_KINDS.has(o.kind))
    if (others.length) {
      const t = trashSummaryText(outcomes)
      if (t) toast(t.text, { tone: t.tone, ...(t.ms ? { ms: t.ms } : {}) })
    } else if (files) toast(trashFlushText(files, folderOf(folderId)?.name ?? 'Thư mục'), { tone: 'success' })
  } finally {
    trashFlushing.delete(folderId)
  }
}

// Undo / redo jumps that cut or brought back take → folder wires (never loads, imports, deleted videos: not jumps).
const stopHistory = onHistoryJump((before, after) => {
  if (before.id !== after.id) return
  const removed = removedSaveLinks(before.folders, after.folders)
  const added = addedSaveLinks(before.folders, after.folders)
  if (removed.length) void afterSaveUnlinked(removed, { source: 'history', toast: removed.length === 1 ? 'single' : 'summary' })
  if (added.length) void restoreAfterUndo(added)
})
// What a cut did belongs to the open project's undo history: forgotten with it.
const stopProjectWatch = useProject.subscribe((s, prev) => {
  if (s.project.id !== prev.project.id) unlinked.clear()
})

// Dev hot reload: the replaced module must stop listening, or every finished video would be saved twice (and every
// undo handled twice).
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopAutoSave()
    stopHistory()
    stopProjectWatch()
  })

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
 * A video already saved there is not copied twice by itself: the toast offers "Lưu thêm bản nữa" — and that new wire
 * owns nothing it did not copy (cutting it, or Ctrl+Z, keeps the file that was already there).
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
  const added = new Set(
    useProject.getState().linkFolder(
      folderId,
      'save',
      usable.map((t) => t.id),
    ),
  )
  // Wired again: a move waiting for the folder, and what an earlier cut did, are forgotten.
  markTrashWaiting(
    folderId,
    usable.map((t) => t.id),
    false,
  )
  for (const t of usable) unlinked.delete(unlinkedKey({ folderId, takeId: t.id }))
  const later = usable.filter((t) => t.status !== 'completed')
  const finished = usable.filter((t) => t.status === 'completed')
  const already = finished.filter((t) => wasSavedTo(folderId, t.id))
  // A new wire to a video already there copies nothing: it owns nothing (unless a failed / waiting cut kept its groups).
  for (const t of already) if (added.has(t.id) && ownedGroups(folderId, t.id) === null) setOwned(folderId, t.id, [])
  for (const t of finished) if (!already.includes(t)) void saveTakeToFolder(t.id, folderId, { via: 'link' })
  if (already.length) {
    const what = already.length === 1 ? takeLabel(already[0].id) : `${already.length} video`
    toast(`${what} đã có trong thư mục “${folder.name}” rồi.`, {
      tone: 'info',
      ms: 8000,
      action: {
        label: 'Lưu thêm bản nữa',
        run: () => {
          void (async () => {
            for (const t of already) await saveTakeToFolder(t.id, folderId, { via: 'again' })
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
              for (const t of ready) await saveTakeToFolder(t.id, folderId, { via: 'autosave' })
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
    if (t.status === 'completed') await saveTakeToFolder(t.id, id, { via: 'link' })
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
  // Web keeps the path a desktop build stored (the same project may be opened there again). Not an undo step: the
  // browser's folder handle just stored is not undoable either (Ctrl+Z must not show the old name while saves go here).
  useProject.getState().setFolderPlace(folderId, { name: picked.name, path: picked.path ?? folder.path })
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

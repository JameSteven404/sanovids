// "Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác" (downloads pref folderUnlinkTrash, desktop app only) — the
// pure part: which take → folder ('save') wires an undo / redo jump cut or brought back, what the main process answered
// for each take (files moved to the Recycle Bin / kept), and every user-facing sentence of the feature (toasts, the
// confirmation, the Settings row, wire tooltips, the folder node). No stores, no bridge. Tested in
// ./__tests__/folderTrash.test.ts. The commands are src/folderActions.ts (afterSaveUnlinked); the main process only ever
// moves files it wrote itself for that wire and that are unchanged (electron/main.cjs files:trashSaved).
//
// ---- API ----
//   isTargeted(folder, take)                 (core/folders) a wire still points this take at the folder.
//   removedSaveLinks / addedSaveLinks(a, b)  'save' pairs present in a but not in b (folders present in both only).
//   trashBatches(items, max)                 items split into calls of ≤ TRASH_BATCH_MAX (the main process refuses more).
//   outcomeOfResult(result)                  one take's TrashSavedTakeResult → kind + counts + names.
//   unlinkToast(o)                           the toast of one unlinked take (null = say nothing).
//   trashSummaryText(outcomes)               the extra toast after a Delete that cut several 'save' wires.
//   trashConfirmText(n, folderNames)         the question before a Delete that would move files of ≥ 5 videos.
//   restoreToastText(…) / trashFlushText(…) / notLinkedText(…) / trashingToastText(…)   other sentences.
//   FOLDER_UNLINK_TRASH_ROW, …               Settings row, wire tooltips, folder node status.
import type { TrashFileResult, TrashSavedFile, TrashSavedTakeResult } from '../lib/desktopFiles'
import { isTargeted } from './folders'
import type { SaveFolder } from './types'

export { isTargeted }

/** A Delete that would move the saved files of this many videos (or more) asks first. Cutting one wire never asks. */
export const TRASH_CONFIRM_MIN = 5
/** Items per files:trashSaved call (electron/main.cjs checkTrashArgs refuses more). */
export const TRASH_BATCH_MAX = 200
/** Ledger groups sent per take (checkTrashArgs refuses more); the ownership record keeps the most recent ones. */
export const TRASH_GROUPS_MAX = 20
/** A cut whose folder is unreachable waits this long for the folder to come back. */
export const TRASH_WAIT_DAYS = 30
/** Longer than this, the toast says "đang chuyển…" first (with Hoàn tác), then gives the result. */
export const TRASH_SLOW_MS = 600

/** One take → folder pair. */
export interface SaveLinkPair {
  folderId: string
  takeId: string
}

const takeLists = (folders: readonly SaveFolder[] | undefined) => new Map((folders ?? []).map((f) => [f.id, new Set(f.takes ?? [])]))

/**
 * 'save' wires in `from` that `to` no longer has — only for folder nodes present in both (a node removed / added with
 * its wires is not a cut). Folder order, then take order.
 */
function diffSaveLinks(from: readonly SaveFolder[] | undefined, to: readonly SaveFolder[] | undefined): SaveLinkPair[] {
  const toLists = takeLists(to)
  const out: SaveLinkPair[] = []
  for (const f of from ?? []) {
    const still = toLists.get(f.id)
    if (!still) continue
    for (const takeId of f.takes ?? []) if (!still.has(takeId)) out.push({ folderId: f.id, takeId })
  }
  return out
}

/** 'save' wires an undo / redo jump cut (in `before`, gone in `after`). */
export function removedSaveLinks(before: readonly SaveFolder[] | undefined, after: readonly SaveFolder[] | undefined): SaveLinkPair[] {
  return diffSaveLinks(before, after)
}

/** 'save' wires an undo / redo jump brought back (gone in `before`, in `after`). */
export function addedSaveLinks(before: readonly SaveFolder[] | undefined, after: readonly SaveFolder[] | undefined): SaveLinkPair[] {
  return diffSaveLinks(after, before)
}

/** `items` in batches of at most `max` (one Delete may cut hundreds of wires into one folder). */
export function trashBatches<T>(items: readonly T[], max = TRASH_BATCH_MAX): T[][] {
  const size = Math.max(1, Math.floor(max))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const FILE_RESULTS = new Set(['trashed', 'missing', 'changed', 'failed'])

/**
 * A files:trashSaved answer checked value by value: one result per asked take (the first one; answers for takes not
 * asked are dropped; a malformed file entry makes that take unanswered). `unanswered`: asked takes without a valid
 * answer (treated as failed: nothing is known to have moved).
 */
export function checkTrashAnswer(raw: unknown, asked: readonly string[]): { results: TrashSavedTakeResult[]; unanswered: string[] } {
  const want = new Set(asked)
  const got = new Map<string, TrashSavedTakeResult>()
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const x = r as Record<string, unknown>
    if (typeof x.takeId !== 'string' || !want.has(x.takeId) || got.has(x.takeId)) continue
    if (!Array.isArray(x.files)) continue
    const files: TrashSavedFile[] = []
    let ok = true
    for (const f of x.files as unknown[]) {
      const ff = f as Record<string, unknown> | null
      if (!ff || typeof ff !== 'object' || typeof ff.name !== 'string' || (ff.role !== 'primary' && ff.role !== 'companion') || !FILE_RESULTS.has(ff.result as string)) {
        ok = false
        break
      }
      const file: TrashSavedFile = { name: ff.name.slice(0, 300), role: ff.role, result: ff.result as TrashFileResult }
      // Only next to 'failed' (main: an online-only file kept without being read).
      if (ff.cloud === true && file.result === 'failed') file.cloud = true
      files.push(file)
    }
    if (!ok) continue
    const out: TrashSavedTakeResult = { takeId: x.takeId, files }
    if (x.unknown === true) out.unknown = true
    if (x.unknown === true && x.elsewhere === true) out.elsewhere = true
    got.set(x.takeId, out)
  }
  return { results: asked.filter((t) => got.has(t)).map((t) => got.get(t)!), unanswered: asked.filter((t) => !got.has(t)) }
}

/**
 * What happened to the saved files of one video taken off a folder:
 *   trashed     at least one copy moved to the Recycle Bin
 *   changed     kept: modified after it was saved (it is the user's now)
 *   missing     nothing found where it was saved (renamed / moved / deleted): nothing touched
 *   failed      could not be moved (open in another program, no / full / disabled Recycle Bin…): kept, "Thử lại"
 *   cloud       kept: only in the cloud (a OneDrive "online-only" file, not on this disk; reading it would download it)
 *   unknown     saved by an older SanoVids (no record of which file the wire wrote): kept
 *   elsewhere   saved into the node's previous folder: kept
 *   queued      the folder cannot be reached now: moved when it is back (≤ TRASH_WAIT_DAYS)
 *   pick        the folder was not chosen on this computer: kept
 *   noBlob      SanoVids no longer has this video: the copy in the folder is kept (never the last copy)
 *   preexisting the wire copied nothing (the file was already there): kept
 *   unsaved     never saved there
 *   linked      its scene's auto-save wire still points at the folder: kept
 *   off         the setting is off / the web app: nothing moved (today's wording)
 *   skip        say nothing (wired again meanwhile, video or folder node deleted in the same step)
 */
export type UnlinkKind =
  | 'trashed'
  | 'changed'
  | 'missing'
  | 'failed'
  | 'cloud'
  | 'unknown'
  | 'elsewhere'
  | 'queued'
  | 'pick'
  | 'noBlob'
  | 'preexisting'
  | 'unsaved'
  | 'linked'
  | 'off'
  | 'skip'

/** One unlinked take, for the toasts. */
export interface UnlinkOutcome {
  kind: UnlinkKind
  /** takeLabel, e.g. "S01·T1". */
  code: string
  /** folder.name */
  folder: string
  /** trashed: copies (primary files) moved. */
  copies?: number
  /** trashed: files moved (videos / posters + prompt .txt). */
  files?: number
  /** The file the toast names: the copy moved (trashed), kept (changed) or not moved (failed). */
  name?: string
  /** trashed, one copy: its prompt .txt went too. */
  withTxt?: boolean
  /** trashed: a prompt .txt was kept because it was modified. */
  txtKept?: boolean
  /** trashed: some file of this take could not be moved (retry possible). */
  someFailed?: number
}

/** Kind, counts and names of one take's answer (files of all its groups: each companion follows its primary). */
export interface ResultOutcome {
  kind: 'trashed' | 'changed' | 'missing' | 'failed' | 'cloud' | 'unknown' | 'elsewhere'
  /** Copies (primary files) moved by this call. */
  copies: number
  files: number
  name?: string
  withTxt: boolean
  txtKept: boolean
  /** Files that could not be moved and may be retried (also next to 'trashed'; online-only files are not counted). */
  failed: number
  /** Online-only files kept without being read (cloud). */
  cloud: number
  /**
   * The answer holds the rest of a copy whose video went to the Recycle Bin in an EARLIER call (its prompt .txt could
   * not follow then; "Thử lại" sends the group again and only the .txt is answered): a video of this take is in the
   * Recycle Bin even when this call moved nothing (Hoàn tác must write a copy again).
   */
  earlier: boolean
  /** Names of the files moved to the Recycle Bin. */
  trashedNames: string[]
}

/**
 * One take's answer summed up. The main process lists each group's primary, then its companions — only after a
 * 'trashed' primary; a group whose primary was moved by an earlier call answers its companions alone. So a companion
 * belongs to the group before it only when that group's primary was moved (or the group is such a rest itself);
 * otherwise it starts a rest of its own.
 */
export function outcomeOfResult(r: TrashSavedTakeResult): ResultOutcome {
  const base: ResultOutcome = { kind: 'missing', copies: 0, files: 0, withTxt: false, txtKept: false, failed: 0, cloud: 0, earlier: false, trashedNames: [] }
  if (r.unknown) return { ...base, kind: r.elsewhere ? 'elsewhere' : 'unknown' }
  const files = Array.isArray(r.files) ? r.files : []
  const groups: { primary: TrashSavedFile | null; companions: TrashSavedFile[] }[] = []
  for (const f of files) {
    const last = groups[groups.length - 1]
    if (f.role === 'primary') groups.push({ primary: f, companions: [] })
    else if (last && (!last.primary || last.primary.result === 'trashed')) last.companions.push(f)
    else groups.push({ primary: null, companions: [f] })
  }
  const trashed = files.filter((f) => f.result === 'trashed')
  base.files = trashed.length
  base.trashedNames = trashed.map((f) => f.name)
  base.failed = files.filter((f) => f.result === 'failed' && !f.cloud).length
  base.cloud = files.filter((f) => f.result === 'failed' && f.cloud).length
  const rests = groups.filter((g) => !g.primary)
  base.earlier = rests.length > 0
  const moved = groups.filter((g) => g.primary?.result === 'trashed')
  base.copies = moved.length
  if (moved.length) {
    base.kind = 'trashed'
    base.name = moved[0].primary!.name
    base.withTxt = moved.length === 1 && moved[0].companions.some((c) => c.result === 'trashed')
    base.txtKept = groups.some((g) => g.companions.some((c) => c.result === 'changed'))
    return base
  }
  const restFiles = rests.flatMap((g) => g.companions)
  const restMoved = restFiles.find((c) => c.result === 'trashed')
  if (restMoved) return { ...base, kind: 'trashed', name: restMoved.name, txtKept: restFiles.some((c) => c.result === 'changed') }
  // Nothing moved: what to say about the first file that matters (primaries first, then the rest of an earlier copy).
  const candidates = [...groups.flatMap((g) => (g.primary ? [g.primary] : [])), ...restFiles]
  const first = (test: (f: TrashSavedFile) => boolean) => candidates.find(test)
  const failed = first((f) => f.result === 'failed' && !f.cloud)
  if (failed) return { ...base, kind: 'failed', name: failed.name }
  const cloud = first((f) => f.result === 'failed' && !!f.cloud)
  if (cloud) return { ...base, kind: 'cloud', name: cloud.name }
  const changed = first((f) => f.result === 'changed')
  if (changed) return { ...base, kind: 'changed', name: changed.name }
  return base
}

export type TrashToastTone = 'info' | 'success' | 'warning' | 'error'

export interface TrashToast {
  text: string
  tone: TrashToastTone
  ms?: number
  /** Offer "Thử lại" (instead of "Hoàn tác"). */
  retry?: boolean
}

const unlinked = (o: UnlinkOutcome) => `Đã bỏ nối ${o.code} khỏi “${o.folder}”`

/** The toast of one video taken off a folder (every sentence of plan §3.2.7). null = say nothing. */
export function unlinkToast(o: UnlinkOutcome): TrashToast | null {
  switch (o.kind) {
    case 'trashed': {
      const copies = o.copies ?? 1
      let text: string
      if (copies > 1) text = `${unlinked(o)} và chuyển ${copies} bản (${o.files ?? copies} file) vào Thùng rác.`
      else if (o.txtKept) text = `${unlinked(o)} và chuyển “${o.name}” vào Thùng rác; giữ file prompt .txt vì đã bị sửa.`
      else if (o.withTxt) text = `${unlinked(o)} và chuyển “${o.name}” và file prompt .txt vào Thùng rác.`
      else text = `${unlinked(o)} và chuyển “${o.name}” vào Thùng rác.`
      if (copies > 1 && o.txtKept) text = text.slice(0, -1) + '; giữ file prompt .txt đã bị sửa.'
      if (o.someFailed) return { text: `${text} Còn ${o.someFailed} file chưa chuyển được (đang mở trong chương trình khác?).`, tone: 'warning', ms: 12000, retry: true }
      return { text, tone: 'success' }
    }
    case 'changed':
      return { text: `${unlinked(o)}. Giữ lại “${o.name}” vì file đã bị sửa sau khi lưu.`, tone: 'warning', ms: 9000 }
    case 'missing':
      return { text: `${unlinked(o)}. Không thấy file đã lưu trong thư mục (đã đổi tên, chuyển hoặc xoá?) nên không xoá gì.`, tone: 'info' }
    case 'cloud':
      return { text: `${unlinked(o)}. Giữ “${o.name ?? 'file đã lưu'}” vì file đang chỉ có trên OneDrive (chưa tải về máy).`, tone: 'info' }
    case 'unknown':
      return {
        text: `${unlinked(o)}. File của video này được lưu từ bản SanoVids cũ nên không chắc là file nào — đã giữ lại, xoá tay nếu cần.`,
        tone: 'info',
        ms: 9000,
      }
    case 'elsewhere':
      return { text: `${unlinked(o)}. File đã lưu nằm ở thư mục cũ của node này nên SanoVids không xoá.`, tone: 'info' }
    case 'failed':
      return {
        text: `${unlinked(o)} nhưng không chuyển được “${o.name ?? 'file đã lưu'}” vào Thùng rác (file đang mở trong chương trình khác, hoặc Thùng rác của ổ này đang tắt / đầy / không có). File vẫn còn.`,
        tone: 'warning',
        ms: 12000,
        retry: true,
      }
    case 'queued':
      return { text: `${unlinked(o)}. Thư mục đang không mở được — file sẽ vào Thùng rác khi thư mục có lại.`, tone: 'info' }
    case 'pick':
      return { text: `${unlinked(o)}. Thư mục chưa được chọn trên máy này nên SanoVids không xoá được file — xoá tay nếu cần.`, tone: 'info' }
    case 'noBlob':
      return { text: `${unlinked(o)}. Giữ file trong thư mục vì SanoVids không còn bản video này.`, tone: 'info' }
    case 'preexisting':
      return { text: `${unlinked(o)}. File trong thư mục có từ trước khi nối dây này nên được giữ.`, tone: 'info' }
    case 'unsaved':
      return { text: `Đã bỏ nối ${o.code} khỏi thư mục “${o.folder}”.`, tone: 'info' }
    case 'linked':
      return { text: `Đã bỏ nối ${o.code} khỏi thư mục “${o.folder}” (file đã lưu vẫn còn: cảnh của video này vẫn tự lưu vào thư mục này).`, tone: 'info' }
    case 'off':
      return { text: offUnlinkText(o.code, o.folder), tone: 'info' }
    default:
      return null
  }
}

/** Setting off / web app: the wording from before the feature (nothing is moved). */
export function offUnlinkText(code: string, folder: string): string {
  return `Đã bỏ nối ${code} khỏi thư mục “${folder}” (file đã lưu vẫn còn).`
}

/** Added to the first toast that moved a file (key bdp:hint:folder-trash; shown again after "Khôi phục cài đặt mặc định"). */
export const TRASH_FIRST_HINT = 'Tắt ở Cài đặt → Tải video.'
export const TRASH_HINT_KEY = 'bdp:hint:folder-trash'

/** Shown at once when moving takes longer than TRASH_SLOW_MS (with Hoàn tác), replaced by the result. */
export function trashingToastText(code: string, folder: string): string {
  return `Đã bỏ nối ${code} khỏi “${folder}” — đang chuyển file vào Thùng rác…`
}

const plural = (n: number, one: string) => `${n} ${one}`

/**
 * The extra toast after a Delete (or an undo / redo) that took several videos off folders: what went to the Recycle
 * Bin, then what was kept. null when there is nothing worth saying (nothing was saved there, setting off…).
 */
export function trashSummaryText(outcomes: readonly UnlinkOutcome[]): TrashToast | null {
  const count = (k: UnlinkKind) => outcomes.filter((o) => o.kind === k).length
  const moved = outcomes.filter((o) => o.kind === 'trashed')
  const files = moved.reduce((n, o) => n + (o.files ?? o.copies ?? 1), 0)
  const notes: string[] = []
  const changed = count('changed')
  const missing = count('missing')
  const unknown = count('unknown') + count('elsewhere')
  const failed = count('failed') + moved.reduce((n, o) => n + (o.someFailed ? 1 : 0), 0)
  const cloud = count('cloud')
  const queued = count('queued')
  const pick = count('pick')
  const pre = count('preexisting')
  const kept = count('noBlob') + count('linked')
  if (changed) notes.push(`giữ ${plural(changed, 'file')} đã bị sửa`)
  if (missing) notes.push(`${plural(missing, 'file')} không thấy`)
  if (unknown) notes.push(`${plural(unknown, 'file')} lưu từ bản cũ (giữ lại)`)
  if (failed) notes.push(`${plural(failed, 'file')} chưa chuyển được (đang mở trong chương trình khác?)`)
  if (cloud) notes.push(`${plural(cloud, 'file')} chỉ có trên OneDrive (giữ lại)`)
  if (queued) notes.push(`${plural(queued, 'video')} chờ thư mục có lại`)
  if (pick) notes.push(`${plural(pick, 'video')} ở thư mục chưa chọn trên máy này (giữ lại)`)
  if (pre) notes.push(`${plural(pre, 'video')} có file từ trước khi nối (giữ lại)`)
  if (kept) notes.push(`giữ file của ${plural(kept, 'video')}`)
  if (!moved.length && !notes.length) return null
  const names = [...new Set(outcomes.filter((o) => o.kind !== 'skip' && o.kind !== 'off' && o.kind !== 'unsaved').map((o) => o.folder))]
  const where = names.length === 1 ? `thư mục “${names[0]}”` : `${names.length} thư mục`
  const head = moved.length
    ? `Đã chuyển ${moved.length} video (${files} file) đã lưu vào Thùng rác (${where})`
    : `Không chuyển file đã lưu nào vào Thùng rác (${where})`
  const text = `${head}${notes.map((n) => ` · ${n}`).join('')}.`
  if (failed) return { text, tone: 'warning', ms: 12000, retry: true }
  if (changed) return { text, tone: 'warning', ms: 9000 }
  return { text, tone: moved.length ? 'success' : 'info', ms: notes.length ? 9000 : undefined }
}

/** Question before a Delete that would move the saved files of ≥ TRASH_CONFIRM_MIN videos (Cancel = nothing changes). */
export function trashConfirmText(videos: number, folderNames: readonly string[]): string {
  const names = [...new Set(folderNames)]
  const from = names.length === 1 ? `thư mục “${names[0]}”` : `${names.length} thư mục`
  return `Bỏ nối ${videos} video khỏi ${from} và chuyển các file SanoVids đã lưu của chúng vào Thùng rác của Windows?`
}

/** "Huỷ" at that question after an undo / redo: the jump stays, every saved file stays where it is. */
export function trashKeptText(videos: number): string {
  return `Đã giữ nguyên các file đã lưu của ${videos} video (không chuyển vào Thùng rác).`
}

/** Deleting a video while its cut wire's files are being moved to the Recycle Bin: it waits (never the last copy). */
export function trashBusyDeleteText(what: string): string {
  return `Chưa xoá ${what}: SanoVids đang chuyển file đã lưu vào Thùng rác — thử lại sau giây lát.`
}

/** After Hoàn tác / Ctrl+Z brought back a wire whose files went to the Recycle Bin: a new copy was (not) written. */
export function restoreToastText(ok: boolean, code: string, folder: string, reason?: string): string {
  return ok
    ? `Đã lưu lại ${code} vào “${folder}” (bản cũ vẫn nằm trong Thùng rác).`
    : `Không lưu lại được ${code} vào “${folder}”: ${reason || 'lỗi không rõ'}. Bản cũ vẫn nằm trong Thùng rác của Windows — mở Thùng rác để khôi phục.`
}

/** The folder came back: what waited for it went to the Recycle Bin. */
export function trashFlushText(files: number, folder: string): string {
  return `Đã chuyển ${files} file chờ xoá vào Thùng rác (thư mục “${folder}”).`
}

/** "Lưu thêm bản nữa" (an old toast) or a waiting save whose wire was cut meanwhile: nothing is written. */
export function notLinkedText(code: string, folder: string): string {
  return `${code} không còn nối với “${folder}” — nối lại để lưu.`
}

// ---------------- Settings, wires, folder node ----------------
/** Cài đặt → Cơ bản → Tải video, after "Kèm file .txt chứa prompt" (SettingsDialog GROUPS; also the search tests). */
export const FOLDER_UNLINK_TRASH_ROW = {
  label: 'Bỏ nối video khỏi Thư mục thì chuyển file vào Thùng rác',
  hint: 'Cắt dây video → Thư mục trên canvas sẽ chuyển file video (và file .txt prompt đi kèm) mà SanoVids đã lưu ở đó vào Thùng rác của Windows. Chỉ file mà chính dây đó đã chép (từ bản này) và chưa bị sửa; bấm Hoàn tác để lưu lại. Xoá video, xoá cảnh, bỏ node Thư mục hay cắt dây tự lưu của cảnh không xoá file nào.',
  keywords: 'xoá xóa file thùng rác recycle bin bỏ nối cắt dây thư mục gỡ đồng bộ',
} as const

/** Added to the row's hint in a browser (the switch is shown off and disabled there). */
export const FOLDER_UNLINK_TRASH_WEB_NOTE = 'Chỉ có trong app desktop (trình duyệt không có Thùng rác).'

/** Added to the hint of "Bấm vào dây để cắt". */
export const CLICK_TO_CUT_TRASH_NOTE = 'Dây video → Thư mục còn chuyển file đã lưu vào Thùng rác nếu bật ở “Tải video”.'

/** Tooltip of a take → folder wire (`trash`: the setting is on, in the desktop app). */
export function saveWireTitle(clickToCut: boolean, trash: boolean): string {
  if (!trash) return clickToCut ? 'Bấm để bỏ nối · Ctrl/Shift + bấm: chọn dây' : 'Bấm để chọn dây · Delete: bỏ nối'
  return clickToCut
    ? 'Bấm để bỏ nối và chuyển file đã lưu vào Thùng rác · Ctrl/Shift + bấm: chọn dây'
    : 'Bấm để chọn dây · Delete: bỏ nối và chuyển file đã lưu vào Thùng rác'
}

/** Title of the × on a take → folder wire when the setting is on (desktop app). */
export const SAVE_CUT_BUTTON_TITLE = 'Bỏ nối và chuyển file đã lưu vào Thùng rác (Delete)'

/** Folder node status while files are being moved. */
export const FOLDER_TRASHING_TEXT = 'Đang chuyển file vào Thùng rác…'

/** Folder node status suffix: cut wires whose files wait for the folder to come back. */
export function trashPendingSuffix(n: number): string {
  return n > 0 ? ` · ${n} file chờ xoá` : ''
}

/**
 * Folder node status suffix (this session): cut wires whose files waited longer than TRASH_WAIT_DAYS for the folder —
 * no longer moved; the files stay (their record was released, a wire made later never claims them).
 */
export function trashExpiredSuffix(n: number): string {
  return n > 0 ? ` · ${n} video chờ xoá quá ${TRASH_WAIT_DAYS} ngày (đã giữ file)` : ''
}

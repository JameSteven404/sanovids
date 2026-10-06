// Desktop app file bridge (window.bdpDesktop.files, electron/preload.cjs → electron/main.cjs "files:*" IPC).
// The renderer never names a path to write to on its own: a save dialog picks it (saveAs), or the folder must be one
// the user picked in this app (pickFolder → the main process allowlist). Missing in browsers and older desktop builds.

/** One file sent to the main process: binary (`bytes`) or text (`text`, written as UTF-8). */
export interface DesktopFile {
  name: string
  bytes?: Uint8Array
  text?: string
}

/** Every call answers { ok: false, code, message } instead of throwing. `canceled`: the user closed the dialog. */
export interface DesktopFail {
  ok: false
  code: string
  message: string
  canceled?: boolean
}

/**
 * Where a folder write comes from (folder nodes, lib/saveFolders.ts → folderActions):
 *   'link'     a take → folder ('save') wire copying its take (wired, or the take finished / the folder came back);
 *   'again'    "Lưu thêm bản nữa" while that wire exists;
 *   'restore'  the copy written again after Hoàn tác / Ctrl+Z brought back a cut wire whose files went to the Recycle Bin;
 *   'autosave' a scene → folder ('autosave') wire (never moved to the Recycle Bin: the main process refuses it);
 *   'manual'   any other write into a folder node.
 */
export type SaveVia = 'link' | 'again' | 'restore' | 'autosave' | 'manual'

/**
 * Who a folder write belongs to. The main process records the written group (names, sizes, SHA-256) in its own
 * ledger (userData/saved-files.json) under these ids; only such recorded groups can later be moved to the Recycle Bin.
 * folderId / takeId: /^[A-Za-z0-9_-]{1,100}$/ (anything else → the write still happens, nothing is recorded).
 */
export interface SaveOwner {
  folderId: string
  takeId: string
  via: SaveVia
}

/** Result of a folder write (`names`: the names really written, " (2)" included). */
export interface WriteToFolderOk {
  ok: true
  names: string[]
  /**
   * Id of the ledger group (16 hex chars) when the write was recorded under `owner`. false = written but not
   * recorded (ledger error); missing = no valid `owner` or an older desktop build. Anything but a string = not recorded.
   */
  recorded?: string | false
}

/** One take whose cut wire should take its files along: only the ledger groups this wire wrote (≤ 20 per take). */
export interface TrashSavedItem {
  takeId: string
  /** Ledger group ids (`recorded` of the writes), 1–20 per item, 16 hex chars each. */
  groupIds: string[]
}

/** Arguments of trashSaved: one allowlisted folder node, 1–200 items with distinct take ids per call. */
export interface TrashSavedArgs {
  folderPath: string
  folderId: string
  items: TrashSavedItem[]
}

/** 'primary': the video (or the poster .jpg written without one); 'companion': the prompt .txt written with it. */
export type TrashFileRole = 'primary' | 'companion'

/**
 * What happened to one recorded file:
 *   'trashed' moved to the Recycle Bin (shell.trashItem; never deleted for good);
 *   'missing' no longer there (renamed / moved / deleted): nothing touched;
 *   'changed' not the file SanoVids wrote (other size / SHA-256, a link, not a regular file): kept, it is the user's now;
 *   'failed'  could not be moved (in use, no Recycle Bin on that drive, hashing timed out…): kept, retry possible.
 * A companion is only moved when its primary was 'trashed' and the companion itself is unchanged.
 */
export type TrashFileResult = 'trashed' | 'missing' | 'changed' | 'failed'

export interface TrashSavedFile {
  name: string
  role: TrashFileRole
  result: TrashFileResult
  /**
   * With 'failed': the file is only in the cloud (a OneDrive "online-only" file: no data on this disk). It is kept
   * without being read (hashing it would download it); the ledger keeps its entry. Missing in other answers.
   */
  cloud?: true
}

/**
 * Outcome for one item. `unknown`: none of its groupIds is a recorded group of this folder node / take (saved by an
 * older build, ledger lost) → nothing touched; `elsewhere` (with `unknown`): those groups were written into another
 * folder (the node now points elsewhere) → nothing touched.
 */
export interface TrashSavedTakeResult {
  takeId: string
  unknown?: boolean
  elsewhere?: boolean
  files: TrashSavedFile[]
}

export interface TrashSavedResult {
  ok: true
  results: TrashSavedTakeResult[]
}

export interface DesktopFilesBridge {
  /** Folder picker (openDirectory). The chosen folder joins the main process allowlist. */
  pickFolder(): Promise<{ ok: true; path: string; name: string } | DesktopFail>
  /** Is this folder writable here: picked on this computer (allowed) and still there (exists)? */
  folderStatus(args: { folderPath: string }): Promise<{ ok: true; allowed: boolean; exists: boolean } | DesktopFail>
  /**
   * Write a group of files into an allowlisted folder, never overwriting (" (2)" for the whole group). With `owner`
   * the main process records the group in its ledger before answering (`recorded`).
   */
  writeToFolder(args: { folderPath: string; files: DesktopFile[]; owner?: SaveOwner }): Promise<WriteToFolderOk | DesktopFail>
  /**
   * Move files the main process itself wrote for these takes (ledger groups `groupIds`, this folder node, never
   * 'autosave' writes) to the Recycle Bin — only files still exactly as written. Never deletes anything for good.
   * Fails: 'bad-request' (arguments), 'not-allowed' (folder not picked on this computer), 'missing' (folder gone).
   * Optional: older desktop builds lack it — callers check `typeof bridge.trashSaved === 'function'`.
   */
  trashSaved?(args: TrashSavedArgs): Promise<TrashSavedResult | DesktopFail>
  /** Show an allowlisted folder in Explorer / Finder. */
  openFolder(args: { folderPath: string }): Promise<{ ok: true } | DesktopFail>
  /**
   * Native "Save as" dialog for files[0] (name / place chosen by the user); the other files (the prompt .txt) are
   * written next to it with the chosen base name, never overwriting. → the chosen path and the names written.
   */
  saveAs(args: { suggestedName: string; title?: string; files: DesktopFile[] }): Promise<{ ok: true; path: string; names: string[] } | DesktopFail>
}

/** The bridge, or null in a browser / an older desktop build. */
export function desktopFiles(): DesktopFilesBridge | null {
  if (typeof window === 'undefined') return null
  const files = (window as { bdpDesktop?: { files?: DesktopFilesBridge } }).bdpDesktop?.files
  return files && typeof files.writeToFolder === 'function' ? files : null
}

/** Files (blobs / text) in the shape the bridge takes. */
export async function toDesktopFiles(files: readonly { name: string; data: Blob | string }[]): Promise<DesktopFile[]> {
  const out: DesktopFile[] = []
  for (const f of files) {
    if (typeof f.data === 'string') out.push({ name: f.name, text: f.data })
    else out.push({ name: f.name, bytes: new Uint8Array(await f.data.arrayBuffer()) })
  }
  return out
}

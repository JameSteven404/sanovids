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

export interface DesktopFilesBridge {
  /** Folder picker (openDirectory). The chosen folder joins the main process allowlist. */
  pickFolder(): Promise<{ ok: true; path: string; name: string } | DesktopFail>
  /** Is this folder writable here: picked on this computer (allowed) and still there (exists)? */
  folderStatus(args: { folderPath: string }): Promise<{ ok: true; allowed: boolean; exists: boolean } | DesktopFail>
  /** Write a group of files into an allowlisted folder, never overwriting (" (2)" for the whole group). */
  writeToFolder(args: { folderPath: string; files: DesktopFile[] }): Promise<{ ok: true; names: string[] } | DesktopFail>
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

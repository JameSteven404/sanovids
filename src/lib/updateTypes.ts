// Shared contract of the desktop auto-updater: electron/updater.cjs (main) ⇄ electron/preload.cjs ⇄ renderer.
// Plain data only. Main validates every call; the renderer validates every state it receives (updateModel.parseUpdateState).
export type UpdateKind = 'installer' | 'portable' | 'dev'
export type UpdateStatus = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported'
/**
 * 'signature': the update is NOT signed by a pinned certificate (another signer, a modified file, no signature) — it was
 * refused. 'signature-unverified': the check itself could not decide (PowerShell blocked or too slow, unexpected chain,
 * no pin) — nothing was installed, "Thử lại" checks again. Builds before the split send 'signature' for both.
 */
export type UpdateErrorCode =
  | 'offline'
  | 'no-release'
  | 'rate-limited'
  | 'checksum'
  | 'signature'
  | 'signature-unverified'
  | 'disk'
  | 'install-failed'
  | 'failed'
export type UpdateResultCode = UpdateErrorCode | 'not-allowed' | 'bad-request' | 'unsupported' | 'busy' | 'not-ready'
export interface UpdateError { code: UpdateErrorCode; message: string }
/** One-shot news of this launch, computed by main at startup from userData/updater.json. */
export type UpdateNotice = { kind: 'updated'; from: string; version: string } | { kind: 'install-failed'; version: string }
export interface UpdateState {
  kind: UpdateKind
  /** Running version (app.getVersion()). */
  current: string
  status: UpdateStatus
  /** Newer version: set with available / downloading / ready, and with error after a failed download. */
  version?: string
  /** ISO date of that release (latest.yml releaseDate). */
  releaseDate?: string
  /** Release notes as PLAIN TEXT (markdown-ish, never HTML), at most UPDATE_NOTES_MAX chars. */
  notes?: string
  /** Full installer size in bytes (latest.yml files[0].size). */
  size?: number
  /** While downloading (percent 0..100; ready may keep 100). */
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  /** Set with status 'error'; with 'ready' after a failed install attempt (code 'install-failed'). */
  error?: UpdateError
  /** Epoch ms when the last check finished (success or failure). */
  lastCheck?: number
  /** Main's copy of the device pref (renderer lib/updatePrefs is the source of truth and pushes it). */
  autoDownload: boolean
  notice?: UpdateNotice
}
export type UpdateResult = { ok: true } | { ok: false; code: UpdateResultCode; message: string }
export interface UpdatePrefsArg { autoDownload: boolean }
/** window.bdpDesktop.updates (electron/preload.cjs) — and the simulated bridge of development mode (providers/dev/updates.ts). */
export interface DesktopUpdatesBridge {
  getState(): Promise<UpdateState>
  check(): Promise<UpdateResult>
  download(): Promise<UpdateResult>
  install(): Promise<UpdateResult>
  setPrefs(prefs: UpdatePrefsArg): Promise<UpdateResult>
  openReleasePage(): Promise<UpdateResult>
  onState(listener: (state: UpdateState) => void): () => void
}
export const UPDATE_NOTES_MAX = 8000
/** Shown as text only; the renderer never opens URLs itself (main opens its own constant). */
export const UPDATE_RELEASES_PAGE_LABEL = 'github.com/JameSteven404/sanovids-releases'

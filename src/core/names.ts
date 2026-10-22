// Names of assets, folder nodes and presets, normalised ONE way: by the store when one is made or renamed
// (store/project) and by migrate when a project is read back (core/migrate, core/folders) — so a save + reopen never
// changes a name (Test giới hạn D1: "Dự án đọc lại khác bản đang mở"). Pure, no store import.

/** The name of an asset that has none (blank / missing). */
export const UNNAMED_ASSET = 'Không tên'
/** The name of a folder node with neither a name nor a folder path. */
export const UNNAMED_FOLDER = 'Thư mục'
/** The name of a preset that has none (read back only: the store keeps the old name on a blank rename). */
export const UNNAMED_PRESET = 'Preset'
/** Longest folder node name kept (code points). */
export const FOLDER_NAME_MAX = 120

const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** An asset's name: kept as typed when it has a visible character (never trimmed — it never was), else "Không tên". */
export function normalizeAssetName(v: unknown): string {
  const s = asText(v)
  return s.trim() ? s : UNNAMED_ASSET
}

/** "C:\Users\me\Videos\Phim A" / "/home/me/Phim A/" → "Phim A" ('' when there is none). */
export function folderBaseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * A folder node's name: trimmed, at most FOLDER_NAME_MAX code points (never half an emoji; trimmed again after the
 * cut, so reading it back changes nothing); blank → the picked folder's own name (`path`), else "Thư mục".
 */
export function normalizeFolderName(name: unknown, path?: string | null): string {
  const raw = typeof name === 'string' && name.trim() ? name : typeof path === 'string' && path ? folderBaseName(path) : ''
  return Array.from(raw.trim()).slice(0, FOLDER_NAME_MAX).join('').trim() || UNNAMED_FOLDER
}

/** A preset's name: trimmed; blank → "Preset". */
export function normalizePresetName(v: unknown): string {
  return asText(v).trim() || UNNAMED_PRESET
}

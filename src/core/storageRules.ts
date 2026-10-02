// Pure rules behind the local persistence (store/persist.ts), kept here so they are unit-tested.
//
// Several tabs/windows of the web app share one IndexedDB. Every write of a project (or its runs) also writes a
// revision stamp `rev:<projectId>`. A tab remembers the revision its copy is based on; when the stored stamp was
// written by another tab after that, this tab's copy is stale and must not be written over the newer data.

/** Revision stamp stored next to a project. `deleted` = tombstone left by deleteProject. */
export interface RevStamp {
  rev: number
  /** Id of the tab (page load) that wrote it. */
  tab: string
  at: number
  deleted?: boolean
}

/**
 * Did another tab write (or delete) the project since this tab loaded or last saved it?
 * `baseRev` = revision this tab's copy is based on (null = loaded before the project had a stamp).
 * The latest write being this tab's own is never a conflict (nobody wrote after it).
 */
export function isForeignWrite(stored: RevStamp | null | undefined, baseRev: number | null, tabId: string): boolean {
  if (!stored) return false
  if (stored.deleted) return true
  if (stored.tab === tabId) return false
  return stored.rev !== baseRev
}

export function nextStamp(stored: RevStamp | null | undefined, tabId: string, now = Date.now()): RevStamp {
  return { rev: (stored?.rev ?? 0) + 1, tab: tabId, at: now }
}

/** Emergency copy of a project (localStorage) written when the page is hidden/closed with unsaved edits. */
export interface BackupInfo {
  /** Revision the backed-up copy was based on (undefined = old single-slot backup without revision). */
  baseRev?: number | null
  tab?: string
}

/**
 * Should a backup replace the stored project? Yes when nothing was written since the copy it is based on, or when
 * the only writes since were made by the same tab (backups are removed as soon as an equal or newer save
 * succeeds, so a remaining one holds the newest edits). Never over another tab's newer write or a deleted project.
 */
export function backupWins(backup: BackupInfo, stored: RevStamp | null | undefined): boolean {
  if (stored?.deleted) return false
  if ((stored?.rev ?? null) === (backup.baseRev ?? null)) return true
  return !!stored && !!backup.tab && stored.tab === backup.tab
}

/** Replace/add one entry of the project list (by id), newest first. */
export function upsertById<T extends { id: string; updatedAt: number }>(list: readonly T[] | null | undefined, item: T): T[] {
  return sortByUpdated([...(list ?? []).filter((m) => m.id !== item.id), item])
}

export function sortByUpdated<T extends { updatedAt: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

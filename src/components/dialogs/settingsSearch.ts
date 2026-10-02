// Settings dialog: which groups / rows to show for a level ("Cơ bản" / "Nâng cao") and a search text. Pure (unit-tested
// in ./__tests__/settingsSearch.test.ts). Search ignores case and Vietnamese accents ("am thanh" finds "Âm thanh") and
// looks in BOTH levels; every word typed must appear in the row's label, hint or keywords, or in its group's title.

export type SettingsLevel = 'basic' | 'advanced'
export const SETTINGS_LEVELS: readonly SettingsLevel[] = ['basic', 'advanced']
export const SETTINGS_LEVEL_LABEL: Record<SettingsLevel, string> = { basic: 'Cơ bản', advanced: 'Nâng cao' }

export interface SearchRow {
  id: string
  label: string
  hint?: string
  keywords?: string
}

export interface SearchGroup<R extends SearchRow = SearchRow> {
  id: string
  level: SettingsLevel
  title: string
  /** Searched too (a block group has no rows: its title, description and keywords are all there is). */
  desc?: string
  keywords?: string
  /** Rows; none = a block shown whole (canvasapp gateway, demo credits…). */
  rows?: R[]
}

export interface GroupMatch<G extends SearchGroup> {
  group: G
  /** Rows to show (all of them for a block group: empty list). */
  rows: NonNullable<G['rows']>
}

/** Lowercase, no accents, đ → d (the search key of a text). */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

/** Words of a search text ('' → none). */
export function searchWords(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean)
}

const hasAll = (text: string, words: string[]) => words.every((w) => text.includes(w))

/**
 * Groups and rows to show: without a query, every group of `level` with all its rows; with a query, the matching
 * rows of both levels (a group whose title matches keeps all its rows), groups with nothing left are dropped.
 */
export function matchSettings<G extends SearchGroup>(groups: readonly G[], level: SettingsLevel, query: string): GroupMatch<G>[] {
  const words = searchWords(query)
  const out: GroupMatch<G>[] = []
  for (const group of groups) {
    const rows = (group.rows ?? []) as NonNullable<G['rows']>
    if (!words.length) {
      if (group.level === level) out.push({ group, rows })
      continue
    }
    const head = foldText(`${group.title} ${group.keywords ?? ''}`)
    if (!group.rows) {
      if (hasAll(foldText(`${head} ${group.desc ?? ''}`), words)) out.push({ group, rows })
      continue
    }
    const hit = rows.filter((r) => hasAll(`${head} ${foldText(`${r.label} ${r.hint ?? ''} ${r.keywords ?? ''}`)}`, words)) as NonNullable<G['rows']>
    if (hit.length) out.push({ group, rows: hit })
  }
  return out
}

/** Number of results (a block group counts as one). */
export function resultCount(matches: readonly GroupMatch<SearchGroup>[]): number {
  return matches.reduce((n, m) => n + (m.group.rows ? m.rows.length : 1), 0)
}

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

/**
 * The groups Settings shows (search and deep links included): development mode open → all of them; locked (release
 * builds) → no 'dev' group, and the canvasapp gateway ('gateway', "Nhà cung cấp video") moves to "Cơ bản" in its place —
 * so "phát triển" / "dev" / "giả lập" find nothing and openSettings('dev') is an unknown id.
 */
export function visibleGroups<G extends SearchGroup>(groups: readonly G[], devOpen: boolean): G[] {
  if (devOpen) return [...groups]
  const gateway = groups.find((g) => g.id === 'gateway')
  const out: G[] = []
  for (const g of groups) {
    if (g.id === 'gateway') continue
    if (g.id === 'dev') {
      if (gateway) out.push({ ...gateway, level: 'basic' })
      continue
    }
    out.push(g)
  }
  return out
}

/**
 * The group a deep link should switch the dialog to NOW, or undefined. Only a new request (`section` differs from the
 * one already followed, `followed`; null = none yet) moves the dialog. The same request with other group objects —
 * development mode locking / unlocking moves 'gateway' between the levels — never does: jumping to "Nâng cao" right
 * after an unlock from Giới thiệu would unmount the unlock box and drop its one-time authenticator link offer.
 */
export function deepLinkStep<G extends SearchGroup>(followed: string | undefined | null, section: string | undefined, groups: readonly G[]): G | undefined {
  if (!section || section === followed) return undefined
  return groups.find((g) => g.id === section)
}

/** Number of results (a block group counts as one). */
export function resultCount(matches: readonly GroupMatch<SearchGroup>[]): number {
  return matches.reduce((n, m) => n + (m.group.rows ? m.rows.length : 1), 0)
}

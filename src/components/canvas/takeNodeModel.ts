// Pure texts and rules of the take (video) node's title line and footer (TakeNode.tsx): the line ABOVE the card's
// top-left (code, "+N", the custom file name, DEV, ★ — and the rename input in its place), and the footer that always
// shows the settings. No React, no DOM: unit-tested in __tests__/takeNodeModel.test.ts.

export interface TitleLine {
  chipTitle: string
  /** The custom file name ("Tên file"), only when the user set one; null = just the code. */
  name: string | null
  nameTitle: string | null
  /** The DEV / canvasapp chip (never for old demo takes; hidden while renaming). */
  showProvider: boolean
  /** The ★ button (hidden while renaming: the input needs the room). */
  showStar: boolean
  /** "+N" (other takes of the scene hidden by "Chỉ take chọn"); null = none. */
  moreTitle: string | null
}

/**
 * What the title line shows. Only the user's own name: a default name ("S03_T2 - title") would need the scene title and
 * the name template in every node (two more subscriptions per card).
 */
export function titleLine(p: { code: string; fileName: string | null | undefined; hidden: number; provider: string; renaming: boolean }): TitleLine {
  const name = p.fileName ? p.fileName : null
  return {
    chipTitle: `${p.code} — bấm đúp để đổi tên file video`,
    name,
    nameTitle: name ? `Tên file: ${name}\nBấm đúp để đổi tên` : null,
    showProvider: p.provider !== 'mock' && !p.renaming,
    showStar: !p.renaming,
    moreTitle: p.hidden > 0 ? `${p.hidden} take khác của cảnh này đang ẩn — bấm để xem tất cả` : null,
  }
}

/** The footer's settings label tooltip: the settings (+ the custom file name), and how to rename. */
export function footerTitle(settings: string, fileName: string | null | undefined): string {
  return `${settings}${fileName ? `\nTên file: ${fileName}` : ''}\nBấm đúp để đổi tên file video`
}

/** The ★ button's tooltip. */
export function starTitle(canStar: boolean, starred: boolean): string {
  if (!canStar) return 'Chỉ chọn được take đã tạo xong'
  return starred ? 'Bỏ chọn take này' : 'Chọn take này cho cảnh (★)'
}

/** The title line (and everything in it): the pointer there never starts the hover preview. */
export const TITLE_LINE_SELECTOR = '.cv-take-label'

/** Height of the title line above the card (px; CSS .cv-take-label) and its gap to the card. */
export const TITLE_LINE_H = 13
export const TITLE_LINE_GAP = 4

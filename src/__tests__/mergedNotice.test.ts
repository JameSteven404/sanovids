// D236 (src/mergedNotice.ts, called once by main.tsx): the SanoVids product on its own says once per launch that
// SanoVids moved into Sano Agent, with "Tải Sano Agent" (Sano Agent's download page) and "Để sau". Never in Sano Agent,
// inside SANO or on the web.
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import mainSource from '../main.tsx?raw'
import { Toasts } from '../components/common/Toasts'
import { MERGED_NOTICE_TEXT, SANO_AGENT_RELEASES_URL, showMergedNoticeOnLaunch, showsMergedNotice } from '../mergedNotice'
import { useUI } from '../store/ui'

// Server rendering reads a zustand store's INITIAL state: Toasts gets the live toasts instead (the store stays real).
vi.mock('../store/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/ui')>()
  const hook = <T,>(select: (s: ReturnType<typeof actual.useUI.getState>) => T) => select(actual.useUI.getState())
  return { ...actual, useUI: Object.assign(hook, actual.useUI) }
})

const rules = createRequire(import.meta.url)('../../electron/updater-rules.cjs') as { releasesUrl(name: string): string }

beforeEach(() => {
  useUI.setState({ toasts: [] })
})

describe('SanoVids merged into Sano Agent: the launch notice', () => {
  it('only the SanoVids desktop product on its own', () => {
    expect(showsMergedNotice('SanoVids', false)).toBe(true)
    expect(showsMergedNotice('SanoVidsUpdTest', false)).toBe(true) // a SanoVids test build
    expect(showsMergedNotice('Sano Agent', false)).toBe(false) // its "Mở Canvas" too
    for (const product of ['SanoVids', 'Sano Agent']) expect(showsMergedNotice(product, true), product).toBe(false)
    for (const product of [undefined, '', null, 7]) expect(showsMergedNotice(product, false), String(product)).toBe(false) // web
  })

  it('a persistent toast: "Tải Sano Agent" opens Sano Agent’s download page, "Để sau" closes it', () => {
    const open = vi.fn()
    expect(showMergedNoticeOnLaunch('SanoVids', false, open)).toBe(true)
    const [t] = useUI.getState().toasts
    expect(t).toMatchObject({ text: MERGED_NOTICE_TEXT, tone: 'info', persistent: true, closeLabel: 'Để sau', action: { label: 'Tải Sano Agent' } })
    expect(MERGED_NOTICE_TEXT).toContain('SanoVids đã gộp vào Sano Agent')
    expect(MERGED_NOTICE_TEXT).toContain('Dự án vẫn còn nguyên')
    // the second app quits into the first one (same profile): the notice that starts the move says close + back up
    expect(MERGED_NOTICE_TEXT).toContain('Trước khi mở Sano Agent: đóng SanoVids, sao lưu %APPDATA%\\SanoVids.')
    t.action!.run()
    expect(open).toHaveBeenCalledExactlyOnceWith(SANO_AGENT_RELEASES_URL)
    expect(SANO_AGENT_RELEASES_URL).toBe(rules.releasesUrl('Sano Agent'))
    expect(SANO_AGENT_RELEASES_URL.startsWith('https://')).toBe(true) // main's window-open handler opens https in the browser
  })

  it('Sano Agent, SanoVids inside SANO and the web show nothing', () => {
    const open = vi.fn()
    expect(showMergedNoticeOnLaunch('Sano Agent', false, open)).toBe(false)
    expect(showMergedNoticeOnLaunch('SanoVids', true, open)).toBe(false)
    expect(showMergedNoticeOnLaunch(undefined, false, open)).toBe(false)
    expect(useUI.getState().toasts).toEqual([])
    expect(open).not.toHaveBeenCalled()
  })

  it('the toast shows both buttons; other toasts keep their X', () => {
    showMergedNoticeOnLaunch('SanoVids', false, () => undefined)
    useUI.getState().toast('Đã lưu', { persistent: true })
    const html = renderToStaticMarkup(createElement(Toasts))
    expect(html).toContain('>Tải Sano Agent</button>')
    expect(html).toContain('<button type="button" class="toast-close labelled">Để sau</button>')
    expect(html.match(/aria-label="Đóng thông báo"/g)).toHaveLength(1)
  })

  it('main.tsx asks once per launch, outside React (StrictMode would run an effect twice)', () => {
    expect(mainSource).toContain("import { showMergedNoticeOnLaunch } from './mergedNotice'")
    expect(mainSource.match(/showMergedNoticeOnLaunch\(\)/g)).toHaveLength(1)
    expect(mainSource).toMatch(/^showMergedNoticeOnLaunch\(\)$/m)
  })
})

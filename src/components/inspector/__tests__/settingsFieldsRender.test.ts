// The settings grid as rendered (server-side, no DOM): what the gateway refuses now is shown disabled with the site's
// name, never hidden; a guess is only marked; nothing known → the grid as before. Effects (reads) do not run here.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { VideoSettings } from '../../../core/types'
import { profileIssues } from '../../../providers/canvasapp/mapping'
import type { VideoProfile } from '../../../providers/canvasapp/api'
import { getProvider, registerProvider, useProviderPrefs } from '../../../providers'
import type { SettingsLimits, VideoProvider } from '../../../providers/types'
import { SettingsFields } from '../SettingsFields'

const SD: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 30, resolution: '1080p', ratio: '16:9' }
const H3: VideoSettings = { model: 'minimax_h3', mode: 'i2v', duration: 5, resolution: '768p', ratio: '16:9' }
const PROFILES: VideoProfile[] = [
  { model_profile: 'seedance_2_5', display_name: 'Seedance 2.5', can_create: true, options: { durations: [5, 10, 15] } },
  { model_profile: 'minimax_h3', display_name: 'MiniMax-H3', can_create: false, options: { disabled_modes: [] } },
]

const realDev = getProvider('dev')
afterEach(() => {
  registerProvider(realDev)
  useProviderPrefs.setState({ provider: 'dev' })
})

function render(settings: VideoSettings[], limits?: SettingsLimits): string {
  useProviderPrefs.setState({ provider: 'dev' })
  const p: VideoProvider = { ...realDev, ...(limits ? { settingsLimits: () => limits } : { settingsLimits: undefined }) }
  registerProvider(p)
  return renderToStaticMarkup(
    createElement(SettingsFields, {
      settings,
      presetIds: settings.map(() => null),
      presets: [],
      onPatch: () => undefined,
      onPreset: () => undefined,
      codes: settings.map((_, i) => `S0${i + 1}`),
    }),
  )
}

/** The <option> / segment button whose text starts with `label`. */
const optionOf = (html: string, label: string) => html.match(new RegExp(`<option[^>]*>${label}[^<]*</option>`))?.[0] ?? ''
const segmentOf = (html: string, label: string) => html.match(new RegExp(`<button[^>]*role="radio"[^>]*>${label}</button>`))?.[0] ?? ''

describe('SettingsFields rendered against the gateway’s limits', () => {
  it('a firm read: refused options disabled and tagged with the site, the current value kept, a note with "Đọc lại"', () => {
    const html = render([SD], { source: 'server', firm: true, issues: (s) => profileIssues(s, PROFILES) })
    const h3 = optionOf(html, 'MiniMax-H3')
    expect(h3).toContain('disabled=""')
    expect(h3).toContain('MiniMax-H3 · canvasapp giả lập đang tắt')
    expect(optionOf(html, 'Seedance 2.5')).not.toContain('disabled')
    const thirty = segmentOf(html, '30s')
    expect(thirty).toContain('aria-disabled="true"')
    expect(thirty).toMatch(/class="in-seg-btn on is-off"/) // the scene's saved value stays selected, shown refused
    expect(thirty).toContain('canvasapp giả lập đang tắt: canvasapp không có thời lượng 30s cho Seedance 2.5.')
    expect(segmentOf(html, '15s')).not.toContain('aria-disabled')
    expect(html).toContain('in-field c3 in-seg-field is-refused')
    expect(html).toContain('canvasapp giả lập đang tắt lựa chọn này — cảnh chưa chạy được')
    expect(html).toContain('Đọc lại')
  })

  it('an option turned off that the selection does not use: named in one line with "Đọc lại" (the site may have opened it again)', () => {
    const html = render([{ ...SD, duration: 15 }], { source: 'server', firm: true, issues: (s) => profileIssues(s, PROFILES) })
    expect(optionOf(html, 'MiniMax-H3')).toContain('disabled=""')
    expect(html).not.toContain('cảnh chưa chạy được') // the scene itself is fine: no refusal note
    expect(html).toContain('in-limits-off')
    expect(html).toContain('canvasapp giả lập đang tắt: MiniMax-H3, 30s')
    expect(html).toContain('Đọc lại')
    // nothing off (a guess only marks): no line
    expect(render([{ ...SD, duration: 15 }], { source: 'fallback', firm: false, issues: (s) => profileIssues(s, PROFILES) })).not.toContain('in-limits-off')
  })

  it('several scenes: the note names how many and which (codes); a value fine for some stays pickable', () => {
    const html = render([SD, H3, { ...SD, duration: 5 }], { source: 'server', firm: true, issues: (s) => profileIssues(s, PROFILES) })
    expect(html).toContain('2 cảnh (S01, S02)')
    expect(segmentOf(html, '15s')).not.toContain('aria-disabled') // Seedance can, H3 can
    expect(segmentOf(html, '30s')).toContain('aria-disabled="true"') // only Seedance offers it, refused there
  })

  it('a guess (fallbacks): only marked "có thể bị từ chối", nothing disabled', () => {
    const html = render([H3], { source: 'fallback', firm: false, issues: (s) => profileIssues(s, []) })
    const h3 = optionOf(html, 'MiniMax-H3')
    expect(h3).not.toContain('disabled')
    expect(h3).toContain('· có thể bị từ chối')
    expect(html).toContain('Chưa đọc được cấu hình model từ canvasapp giả lập')
    expect(html).toContain('in-note in-limits-note is-warn')
  })

  it('nothing known (or no settingsLimits): the grid as before — no tag, no note, nothing disabled', () => {
    for (const html of [render([SD, H3]), render([SD, H3], { source: 'none', firm: false, issues: () => [] })]) {
      expect(html).not.toContain('đang tắt')
      expect(html).not.toContain('có thể bị từ chối')
      expect(html).not.toContain('in-limits-note')
      expect(html).not.toContain('aria-disabled')
      expect(optionOf(html, 'MiniMax-H3')).not.toContain('disabled')
      expect(segmentOf(html, '480P')).toContain('chỉ SD 2.5') // the model table's own note stays
    }
  })
})

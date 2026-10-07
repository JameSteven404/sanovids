// The scene node = the editor (approved design E0 v3, section 6 "Số đo cho người làm app"): geometry, labels, foot
// layout and the far view's tone — the numbers of the approved page.
import { describe, expect, it } from 'vitest'
import { EMPTY_PROMPT_REASON, LONG_PROMPT_REASON, NO_FRAMES_REASON, NO_IMAGE_REASON, unsentTokensReason } from '../../../core/runRules'
import type { VideoSettings } from '../../../core/types'
import { LAYOUT } from '../../../store/project'
import { DOT_TOP, lodOf, LOD_ZOOM } from '../canvasModel'
import { caretFromExcerptHit } from '../sceneEditorModel'
import {
  compactStatus,
  farExcerpt,
  farSummary,
  FRAME_RATIO_LABEL,
  frameRatioTitle,
  farTone,
  footLayout,
  imageBadge,
  NODE,
  nodeCounter,
  PROMPT_TOP,
  promptBoxHeight,
  promptLinesFor,
  promptTextWidth,
  runButtonView,
  runWidth,
  settingsSummary,
  staticExcerpt,
} from '../sceneNodeModel'

const SD: VideoSettings = { model: 'seedance_2_5', mode: 't2v', duration: 30, resolution: '480p', ratio: '16:9' }
const H3: VideoSettings = { model: 'minimax_h3', mode: 'i2v', duration: 10, resolution: '2k', ratio: '16:9' }

describe('node geometry (1A: 352 × 304, row 352)', () => {
  it('the default prompt box is 194px and shows 9 lines of 13.5 / 19px text', () => {
    expect(promptBoxHeight(LAYOUT.sceneH)).toBe(194)
    expect(promptLinesFor(194)).toBe(9)
  })
  it('2B: the settings line opened in place takes 3 lines from the prompt, the node never grows', () => {
    expect(NODE.settingsRows).toBe(3 * NODE.promptLine)
    expect(promptBoxHeight(LAYOUT.sceneH, { settingsOpen: true })).toBe(194 - 57)
    expect(promptLinesFor(promptBoxHeight(LAYOUT.sceneH, { settingsOpen: true }))).toBe(6)
  })
  it('the red placeholder strip (6 + 22) and the long-reason line (16) come out of the prompt too', () => {
    expect(promptBoxHeight(LAYOUT.sceneH, { strip: true })).toBe(194 - 28)
    expect(promptBoxHeight(LAYOUT.sceneH, { why: true })).toBe(194 - 16)
    expect(promptBoxHeight(LAYOUT.sceneH, { strip: true, why: true, settingsOpen: true })).toBe(194 - 28 - 16 - 57)
  })
  it('a taller node gives every extra pixel to the prompt (900px ≈ 40 lines), a tiny one never goes negative', () => {
    expect(promptBoxHeight(900)).toBe(194 + 900 - 304)
    expect(promptLinesFor(promptBoxHeight(900))).toBeGreaterThanOrEqual(40)
    expect(promptBoxHeight(10)).toBe(0)
    expect(promptLinesFor(0)).toBe(1)
  })
  it('the dots sit at the top of the prompt box = the middle of an unresized take poster (62px)', () => {
    expect(PROMPT_TOP).toBe(62)
    expect(Math.abs(DOT_TOP - PROMPT_TOP)).toBeLessThan(1)
    expect(LAYOUT.sceneH + LAYOUT.gapY).toBe(352)
  })
  it('the prompt text column: node − borders − paddings − box borders − insets (10 + 16)', () => {
    expect(promptTextWidth(352)).toBe(352 - 2 - 16 - 2 - 26)
  })
})

describe('static text = a prefix of the prompt, never the whole 20,000 characters', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Dòng ${i + 1}: máy quay tiến chậm qua sương, @image_1 bước tới.`).join('\n')
  it('cuts after the line breaks the box can show, keeps a prefix (clicks still map to the prompt)', () => {
    const ex = staticExcerpt(long, 9, promptTextWidth(352))
    expect(long.startsWith(ex)).toBe(true)
    // at least the 9 lines the box shows, never past the 10th line break
    expect(ex.split('\n').length).toBeGreaterThanOrEqual(9)
    expect(ex.split('\n').length).toBeLessThanOrEqual(10)
    expect(ex.length).toBeLessThan(long.length / 3)
    expect(caretFromExcerptHit(long, ex.slice(0, 25))).toBe(25)
  })
  it('a single huge paragraph is capped at more than the lines can show', () => {
    const para = 'a'.repeat(20000)
    const ex = staticExcerpt(para, 9, promptTextWidth(352))
    expect(ex.length).toBeLessThan(2000)
    expect(ex.length).toBeGreaterThan(9 * Math.floor(promptTextWidth(352) / 6.4))
  })
  it('short prompts come back whole', () => {
    expect(staticExcerpt('Bình minh trên hồ.', 9, 300)).toBe('Bình minh trên hồ.')
    expect(staticExcerpt('', 9, 300)).toBe('')
  })
  it('counter "4.478 / 20.000" in code points, over the limit flagged', () => {
    expect(nodeCounter('x'.repeat(4478), 20000)).toEqual({ text: '4.478 / 20.000', over: false })
    expect(nodeCounter('👋'.repeat(7001), 7000)).toEqual({ text: '7.001 / 7.000', over: true })
  })
})

describe('head and settings line', () => {
  it('compact take status "● 2 · ★T2" with the full sentence as the title', () => {
    expect(compactStatus({ count: 0, status: null, progress: 0, starredNumber: null, active: 0 })).toMatchObject({ text: 'chưa có take', tone: 'none' })
    const s = compactStatus({ count: 2, status: 'completed', progress: 100, starredNumber: 2, active: 0 })
    expect(s).toMatchObject({ text: '2 · ★T2', tone: 'ok' })
    expect(s.title).toBe('2 take · đã chọn T2 · take mới nhất: xong')
    expect(compactStatus({ count: 1, status: 'processing', progress: 45.4, starredNumber: null, active: 1 })).toMatchObject({ text: '45%', tone: 'going' })
    expect(compactStatus({ count: 3, status: 'queued', progress: 0, starredNumber: null, active: 1 })).toMatchObject({ text: '3 · chờ', tone: 'wait' })
    expect(compactStatus({ count: 1, status: 'failed', progress: 0, starredNumber: null, active: 0 }).tone).toBe('fail')
  })
  it('2B summary line "SD 2.5 · 30s · 480P · 16:9 · Nháp" (the mode only where there is a choice)', () => {
    expect(settingsSummary(SD, 'SD 2.5', 1, 'Nháp')).toBe('SD 2.5 · 30s · 480P · 16:9 · Nháp')
    expect(settingsSummary(H3, 'H3', 3, null)).toBe('H3 · Ảnh→Video · 10s · 2K · 16:9 · Tuỳ chỉnh')
    expect(settingsSummary({ ...H3, mode: 'transform' }, 'H3', 3, null)).toContain('Đầu→cuối')
  })
  it('H3 "Đầu→cuối" sends no ratio (the frames give it): "theo ảnh", never the stored ratio', () => {
    expect(FRAME_RATIO_LABEL).toBe('theo ảnh')
    expect(settingsSummary({ ...H3, mode: 'transform', ratio: '9:16' }, 'H3', 3, null)).toBe('H3 · Đầu→cuối · 10s · 2K · theo ảnh · Tuỳ chỉnh')
    expect(frameRatioTitle('16:9', '16:9')).toBe('Tỉ lệ lấy theo khung đầu / khung cuối: 16:9.')
    expect(frameRatioTitle('16:9', '9:16')).toContain('khác tỷ lệ (16:9 / 9:16)')
    expect(frameRatioTitle(null, '1:1')).toContain('chưa thuộc danh sách')
    expect(frameRatioTitle(undefined, '1:1')).toContain('nối đủ hai khung')
  })
})

describe('Run button', () => {
  const base = { cost: 20, kind: 'canvasapp' as const, code: 'S02', duration: 15 }
  it('ready: "Tạo video · 20 credit", compact "20 credit"; the duration only in the title', () => {
    const r = runButtonView(null, base)
    expect(r).toMatchObject({ blocked: false, label: 'Tạo video · 20 credit', why: null, compact: false })
    expect(r.title).toBe('Tạo video cho S02 · 15 giây · 20 credit (Ctrl+Enter)')
    expect(runButtonView(null, { ...base, compact: true })).toMatchObject({ label: '20 credit', compact: true })
    expect(runButtonView(null, { ...base, kind: 'dev' }).label).toBe('Tạo video · 20 credit dev')
  })
  it('red placeholders: "Chưa chạy · còn chữ đỏ", the full reason as the title', () => {
    const reason = unsentTokensReason(['@image_?2'])
    expect(runButtonView(reason, { ...base, placeholders: true })).toEqual({ blocked: true, label: 'Chưa chạy · còn chữ đỏ', why: null, title: `Chưa chạy được: ${reason}`, compact: false })
  })
  it.each([
    [EMPTY_PROMPT_REASON, 'Chưa chạy · prompt trống'],
    [LONG_PROMPT_REASON, 'Chưa chạy · prompt quá dài'],
    [NO_IMAGE_REASON, 'Chưa chạy · thiếu ảnh tham chiếu'],
    [NO_FRAMES_REASON, 'Chưa chạy · thiếu khung đầu/cuối'],
  ])('short reason "%s" stands on the button', (reason, label) => {
    expect(runButtonView(reason, base)).toMatchObject({ blocked: true, label, why: null })
  })
  it('a long reason: "Chưa chạy được" + one red line under the foot', () => {
    const reason = unsentTokensReason(['@image_5'])
    expect(runButtonView(reason, base)).toMatchObject({ blocked: true, label: 'Chưa chạy được', why: reason })
  })
})

describe('foot: pictures left, Run right (one 32px row)', () => {
  const label = 'Tạo video · 20 credit'
  it('1 image with its name and the full button', () => {
    expect(footLayout(352, ['Linh'], label)).toEqual({ names: true, shown: 1, more: 0, compact: false })
  })
  it('2–3 images: pictures + numbers, the full button', () => {
    expect(footLayout(352, ['Linh', 'Đèn lồng'], label)).toEqual({ names: false, shown: 2, more: 0, compact: false })
    expect(footLayout(352, ['A', 'B', 'C'], label)).toMatchObject({ names: false, shown: 3, compact: false })
  })
  it('from 4 images the button turns compact; past 5 pictures a "+N"', () => {
    expect(footLayout(352, ['A', 'B', 'C', 'D'], label)).toEqual({ names: false, shown: 4, more: 0, compact: true })
    const six = footLayout(352, ['A', 'B', 'C', 'D', 'E', 'F'], label)
    expect(six.compact).toBe(true)
    expect(six.shown + six.more).toBe(6)
    expect(six.shown).toBeLessThanOrEqual(NODE.maxThumbs)
  })
  it('a wider node shows names / the full button longer; the narrowest node still fits the compact button', () => {
    expect(footLayout(720, ['Linh', 'Đèn lồng'], label).names).toBe(true)
    expect(footLayout(720, ['A', 'B', 'C', 'D'], label).compact).toBe(false)
    const narrow = footLayout(320, ['A', 'B', 'C', 'D', 'E', 'F', 'G'], label)
    expect(narrow.compact).toBe(true)
    expect(narrow.shown).toBeGreaterThanOrEqual(1)
    expect(runWidth('x')).toBe(NODE.runMin)
  })
  it('badges: "2–3" for a character with 2 pictures', () => {
    expect(imageBadge(2, 2)).toBe('2–3')
    expect(imageBadge(4, 1)).toBe('4')
    expect(imageBadge(undefined, 0)).toBe('')
  })
})

describe('far view (zoom < 0.55)', () => {
  it('switches below LOD_ZOOM 0.55', () => {
    expect(LOD_ZOOM).toBe(0.55)
    expect(lodOf(0.45)).toBe('far')
    expect(lodOf(0.549)).toBe('far')
    expect(lodOf(0.55)).toBe('near')
    expect(lodOf(1)).toBe('near')
  })
  it('top bar: orange generating, red cannot run, green has a video, grey nothing yet', () => {
    expect(farTone('processing', true, true)).toBe('going')
    expect(farTone('queued', false, false)).toBe('going')
    expect(farTone('completed', true, true)).toBe('bad')
    expect(farTone('completed', true, false)).toBe('ok')
    expect(farTone(null, false, false)).toBe('none')
    expect(farSummary('SD 2.5', 15)).toBe('SD 2.5 · 15s')
  })
  it('two prompt lines, cut to what two lines can show: never a whole 20,000-character paragraph in every far node', () => {
    const paragraph = 'Ánh nắng xuyên qua rừng, nhân vật bước chậm. '.repeat(500).slice(0, 20000)
    const far = farExcerpt(paragraph, LAYOUT.sceneW)
    expect(far.length).toBeLessThan(120)
    expect(far.length).toBeGreaterThan(40) // still fills the two lines (24px text, 310px wide)
    expect(paragraph.startsWith(far)).toBe(true)
    // the first two lines, leading blanks dropped (the old far node: trimmed, line breaks kept)
    expect(farExcerpt('\n  Dòng một\nDòng hai\nDòng ba', LAYOUT.sceneW)).toBe('Dòng một\nDòng hai')
    expect(farExcerpt('', LAYOUT.sceneW)).toBe('')
    // a wider (resized) node shows more
    expect(farExcerpt(paragraph, 720).length).toBeGreaterThan(far.length)
  })
})

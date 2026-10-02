// "Cách đặt tên file": template check, render (the default must give exactly the names of earlier versions), tokens
// with no value, unsafe values, date / time tokens.
import { describe, expect, it } from 'vitest'
import { MAX_BASE_LENGTH } from '../fileNames'
import { checkNameTemplate, DEFAULT_NAME_TEMPLATE, MAX_TEMPLATE_LENGTH, nameDate, nameTime, NAME_TOKENS, normalizeNameTemplate, renderNameTemplate } from '../nameTemplate'

const v = { scene: 'S03', take: 'T2', title: 'Ánh sáng trong hang', project: 'Phim ngắn', date: '2026-10-02', time: '14h05', model: 'Seedance 2.5' }

describe('renderNameTemplate', () => {
  it('the default template gives the names of earlier versions', () => {
    expect(DEFAULT_NAME_TEMPLATE).toBe('{scene}_{take} - {title}')
    expect(renderNameTemplate(DEFAULT_NAME_TEMPLATE, v)).toBe('S03_T2 - Ánh sáng trong hang')
    expect(renderNameTemplate(DEFAULT_NAME_TEMPLATE, { ...v, title: '' })).toBe('S03_T2')
    expect(renderNameTemplate(DEFAULT_NAME_TEMPLATE, { ...v, title: '   ' })).toBe('S03_T2')
    expect(renderNameTemplate(DEFAULT_NAME_TEMPLATE, { scene: 'S00', take: 'T1' })).toBe('S00_T1')
  })

  it('every token', () => {
    expect(renderNameTemplate('{project} - {scene}{take} - {model} - {date} {time}', v)).toBe('Phim ngắn - S03T2 - Seedance 2.5 - 2026-10-02 14h05')
    expect(renderNameTemplate('{SCENE}-{ Take }', v)).toBe('S03-T2')
  })

  it('a token with no value takes its separator with it', () => {
    const noTitle = { ...v, title: '' }
    expect(renderNameTemplate('{title} - {scene}_{take}', noTitle)).toBe('S03_T2')
    expect(renderNameTemplate('{scene} - {title} - {date}', noTitle)).toBe('S03 - 2026-10-02')
    expect(renderNameTemplate('{scene} - {title} - {model}', { ...noTitle, model: '' })).toBe('S03')
    expect(renderNameTemplate('{title} - {model} - {scene}', { ...noTitle, model: '' })).toBe('S03')
    expect(renderNameTemplate('Phim {title} - {scene}', noTitle)).toBe('Phim - S03')
    expect(renderNameTemplate('{scene} ({title})', noTitle)).toBe('S03')
    expect(renderNameTemplate('{scene} [{model}] {take}', { ...v, model: '' })).toBe('S03 T2')
    expect(renderNameTemplate('{scene} ({title})', v)).toBe('S03 (Ánh sáng trong hang)')
  })

  it('an empty token right after an opening bracket takes the separator after it', () => {
    const noTitle = { ...v, title: '' }
    expect(renderNameTemplate('{scene} ({title}, {model}) {take}', noTitle)).toBe('S03 (Seedance 2.5) T2')
    expect(renderNameTemplate('{scene} [{title} - {model}] {take}', noTitle)).toBe('S03 [Seedance 2.5] T2')
    expect(renderNameTemplate('{scene} ({title}, {model}) {take}', v)).toBe('S03 (Ánh sáng trong hang, Seedance 2.5) T2')
    expect(renderNameTemplate('{scene} ({model}, {title}) {take}', noTitle)).toBe('S03 (Seedance 2.5) T2')
  })

  it('brackets left empty by several empty tokens go away; brackets inside a value stay', () => {
    const none = { ...v, title: '', model: '' }
    expect(renderNameTemplate('{scene} ({title}, {model}) {take}', none)).toBe('S03 T2')
    expect(renderNameTemplate('{scene} [{title}{model}]', none)).toBe('S03')
    expect(renderNameTemplate('{scene} ({title}) {model}', { ...v, title: 'Cảnh (bản nháp) ()', model: '' })).toBe('S03 (Cảnh (bản nháp) ())')
  })

  it('values never break the file name', () => {
    expect(renderNameTemplate('{scene} - {title}', { ...v, title: 'A/B: "C"?' })).toBe('S03 - A-B- -C--')
    expect(renderNameTemplate('{title}', { title: '..\\..\\x' })).toBe('-..-x')
    expect(renderNameTemplate('{title}', { title: 'CON' })).toBe('_CON')
    expect(renderNameTemplate('{title} {take}', { title: 'x'.repeat(300), take: 'T1' }).length).toBeLessThanOrEqual(MAX_BASE_LENGTH)
    expect(renderNameTemplate('{title}', { title: '' })).toBe('')
  })

  it('an unknown token stays as typed', () => {
    expect(renderNameTemplate('{scene} {foo}', v)).toBe('S03 {foo}')
  })
})

describe('checkNameTemplate', () => {
  it('accepts templates with known tokens (trimmed)', () => {
    expect(checkNameTemplate('  {scene}_{take} - {title}  ')).toEqual({ ok: true, template: '{scene}_{take} - {title}' })
    for (const t of NAME_TOKENS) expect(checkNameTemplate(`{${t.id}} {take}`).ok).toBe(true)
  })
  it('warns when takes of one scene would share a name', () => {
    const c = checkNameTemplate('{scene} - {title}')
    expect(c.ok).toBe(true)
    expect(c.ok && c.warning).toMatch(/\{take\}/)
    expect(checkNameTemplate('{scene} {time}')).toEqual({ ok: true, template: '{scene} {time}' })
  })
  it('refuses what cannot work', () => {
    const err = (t: unknown) => {
      const c = checkNameTemplate(t)
      return c.ok ? null : c.error
    }
    expect(err('')).toMatch(/trống/)
    expect(err('   ')).toMatch(/trống/)
    expect(err(42)).toBeTruthy()
    expect(err(null)).toBeTruthy()
    expect(err('cảnh cuối')).toMatch(/ít nhất một mã/)
    expect(err('{scene}/{take}')).toMatch(/“\/”/)
    expect(err('{scene}:{take}')).toMatch(/“:”/)
    expect(err('{scene}\u0001')).toMatch(/điều khiển/)
    expect(err('{scen}_{take}')).toMatch(/\{scen\}/)
    expect(err('{scene} {take')).toMatch(/Dấu \{ \}/)
    expect(err('{scene}} {take}')).toMatch(/Dấu \{ \}/)
    expect(err('{take}' + 'x'.repeat(MAX_TEMPLATE_LENGTH))).toMatch(/dài quá/)
  })
  it('normalizeNameTemplate: invalid stored values fall back to the default', () => {
    expect(normalizeNameTemplate('{take} {scene}')).toBe('{take} {scene}')
    expect(normalizeNameTemplate('{nope}')).toBe(DEFAULT_NAME_TEMPLATE)
    expect(normalizeNameTemplate(undefined)).toBe(DEFAULT_NAME_TEMPLATE)
  })
})

describe('date / time tokens', () => {
  it('local date and a colon-free time', () => {
    const ms = new Date(2026, 9, 2, 9, 5).getTime()
    expect(nameDate(ms)).toBe('2026-10-02')
    expect(nameTime(ms)).toBe('09h05')
    expect(nameDate(0)).toBe('')
    expect(nameTime(Number.NaN)).toBe('')
    expect(nameDate(null)).toBe('')
  })
})

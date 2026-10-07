import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../ModelPicker'
import { CLOSED_MODEL_PICKER, modelPickerEntries, modelPickerKey, openModelPicker, type ModelPickerState } from '../modelPickerModel'

// SSR can inspect the open state without a DOM or launching a browser.
const forcedState = vi.hoisted(() => ({ value: null as ModelPickerState | null }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => actual.useState(forcedState.value ?? initial) }
})

const entries = modelPickerEntries()
describe('model picker', () => {
  it('lists the five routes in provider order with distinct IDs and no invented seedvis prices', () => {
    expect(entries.map(entry => entry.label)).toEqual([
      'Seedance 2.5 · canvasapp', 'MiniMax-H3 · canvasapp', 'Seedance 2.5 · seedvis',
      'Seedance 2.0 Fast · seedvis', 'Veo 3.1 · seedvis',
    ])
    expect(new Set(entries.map(entry => entry.id)).size).toBe(5)
    expect(entries[0].capability).toContain('≤ 30 ảnh')
    expect(entries[2].capability).toContain('≤ 10 ảnh · 5–30 s')
    expect(entries[2].capability).toContain('@image_1 có thể thành khung mở đầu')
    expect(entries[4].capability).toContain('≤ 3 ảnh · 4–8 s')
    for (const entry of entries.slice(2)) expect(entry.capability).toContain('Giá: — (chưa đo)')
  })

  it('opens on the saved choice, skips disabled rows and wraps in both directions', () => {
    const rows = modelPickerEntries({ disabledReasons: { minimax_h3: 'Đang bảo trì' } })
    let state = openModelPicker(rows, 'seedance_2_5')
    state = modelPickerKey(rows, state, 'ArrowDown', 0).state
    expect(state.active).toBe(2)
    expect(modelPickerKey(rows, state, 'ArrowUp', 0).state.active).toBe(0)
    state = modelPickerKey(rows, state, 'End', 0).state
    expect(state.active).toBe(4)
    expect(modelPickerKey(rows, state, 'ArrowDown', 0).state.active).toBe(0)
    state = modelPickerKey(rows, state, 'Home', 0).state
    expect(modelPickerKey(rows, state, 'ArrowUp', 0).state.active).toBe(4)
    expect(openModelPicker(rows, 'minimax_h3').active).toBe(0)
  })

  it('keeps provider warnings selectable but refuses a model-level disabled choice', () => {
    const rows = modelPickerEntries({ serviceWarnings: { seedvis: 'Chưa lưu API key' }, disabledReasons: { minimax_h3: 'Đang bảo trì' } })
    const state = openModelPicker(rows, 'seedvis/veo_3.1')
    expect(rows[state.active].warningReason).toBe('Chưa lưu API key')
    expect(modelPickerKey(rows, state, 'Enter', 0).selected).toBe('seedvis/veo_3.1')
    expect(modelPickerKey(rows, { ...state, active: 1 }, 'Enter', 0).selected).toBeUndefined()
    expect(modelPickerKey(rows, state, ' ', 0).selected).toBe('seedvis/veo_3.1')
  })

  it('navigates without selecting; Escape and Tab cancel without trapping Tab', () => {
    const state = openModelPicker(entries, null)
    expect(modelPickerKey(entries, state, 'ArrowDown', 0).selected).toBeUndefined()
    expect(modelPickerKey(entries, state, 'Escape', 0)).toEqual({ state: CLOSED_MODEL_PICKER, handled: true })
    expect(modelPickerKey(entries, state, 'Tab', 0)).toEqual({ state: CLOSED_MODEL_PICKER, handled: false })
    expect(modelPickerKey(entries, CLOSED_MODEL_PICKER, 'Enter', 0).selected).toBeUndefined()
    expect(modelPickerKey(entries, state, 'F2', 0).handled).toBe(false)
  })

  it('supports prefixes, repeated-letter cycling, timeout and an unmatched prefix', () => {
    let state = openModelPicker(entries, 'seedance_2_5')
    state = modelPickerKey(entries, state, 's', 1000).state
    expect(state.active).toBe(2)
    state = modelPickerKey(entries, state, 's', 1100).state
    expect(state.active).toBe(3)
    state = modelPickerKey(entries, state, 'v', 2000).state
    expect(state.active).toBe(4)
    state = modelPickerKey(entries, state, 'e', 2100).state
    expect(state.search).toBe('ve')
    expect(state.active).toBe(4)
    expect(modelPickerKey(entries, state, 'x', 2200).state.active).toBe(4)
    expect(modelPickerKey(entries, state, 'm', 3000).state.active).toBe(1)
  })

  it('handles empty lists, all-disabled lists and a choice disabled while open', () => {
    const rows = entries.map(entry => ({ ...entry, disabledReason: 'Đang tắt' }))
    for (const list of [[], rows]) {
      let state = openModelPicker(list, null)
      expect(state.active).toBe(-1)
      for (const key of ['Home', 'End', 'ArrowUp', 'ArrowDown', 'x', 'Enter']) {
        const result = modelPickerKey(list, state, key, 0)
        expect(result.selected).toBeUndefined()
        expect(result.state.active).toBe(-1)
        state = result.state
      }
    }
    expect(modelPickerKey(rows, openModelPicker(entries, 'seedance_2_5'), 'Enter', 0).selected).toBeUndefined()
  })

  it('renders a named, disabled-capable listbox trigger without calling onChange', () => {
    const onChange = vi.fn()
    const html = renderToStaticMarkup(createElement(ModelPicker, { value: 'seedvis/seedance_2.5', onChange, disabled: true }))
    expect(html).toContain('aria-label="Model: Seedance 2.5 · seedvis"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('lucide-sprout')
    expect(onChange).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(createElement(ModelPicker, { value: null, onChange }))).toContain('Nhiều model')
  })

  it('renders five described options in two labelled groups, retaining disabled rows and warnings', () => {
    forcedState.value = openModelPicker(entries, 'seedvis/seedance_2.5')
    try {
      const html = renderToStaticMarkup(createElement(ModelPicker, {
        value: 'seedvis/seedance_2.5', onChange: vi.fn(),
        disabledReasons: { minimax_h3: 'Đang bảo trì' }, serviceWarnings: { seedvis: 'Chưa lưu API key' },
      }))
      expect(html.match(/role="option"/g)).toHaveLength(5)
      expect(html.match(/role="group"/g)).toHaveLength(2)
      expect(html).toContain('aria-expanded="true"')
      expect(html).toContain('aria-activedescendant=')
      expect(html).toContain('aria-describedby=')
      expect(html.match(/aria-disabled="true"/g)).toHaveLength(1)
      expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
      expect(html).toContain('Đang bảo trì')
      expect(html).toContain('Chưa lưu API key')
    } finally { forcedState.value = null }
  })
})

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { foreignModelReason } from '../../../core/runRules'
import type { SeedvisPriceReference } from '../../../providers/seedvis/contract'
import { ModelPicker } from '../ModelPicker'
import {
  CLOSED_MODEL_PICKER, listKeyDown, MODEL_PICKER_GROUPS, modelPickerEntries, modelPickerKey, modelPickerTriggerKey,
  nearestScrollTop, openModelPicker, triggerKeyDown, type ModelPickerState, type PickerKeyEvent,
} from '../modelPickerModel'

// SSR can inspect the open state without a DOM or launching a browser.
const forcedState = vi.hoisted(() => ({ value: null as ModelPickerState | null }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => actual.useState(forcedState.value ?? initial) }
})

const NO_PRICES: SeedvisPriceReference = { measuredAt: null, source: null, rows: [] }
const entries = modelPickerEntries({ seedvisPrices: NO_PRICES })
const indexOf = (id: string) => entries.findIndex(entry => entry.id === id)
function fakeKey(key: string, mods: Partial<Pick<PickerKeyEvent, 'ctrlKey' | 'metaKey' | 'altKey'>> = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, ...mods, preventDefault: vi.fn(), stopPropagation: vi.fn() }
}

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
    expect(MODEL_PICKER_GROUPS.map(group => group.service)).toEqual(['canvasapp', 'seedvis'])
  })

  it('prices canvasapp rows in the wallet unit and seedvis rows from the reference table', () => {
    expect(entries[0].capability).toMatch(/· ≈ 4–25 credit$/)
    expect(entries[1].capability).toMatch(/· ≈ 4–10 credit$/)
    const dev = modelPickerEntries({ simulated: { canvasapp: true, seedvis: true }, seedvisPrices: NO_PRICES })
    expect(dev[0].capability).toMatch(/· ≈ 4–25 credit dev$/)
    expect(dev[2].capability).toContain('Giá: — (chưa đo)')
    const measured: SeedvisPriceReference = {
      measuredAt: '2026-10-01', source: 'live-test', rows: [
        { model: 'seedvis/seedance_2.5', duration: 5, credits: 20 },
        { model: 'seedvis/seedance_2.5', duration: 30, credits: 120 },
        { model: 'seedvis/veo_3.1', duration: 8, upscale: 'none', credits: 1500 },
      ],
    }
    const priced = modelPickerEntries({ seedvisPrices: measured })
    expect(priced[2].capability).toContain('≈ 20–120 credit seedvis')
    expect(priced[3].capability).toContain('Giá: — (chưa đo)')
    expect(priced[4].capability).toContain('≈ 1.500 credit seedvis')
    expect(modelPickerEntries({ seedvisPrices: measured, simulated: { seedvis: true } })[2].capability).toContain('≈ 20–120 credit dev seedvis')
    for (const entry of priced) expect(entry.capability).not.toMatch(/\d credit(?! dev| seedvis|$)/)
  })

  it('lists only the models a caller offers, in its order inside each provider group', () => {
    const rows = modelPickerEntries({ models: ['seedvis/veo_3.1', 'minimax_h3', 'seedvis/seedance_2.5', 'minimax_h3'] })
    expect(rows.map(row => row.id)).toEqual(['minimax_h3', 'seedvis/veo_3.1', 'seedvis/seedance_2.5'])
    expect(modelPickerEntries({ models: [] })).toEqual([])
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
    expect(modelPickerKey(rows, state, 'PageDown', 0).state.active).toBe(4)
    expect(modelPickerKey(rows, { ...state, active: 4 }, 'PageUp', 0).state.active).toBe(0)
    expect(openModelPicker(rows, 'minimax_h3').active).toBe(0)
  })

  it('keeps provider and per-model warnings selectable but refuses a model-level disabled choice', () => {
    const rows = modelPickerEntries({
      serviceWarnings: { seedvis: 'Chưa lưu API key' }, disabledReasons: { minimax_h3: 'Đang bảo trì' },
      warningReasons: { 'seedvis/veo_3.1': 'có thể bị từ chối', seedance_2_5: 'có thể bị từ chối' },
    })
    const state = openModelPicker(rows, 'seedvis/veo_3.1')
    expect(rows[state.active].warningReason).toBe('có thể bị từ chối · Chưa lưu API key')
    expect(rows[0].warningReason).toBe('có thể bị từ chối')
    expect(rows[3].warningReason).toBe('Chưa lưu API key')
    expect(modelPickerKey(rows, state, 'Enter', 0).selected).toBe('seedvis/veo_3.1')
    expect(modelPickerKey(rows, { ...state, active: 0 }, 'Enter', 0).selected).toBe('seedance_2_5')
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

  it('keeps Delete / Backspace (and other editing keys) in the open list without selecting anything', () => {
    const state = openModelPicker(entries, 'seedvis/veo_3.1')
    for (const key of ['Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'Insert']) {
      const result = modelPickerKey(entries, state, key, 0)
      expect(result, key).toEqual({ state, handled: true })
    }
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

  it('treats Space inside a type-ahead as part of the search, and as a choice after the pause', () => {
    let state = openModelPicker(entries, 'seedvis/veo_3.1')
    let now = 1000
    for (const key of 'seedance 2.0') {
      const result = modelPickerKey(entries, state, key, now += 100)
      expect(result.selected, `"${key}"`).toBeUndefined()
      expect(result.handled).toBe(true)
      state = result.state
    }
    expect(state.search).toBe('seedance 2.0')
    expect(state.active).toBe(indexOf('seedvis/seedance_2.0_fast'))
    expect(modelPickerKey(entries, state, ' ', now + 701).selected).toBe('seedvis/seedance_2.0_fast')
    expect(modelPickerKey(entries, state, 'Enter', now + 100).selected).toBe('seedvis/seedance_2.0_fast')
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

  it('keeps plain keys on the closed trigger like a native select: letters open on the match, never commit', () => {
    const typed = modelPickerTriggerKey(entries, 'seedance_2_5', 'v', 500)
    expect(typed.handled).toBe(true)
    expect(typed.state).toMatchObject({ open: true, active: indexOf('seedvis/veo_3.1'), search: 'v', searchedAt: 500 })
    expect(typed).not.toHaveProperty('selected')
    expect(modelPickerTriggerKey(entries, 'minimax_h3', 'ArrowDown', 0).state).toEqual(openModelPicker(entries, 'minimax_h3'))
    expect(modelPickerTriggerKey(entries, 'minimax_h3', 'End', 0).state?.active).toBe(4)
    for (const key of ['n', 'c', 'f', 'e', 'h', 'v', 'm', '?', '1']) expect(modelPickerTriggerKey(entries, null, key, 0).handled, key).toBe(true)
    for (const key of ['Delete', 'Backspace']) expect(modelPickerTriggerKey(entries, null, key, 0)).toEqual({ state: null, handled: true })
    for (const key of ['Enter', ' ']) expect(modelPickerTriggerKey(entries, null, key, 0)).toEqual({ state: null, handled: true, press: true })
    for (const key of ['Tab', 'Escape', 'F5']) expect(modelPickerTriggerKey(entries, null, key, 0).handled, key).toBe(false)
  })

  it('prevents and stops the keys it keeps; Enter / Space still press the trigger; chords pass through', () => {
    const open = openModelPicker(entries, 'seedance_2_5')
    for (const key of ['Delete', 'Backspace', 'n', 'Enter', 'Escape']) {
      const event = fakeKey(key)
      listKeyDown(event, entries, open, 0)
      expect(event.preventDefault, key).toHaveBeenCalledOnce()
      expect(event.stopPropagation, key).toHaveBeenCalledOnce()
    }
    const tab = fakeKey('Tab')
    expect(listKeyDown(tab, entries, open, 0)?.state).toEqual(CLOSED_MODEL_PICKER)
    expect(tab.preventDefault).not.toHaveBeenCalled()
    const save = fakeKey('s', { ctrlKey: true })
    expect(listKeyDown(save, entries, open, 0)).toBeNull()
    expect(triggerKeyDown(save, entries, null, 0)).toBeNull()
    expect(save.preventDefault).not.toHaveBeenCalled()
    for (const key of ['Delete', 'Backspace', 'n']) {
      const event = fakeKey(key)
      triggerKeyDown(event, entries, null, 0)
      expect(event.preventDefault, key).toHaveBeenCalledOnce()
      expect(event.stopPropagation, key).toHaveBeenCalledOnce()
    }
    const enter = fakeKey('Enter')
    triggerKeyDown(enter, entries, null, 0)
    expect(enter.preventDefault).not.toHaveBeenCalled()
    expect(enter.stopPropagation).toHaveBeenCalledOnce()
    const composing = { ...fakeKey('a'), nativeEvent: { isComposing: true } }
    expect(listKeyDown(composing, entries, open, 0)).toBeNull()
  })

  it('scrolls only the list, by the smallest move that shows the active row', () => {
    expect(nearestScrollTop(0, 300, 100, 50)).toBe(0)
    expect(nearestScrollTop(200, 300, 100, 50)).toBe(100)
    expect(nearestScrollTop(0, 300, 280, 60)).toBe(40)
    expect(nearestScrollTop(0, 30, 0, 60)).toBe(0)
    const source = readFileSync(new URL('../ModelPicker.tsx', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(source).not.toContain('scrollIntoView')
    expect(source.match(/\.focus\(/g)?.length).toBe(source.match(/\.focus\(\{ preventScroll: true \}\)/g)?.length)
  })

  it('renders a named, disabled-capable listbox trigger without calling onChange', () => {
    const onChange = vi.fn()
    const html = renderToStaticMarkup(createElement(ModelPicker, { value: 'seedvis/seedance_2.5', onChange, disabled: true }))
    expect(html).toContain('aria-label="Model: Seedance 2.5 · seedvis"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('lucide-sprout')
    expect(html).toContain('class="in-model-picker nodrag nopan nokey"')
    expect(html).not.toContain('aria-invalid')
    expect(onChange).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(createElement(ModelPicker, { value: null, onChange }))).toContain('Nhiều model')
  })

  it('passes the refused state and field id to the trigger for SettingsFields', () => {
    const html = renderToStaticMarkup(createElement(ModelPicker, { value: 'minimax_h3', onChange: vi.fn(), invalid: true, fieldId: 'model', title: 'Bị từ chối' }))
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('data-settings-field="model"')
    expect(html).toContain('title="Bị từ chối"')
  })

  it("shows a newer build's model as the choice with its warning, not as \"Nhiều model\"", () => {
    const html = renderToStaticMarkup(createElement(ModelPicker, { value: 'seedance_2_5', foreign: 'veo_3_1', onChange: vi.fn() }))
    expect(html).toContain('aria-label="Model: veo_3_1 (bản mới hơn)"')
    expect(html).toContain(`aria-label="${foreignModelReason('veo_3_1')}"`)
    expect(html).not.toContain('Nhiều model')
    forcedState.value = openModelPicker(entries, null)
    try {
      const open = renderToStaticMarkup(createElement(ModelPicker, { value: 'seedance_2_5', foreign: 'veo_3_1', onChange: vi.fn() }))
      expect(open).not.toContain('aria-selected="true"')
    } finally { forcedState.value = null }
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
      expect(html).toContain('class="in-model-list nowheel"')
      expect(html.match(/aria-disabled="true"/g)).toHaveLength(1)
      expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
      expect(html).toContain('Đang bảo trì')
      expect(html).toContain('Chưa lưu API key')
    } finally { forcedState.value = null }
  })

  it('renders only the offered models and drops an empty group', () => {
    forcedState.value = { ...CLOSED_MODEL_PICKER, open: true, active: 0 }
    try {
      const html = renderToStaticMarkup(createElement(ModelPicker, { value: 'seedance_2_5', onChange: vi.fn(), models: ['seedance_2_5', 'minimax_h3'] }))
      expect(html.match(/role="option"/g)).toHaveLength(2)
      expect(html.match(/role="group"/g)).toHaveLength(1)
      expect(html).not.toContain('· seedvis"')
    } finally { forcedState.value = null }
  })
})

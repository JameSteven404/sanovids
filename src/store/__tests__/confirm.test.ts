// store/confirm: one question at a time in the app's own dialog (ConfirmSheet), answered once.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerConfirm, askConfirm, useConfirm } from '../confirm'

afterEach(() => answerConfirm(false))

describe('askConfirm / answerConfirm', () => {
  it('confirm runs onConfirm once; the question closes', () => {
    const yes = vi.fn()
    const no = vi.fn()
    askConfirm({ title: 'T', text: 'Q?', confirmLabel: 'Xoá', danger: true, onConfirm: yes, onCancel: no })
    expect(useConfirm.getState().request).toMatchObject({ title: 'T', text: 'Q?', confirmLabel: 'Xoá', danger: true })
    answerConfirm(true)
    answerConfirm(true)
    expect(yes).toHaveBeenCalledTimes(1)
    expect(no).not.toHaveBeenCalled()
    expect(useConfirm.getState().request).toBeNull()
  })

  it('cancel (Esc, "Huỷ", a click outside) runs onCancel only', () => {
    const yes = vi.fn()
    const no = vi.fn()
    askConfirm({ title: 'T', text: 'Q?', confirmLabel: 'OK', onConfirm: yes, onCancel: no })
    answerConfirm(false)
    expect(yes).not.toHaveBeenCalled()
    expect(no).toHaveBeenCalledTimes(1)
  })

  it('a newer question cancels the one still open (never two at once)', () => {
    const first = { yes: vi.fn(), no: vi.fn() }
    askConfirm({ title: '1', text: '1', confirmLabel: 'OK', onConfirm: first.yes, onCancel: first.no })
    const second = vi.fn()
    askConfirm({ title: '2', text: '2', confirmLabel: 'OK', onConfirm: second })
    expect(first.no).toHaveBeenCalledTimes(1)
    expect(useConfirm.getState().request?.title).toBe('2')
    answerConfirm(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first.yes).not.toHaveBeenCalled()
  })
})

describe('ConfirmSheet / Modal layer "top" (source guards: no DOM test environment)', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  it('the sheet is the shared Modal drawn above every dialog, Enter on the red button confirms', () => {
    const sheet = read('../../components/common/ConfirmSheet.tsx')
    expect(sheet).toContain('<Modal')
    expect(sheet).toContain('layer="top"')
    expect(sheet).toMatch(/autoFocus onClick=\{\(\) => answerConfirm\(true\)\}/)
  })
  it('a top Modal is a top overlay: the dialog under it leaves its keys alone, nothing reaches the shortcuts behind it', () => {
    const modal = read('../../components/common/Modal.tsx')
    expect(modal).toContain("data-top-overlay={top ? '' : undefined}")
    // an ordinary dialog still yields to a top overlay; a top one handles its own Escape
    expect(modal).toMatch(/if \(keyForTopOverlay\(e\)\) return/)
    expect(modal).toMatch(/if \(top\) e\.stopPropagation\(\)/)
    const css = read('../../components/common/common.css')
    expect(css).toMatch(/\.modal-backdrop\.is-top \{\n {2}z-index: 140;/)
  })
})

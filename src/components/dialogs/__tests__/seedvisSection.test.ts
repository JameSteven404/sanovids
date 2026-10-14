import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SeedvisKeyStatus } from '../../../providers/seedvis/contract'
import { SeedvisSection, type SeedvisSectionProps } from '../SeedvisSection'
import {
  DEFAULT_SEEDVIS_GUARD, SEEDVIS_CLIPBOARD_CLEARED_NOTE, seedvisAccountRows, seedvisActionBlock, seedvisCanSaveUnverified,
  seedvisClipboardNote, seedvisErrorText, seedvisGuardCommit, seedvisGuardValue, seedvisKeyLabel, seedvisKeyWarning,
  seedvisRestoreNote, type SeedvisKeyAction,
} from '../seedvisSectionModel'

const forcedPending = vi.hoisted(() => ({ value: null as SeedvisKeyAction | null }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  // Only the section's own `pending` state starts at null (the guard fields' drafts start as text).
  return { ...actual, useState: (initial: unknown) => actual.useState(initial === null && forcedPending.value ? forcedPending.value : initial) }
})

const empty: SeedvisKeyStatus = { hasKey: false, hint: null, tag: null, savedAt: null, verifiedAt: null, storage: 'safeStorage' }
const saved: SeedvisKeyStatus = { ...empty, hasKey: true, hint: 'AB12', tag: 'not-for-display', savedAt: 1, verifiedAt: 2 }
function render(props: Partial<SeedvisSectionProps> = {}) {
  return renderToStaticMarkup(createElement(SeedvisSection, {
    keyStatus: empty, account: null, platform: 'windows', activeTakes: 0, onAction: vi.fn(), onGuardChange: vi.fn(), ...props,
  }))
}

describe('seedvis settings', () => {
  it('renders empty state, defaults and clipboard history note without accepting any key input', () => {
    const onAction = vi.fn()
    const html = render({ onAction })
    expect(html).toContain('Chưa lưu API key')
    expect(html).toContain('Win+V')
    expect(html).toContain('máy khác')
    expect(html).not.toContain('Đã xoá key khỏi clipboard hiện tại.')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('Chế độ seedvis')
    expect(html).not.toContain('Nhập key')
    expect(html).toContain('Ảnh tham chiếu được gửi và lưu trên seedvis')
    expect(html).toContain('value="10"')
    expect(html).toContain('value="120"')
    expect(DEFAULT_SEEDVIS_GUARD).toEqual({ takes: 10, seconds: 120 })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('shows safe status on Windows/Mac, unreadable keys, unknown status and unavailable encryption', () => {
    expect(seedvisKeyLabel(saved, 'windows')).toContain('Đã lưu …AB12 · mã hoá bằng Windows')
    expect(seedvisKeyLabel(saved, 'mac')).toContain('Keychain')
    expect(seedvisKeyLabel({ ...saved, verifiedAt: null }, 'windows')).toContain('chưa kiểm tra')
    expect(seedvisKeyLabel({ ...saved, problem: 'unreadable' }, 'mac')).toContain('Không đọc được khoá')
    expect(seedvisKeyLabel({ ...empty, problem: 'unknown' }, 'windows')).toContain('Chưa đọc được trạng thái')
    expect(seedvisKeyLabel({ ...empty, storage: 'unavailable' }, 'windows')).toContain('chưa thể lưu')
    expect(render({ keyStatus: saved })).not.toContain(saved.tag)
    expect(render({ platform: 'web' })).toContain('chỉ dùng trong bản desktop')
  })

  it('blocks unavailable actions and permits deleting an unreadable key', () => {
    expect(seedvisActionBlock('paste', empty, 'windows', false)).toBeNull()
    expect(seedvisActionBlock('check', empty, 'windows', false)).toContain('Dán API key')
    expect(seedvisActionBlock('clear', empty, 'windows', false)).toContain('Chưa có khoá')
    expect(seedvisActionBlock('paste', { ...empty, storage: 'unavailable' }, 'windows', false)).toContain('mã hoá')
    expect(seedvisActionBlock('clear', { ...saved, problem: 'unreadable', storage: 'unavailable' }, 'mac', false)).toBeNull()
    for (const action of ['paste', 'enter', 'check', 'clear', 'billing'] as const) {
      expect(seedvisActionBlock(action, saved, 'web', false)).toBeTruthy()
      expect(seedvisActionBlock(action, saved, 'windows', true)).toBeTruthy()
    }
  })

  it('warns before replacing or deleting keys used by jobs in any project, without promising refunds', () => {
    for (const action of ['paste', 'enter', 'save-unverified', 'clear'] as const) {
      expect(seedvisKeyWarning(action, 0, saved)).toBeNull()
      const warning = seedvisKeyWarning(action, 4, saved)
      expect(warning).toContain('4 take seedvis đang chạy bằng khoá …AB12')
      expect(warning).toContain('dán lại đúng khoá này')
      expect(warning).toContain('bị trừ credit')
    }
    expect(seedvisKeyWarning('clear', 2, { ...saved, hint: null })).not.toContain('null')
  })

  it('does not warn when a paste puts the key back (none saved, or the saved one is unreadable)', () => {
    const cleared = { ...empty }
    const unreadable = { ...saved, problem: 'unreadable' as const }
    for (const action of ['paste', 'enter', 'save-unverified'] as const) {
      expect(seedvisKeyWarning(action, 3, cleared), action).toBeNull()
      expect(seedvisKeyWarning(action, 3, unreadable), action).toBeNull()
    }
    // Deleting an unreadable key while takes wait for it still asks first.
    expect(seedvisKeyWarning('clear', 3, unreadable)).toContain('Xoá khoá')
    expect(seedvisRestoreNote(cleared, 3, 'windows')).toBe('3 take seedvis đang chờ khoá đã gửi chúng — dán lại đúng khoá đó để tiếp tục theo dõi và tải video.')
    expect(seedvisRestoreNote(unreadable, 3, 'mac')).toBe('Dán lại đúng khoá …AB12 để tiếp tục theo dõi và tải 3 take seedvis.')
    expect(seedvisRestoreNote(saved, 3, 'windows')).toBeNull()
    expect(seedvisRestoreNote(cleared, 0, 'windows')).toBeNull()
    expect(seedvisRestoreNote(cleared, 3, 'web')).toBeNull()
    const html = render({ keyStatus: cleared, activeTakes: 3 })
    expect(html).toContain('đang chờ khoá đã gửi chúng')
    expect(html).not.toContain('Giữ khoá hiện tại')
  })

  it('renders a pending confirmation with explicit keep/delete choices without invoking a callback', () => {
    forcedPending.value = 'clear'
    try {
      const onAction = vi.fn()
      const html = render({ keyStatus: saved, activeTakes: 4, onAction })
      expect(html).toContain('4 take seedvis đang chạy bằng khoá …AB12')
      expect(html).toContain('Giữ khoá hiện tại')
      expect(html).toContain('Vẫn xoá khoá')
      expect(html).toContain('role="alert"')
      expect(onAction).not.toHaveBeenCalled()
    } finally { forcedPending.value = null }
  })

  it('shows all account limits, zero balance, disabled API and unknown retention without guesses', () => {
    const rows = seedvisAccountRows({ plan: 'Pro', api_enabled: false, credit_balance: 0, concurrency_limit: 2,
      queue_limit: 6, rate_limit_per_minute: 30, poll_rate_limit_per_minute: 60, poll_rate_limit_per_job_per_minute: 10 })
    expect(rows.map(row => row.value)).toEqual(['Pro', 'Gói không có quyền dùng API', '0 credit seedvis', '2 luồng', '6 job', '30 lượt', '60 lượt', '10 lượt', 'Chưa rõ — tuỳ gói seedvis'])
    expect(seedvisAccountRows({ credit_balance: NaN })[2].value).toBe('Chưa rõ')
    expect(seedvisAccountRows(null, '7 ngày').at(-1)?.value).toBe('7 ngày')
  })

  it('only shows dev controls, entry action and clipboard success when explicitly supplied', () => {
    expect(render({ devOpen: true, onModeChange: vi.fn(), mode: 'seedvis-dev', canEnterKey: true, clipboardCleared: true })).toContain('Chế độ seedvis')
    expect(render({ canEnterKey: true })).toContain('Nhập key')
    expect(render({ showPrivacyNote: false })).not.toContain('Ảnh tham chiếu được gửi')
    expect(render({ platform: 'mac' })).not.toContain('Win+V')
    expect(render()).not.toContain('Lưu mà chưa kiểm tra')
  })

  it('shows one clipboard note after a paste, never two that repeat each other', () => {
    const cleared = render({ clipboardCleared: true })
    expect(cleared).toContain(SEEDVIS_CLIPBOARD_CLEARED_NOTE)
    expect(cleared.match(/clipboard hiện tại/g)).toBeNull()
    expect(cleared.match(/Win\+V/g)).toHaveLength(1)
    expect(render().match(/clipboard hiện tại/g)).toHaveLength(1)
    expect(seedvisClipboardNote('mac', true)).toBe('Đã xoá key khỏi clipboard. Nếu dùng ứng dụng lưu hoặc đồng bộ clipboard, hãy xoá dòng chứa key ở đó.')
    expect(seedvisClipboardNote('mac', false)).not.toContain('Đã xoá')
  })

  it('reports errors as fixed text and escapes account text', () => {
    const html = render({ error: 'bad-key', account: { plan: '<script>alert(1)</script>' }, busy: 'check' })
    expect(html).toContain('API key không đúng.')
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('<script>')
  })

  it("shows the key-entry texts of §10.3 and prefers main's fixed message", () => {
    expect(seedvisErrorText('api-disabled')).toBe('Gói không có quyền dùng API.')
    expect(seedvisErrorText({ code: 'bad-format' })).toContain('Khoá seedvis thường bắt đầu bằng sv_live_.')
    expect(seedvisErrorText({ code: 'bad-format', message: 'Clipboard không chứa API key.' })).toBe('Clipboard không chứa API key. Khoá seedvis thường bắt đầu bằng sv_live_.')
    expect(seedvisErrorText({ code: 'bad-key', message: '  Khoá đã bị thu hồi trên seedvis.  ' })).toBe('Khoá đã bị thu hồi trên seedvis.')
    expect(seedvisErrorText({ code: 'bad-key', message: '' })).toBe('API key không đúng.')
    const html = render({ error: { code: 'api-disabled', message: 'Gói không có quyền dùng API.', action: 'check' } })
    expect(html).toContain('Gói không có quyền dùng API.')
    expect(html).not.toContain('Lưu mà chưa kiểm tra')
  })

  it('offers "Lưu mà chưa kiểm tra" only after a network failure while saving a new key', () => {
    for (const code of ['network', 'offline', 'timeout'] as const) {
      expect(seedvisCanSaveUnverified({ code, action: 'paste' }), code).toBe(true)
      expect(seedvisCanSaveUnverified({ code, action: 'enter' }), code).toBe(true)
      expect(seedvisCanSaveUnverified({ code, action: 'check' }), code).toBe(false)
      expect(seedvisCanSaveUnverified(code), code).toBe(false)
    }
    expect(seedvisCanSaveUnverified({ code: 'bad-key', action: 'paste' })).toBe(false)
    expect(seedvisCanSaveUnverified(null)).toBe(false)
    const html = render({ error: { code: 'network', message: 'Không kết nối được seedvis.', action: 'paste' } })
    expect(html).toContain('Lưu mà chưa kiểm tra')
    expect(html).toContain('Không kết nối được seedvis.')
    expect(seedvisActionBlock('save-unverified', { ...empty, storage: 'unavailable' }, 'windows', false)).toContain('mã hoá')
    expect(seedvisActionBlock('save-unverified', empty, 'web', false)).toBeTruthy()
  })

  it('accepts positive whole spending limits only', () => {
    for (const text of ['', '0', '-1', '1.5', 'Infinity', '1e3', '9007199254740992']) expect(seedvisGuardValue(text)).toBeNull()
    expect(seedvisGuardValue('10')).toBe(10)
    expect(seedvisGuardValue('120')).toBe(120)
  })

  it('commits a guard draft on blur / Enter and brings back the last value for an empty or invalid one', () => {
    // 10 → Backspace twice → "" → 5: the draft may be empty and the commit gives 5, never 15.
    expect(seedvisGuardCommit('5', 10)).toEqual({ value: 5, draft: '5' })
    expect(seedvisGuardCommit(' 05 ', 10)).toEqual({ value: 5, draft: '5' })
    for (const draft of ['', '0', '1.5', 'abc']) expect(seedvisGuardCommit(draft, 10), draft).toEqual({ value: 10, draft: '10' })
    // Keystrokes never reach onGuardChange: the fields are not bound to the saved guard.
    const source = readFileSync(new URL('../SeedvisSection.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/onChange=\{event => setDraft\(event\.target\.value\)\}/)
    expect(source).not.toMatch(/<input[^>]*value=\{guard/)
  })
})

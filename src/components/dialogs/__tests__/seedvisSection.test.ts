import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SeedvisKeyStatus } from '../../../providers/seedvis/contract'
import { SeedvisSection, type SeedvisSectionProps } from '../SeedvisSection'
import { DEFAULT_SEEDVIS_GUARD, seedvisAccountRows, seedvisActionBlock, seedvisGuardValue, seedvisKeyLabel, seedvisKeyWarning, type SeedvisKeyAction } from '../seedvisSectionModel'

const forcedPending = vi.hoisted(() => ({ value: null as SeedvisKeyAction | null }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => actual.useState(forcedPending.value ?? initial) }
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
    for (const action of ['paste', 'enter', 'clear'] as const) {
      expect(seedvisKeyWarning(action, 0, 'AB12')).toBeNull()
      const warning = seedvisKeyWarning(action, 4, 'AB12')
      expect(warning).toContain('4 take seedvis đang chạy bằng khoá …AB12')
      expect(warning).toContain('dán lại đúng khoá này')
      expect(warning).toContain('bị trừ credit')
    }
    expect(seedvisKeyWarning('clear', 2, null)).not.toContain('null')
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
    expect(render({ clipboardCleared: true })).toContain('Đã xoá key khỏi clipboard hiện tại.')
    expect(render({ showPrivacyNote: false })).not.toContain('Ảnh tham chiếu được gửi')
    expect(render({ platform: 'mac' })).not.toContain('Win+V')
  })

  it('reports errors as fixed text and escapes account text', () => {
    const html = render({ error: 'bad-key', account: { plan: '<script>alert(1)</script>' }, busy: 'check' })
    expect(html).toContain('API key không đúng.')
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('<script>')
  })

  it('accepts positive whole spending limits only', () => {
    for (const text of ['', '0', '-1', '1.5', 'Infinity', '1e3', '9007199254740992']) expect(seedvisGuardValue(text)).toBeNull()
    expect(seedvisGuardValue('10')).toBe(10)
    expect(seedvisGuardValue('120')).toBe(120)
  })
})

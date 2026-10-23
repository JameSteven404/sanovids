// Texts and small rules of the development-mode lock UI (devUnlockModel): every error code has a sentence, no sentence
// names an e-mail address, the hidden 5-taps-in-3-seconds gesture, time formats, the one-time notice rule, and the
// sources wired to them (no visible hint on the version line, the dev panel's single gate).
import { describe, expect, it } from 'vitest'
import * as M from '../devUnlockModel'
import aboutSource from '../../dialogs/SettingsBasic.tsx?raw'
import actionsSource from '../../../actions.ts?raw'
import devPanelSource from '../DevPanel.tsx?raw'

const ERRORS = [
  'malformed',
  'bad-signature',
  'newer-format',
  'unknown-key',
  'no-keys',
  'other-device',
  'expired',
  'used',
  'clock',
  'totp-none',
  'totp-wrong',
  'totp-replay',
  'totp-old',
  'totp-lost',
  'totp-skew',
  'wait',
  'too-fast',
  'link-used',
  'link-window',
  'write-failed',
  'locked',
  'build',
  'cap',
  'not-desktop',
]

describe('error sentences', () => {
  it('every error code has its own sentence (no fallback), with the device codes / minutes / wait filled in', () => {
    const fallback = M.unlockErrorText({ error: 'something-else' })
    for (const error of ERRORS) {
      const text = M.unlockErrorText({ error, thisDevice: '7KQ2-M9XD', codeDevice: 'AAAA-BBBB', minutes: 3, waitUntil: 1_000 + 300_000 }, { now: 1_000, clockSync: 'CÀI ĐẶT GIỜ' })
      expect(text, error).not.toBe(fallback)
      expect(text.length, error).toBeGreaterThan(10)
    }
    expect(M.unlockErrorText({ error: 'other-device', codeDevice: 'AAAA-BBBB', thisDevice: '7KQ2-M9XD' })).toBe('Mã này dành cho máy AAAA-BBBB. Mã máy này là 7KQ2-M9XD.')
    expect(M.unlockErrorText({ error: 'totp-wrong' }, { device: '7KQ2-M9XD' })).toContain('“SanoVids · Máy 7KQ2”')
    expect(M.unlockErrorText({ error: 'totp-old', minutes: 3 })).toContain('Chờ khoảng 3 phút')
    expect(M.unlockErrorText({ error: 'totp-skew', minutes: 4 }, { clockSync: 'X → Y' })).toContain('lệch khoảng 4 phút. Vào X → Y')
    expect(M.unlockErrorText({ error: 'wait', waitUntil: 301_000 }, { now: 1_000 })).toBe('Nhập sai nhiều lần. Thử lại sau 05:00.')
  })

  it('no sentence names an e-mail address', () => {
    const all = [
      ...ERRORS.map((error) => M.unlockErrorText({ error, thisDevice: 'AAAA-BBBB', codeDevice: 'CCCC-DDDD', minutes: 2, waitUntil: 5 })),
      ...(Object.values(M) as unknown[]).filter((v): v is string => typeof v === 'string'),
      M.unlockedToast({ until: null }, 'canvasapp.io.vn'),
      M.lockConfirm(2),
      M.unlinkConfirm('SanoVids · Máy 7KQ2'),
      M.linkDoneToast('SanoVids · Máy 7KQ2'),
    ]
    for (const s of all) expect(s).not.toContain('@')
  })
})

describe('the hidden gesture: 5 taps within 3 seconds', () => {
  it('fires on the 5th tap inside the window, forgets older taps, resets after firing', () => {
    let taps: number[] = []
    let fired = false
    for (const t of [0, 500, 1000, 1500]) {
      const r = M.nextTaps(taps, t)
      taps = r.times
      fired ||= r.fire
    }
    expect(fired).toBe(false)
    const fifth = M.nextTaps(taps, 2000)
    expect(fifth.fire).toBe(true)
    expect(fifth.times).toEqual([])
    // too slow: the first taps fall out of the 3 s window
    taps = []
    let slow = false
    for (const t of [0, 1000, 2000, 3100, 4000]) {
      const r = M.nextTaps(taps, t)
      taps = r.times
      slow ||= r.fire
    }
    expect(slow).toBe(false)
  })

  it('wired on the version line of Giới thiệu only while locked, with no pointer / title hint', () => {
    expect(aboutSource).toContain('<small onClick={onVersionTap}>{versionLine(version,')
    expect(aboutSource).toContain("const locked = useDevAccess((s) => s.state.access === 'locked')")
    expect(aboutSource).toMatch(/const onVersionTap = \(\) => \{\s+if \(!locked\) return/)
    const line = aboutSource.slice(aboutSource.indexOf('<small onClick={onVersionTap}>'), aboutSource.indexOf('</small>', aboutSource.indexOf('<small onClick={onVersionTap}>')))
    expect(line).not.toMatch(/title=|cursor|role=/)
  })
})

describe('formats and small rules', () => {
  it('mm:ss, m:ss, dd/MM/yyyy HH:mm', () => {
    expect(M.mmss(300_000)).toBe('05:00')
    expect(M.mmss(61_001)).toBe('01:02')
    expect(M.mmss(-5)).toBe('00:00')
    expect(M.mss(299_000)).toBe('4:59')
    expect(M.dateTimeText(new Date(2026, 9, 14, 9, 5).getTime())).toBe('14/10/2026 09:05')
  })

  it('status line, keep choices under a cap, link invite, lock toast', () => {
    expect(M.accessStatusLine({ access: 'build', until: null, method: null })).toContain('Mở sẵn')
    expect(M.accessStatusLine({ access: 'unlocked', until: null, method: 'totp' })).toBe('Đang mở khoá trên máy này cho tới khi khoá lại · mở bằng app xác thực')
    expect(M.accessStatusLine({ access: 'unlocked', until: new Date(2026, 9, 14, 9, 5).getTime(), method: 'code' })).toBe('Đang mở khoá trên máy này đến 14/10/2026 09:05 · mở bằng mã mở khoá')
    const now = 0
    expect(M.keepDisabled(0, null, now)).toBe(false)
    expect(M.keepDisabled(0, 2 * 86_400_000, now)).toBe(true)
    expect(M.keepDisabled(1, 2 * 86_400_000, now)).toBe(false)
    expect(M.keepDisabled(7, 2 * 86_400_000, now)).toBe(true)
    expect(M.linkInvite({ linkUntil: 120_000, totp: { linked: false, label: null, lost: false } }, 0)).toBe('Liên kết app xác thực để lần sau chỉ cần mã 6 số? Còn 2:00.')
    expect(M.linkInvite({ linkUntil: 120_000, totp: { linked: true, label: 'x', lost: false } }, 0)).toContain('Liên kết lại')
    expect(M.linkInvite({ linkUntil: 10, totp: { linked: false, label: null, lost: false } }, 20)).toBeNull()
    expect(M.lockToastText(null)).toBe('Đã khoá chế độ Phát triển.')
    expect(M.lockToastText('expired')).toContain('tự khoá')
    expect(M.lockToastText('clock-back')).toContain('đồng hồ')
    expect(M.unlockedToast({ until: null }, 'canvasapp.io.vn')).toBe(
      'Đã mở khoá chế độ Phát triển trên máy này cho tới khi khoá lại. Take mới vẫn dùng canvasapp.io.vn — đổi trong Cài đặt → Nhà cung cấp video.',
    )
    expect(M.lockConfirm(0)).not.toContain('take giả lập đang chạy')
    // DEV take badges stay after a lock: the question never promises every DEV label disappears
    expect(M.lockConfirm(0)).toContain('vẫn giữ nhãn DEV')
    expect(M.lockConfirm(0)).not.toContain('mọi chữ DEV')
    expect(M.lockConfirm(2)).toContain('2 take giả lập đang chạy vẫn chạy nốt')
  })

  it('one-time notice: locked + traces of the simulated server + not shown before; never turns the gateway on', () => {
    expect(M.shouldNoticeHidden({ access: 'locked', hasDevTraces: true, noticed: false })).toBe(true)
    expect(M.shouldNoticeHidden({ access: 'unlocked', hasDevTraces: true, noticed: false })).toBe(false)
    expect(M.shouldNoticeHidden({ access: 'locked', hasDevTraces: false, noticed: false })).toBe(false)
    expect(M.shouldNoticeHidden({ access: 'locked', hasDevTraces: true, noticed: true })).toBe(false)
    expect(M.shouldNoticeHidden({ access: 'locked', hasDevTraces: true, noticed: false, inSano: true })).toBe(false)
    expect(M.DEV_HIDDEN_NOTICE_KEY.startsWith('bdp:notice:')).toBe(true) // not bdp:hint: (reset clears those)
  })
})

describe('single gates', () => {
  it('openDevPanel does nothing while locked; the panel closes itself if the lock flips', () => {
    expect(actionsSource).toMatch(/export function openDevPanel\(tab\?: DevPanelTab\) \{[\s\S]{0,200}if \(!devAllowed\(\)\) return\s+useUI\.getState\(\)\.openDialog\(\{ kind: 'dev', tab \}\)/)
    expect(devPanelSource).toContain('const allowed = useDevAllowed()')
    expect(devPanelSource).toContain('if (!allowed) return null')
  })
})

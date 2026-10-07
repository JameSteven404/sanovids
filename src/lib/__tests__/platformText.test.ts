// lib/platformText: the OS-dependent phrases. Both platforms define every phrase (copy parity), a Mac never reads a
// Windows-only word (Windows, Ctrl, File Explorer, Unikey…) and Windows never reads a Mac-only one (Finder, ⌘, macOS…).
import { describe, expect, it } from 'vitest'
import { PLATFORM } from '../platform'
import { PLATFORM_TEXTS, platformText, textsFor, type PlatformTexts } from '../platformText'

const KEYS = Object.keys(PLATFORM_TEXTS.win) as (keyof PlatformTexts)[]
const WINDOWS_ONLY = /Windows|Ctrl|File Explorer|Explorer|PowerShell|Setup|Portable|Unikey|Tải xuống|Chuột phải|\.exe\b/
const MAC_ONLY = /macOS|\bMac\b|Finder|⌘|⌃|Keychain|Chuỗi khoá|Dock|Tải về|GoTiếngViệt|bấm hai ngón/

describe('copy parity', () => {
  it('both platforms define the same phrases, all non-empty, trimmed, NFC', () => {
    expect(Object.keys(PLATFORM_TEXTS.mac).sort()).toEqual([...KEYS].sort())
    expect(KEYS.length).toBeGreaterThanOrEqual(18)
    for (const p of ['win', 'mac'] as const) {
      for (const k of KEYS) {
        const v = PLATFORM_TEXTS[p][k]
        expect(typeof v, `${p}.${k}`).toBe('string')
        expect(v.length, `${p}.${k}`).toBeGreaterThan(0)
        expect(v.trim(), `${p}.${k}`).toBe(v)
        expect(v.normalize('NFC'), `${p}.${k}`).toBe(v)
      }
    }
  })

  it('a Mac never reads Windows-only words, Windows never reads Mac-only words', () => {
    for (const k of KEYS) {
      expect(PLATFORM_TEXTS.mac[k], `mac.${k}`).not.toMatch(WINDOWS_ONLY)
      expect(PLATFORM_TEXTS.win[k], `win.${k}`).not.toMatch(MAC_ONLY)
    }
  })

  it('every OS-dependent phrase really differs; only the app name is shared', () => {
    for (const k of KEYS) {
      if (k === 'desktopApp') expect(PLATFORM_TEXTS.mac[k]).toBe(PLATFORM_TEXTS.win[k])
      else expect(PLATFORM_TEXTS.mac[k], k).not.toBe(PLATFORM_TEXTS.win[k])
    }
  })
})

describe('the phrases of the plan (Mac plan §3.6.1)', () => {
  it('Windows', () => {
    const t = textsFor('win')
    expect(t).toMatchObject({
      os: 'Windows',
      fileManager: 'File Explorer',
      downloads: 'thư mục Tải xuống (Downloads)',
      trash: 'Thùng rác của Windows',
      saveDialog: 'hộp thoại Lưu của Windows',
      accountScope: 'theo tài khoản Windows',
      inputTools: 'Unikey, EVKey, OpenKey…',
      mod: 'Ctrl',
      modClick: 'Ctrl + bấm',
      modShiftClick: 'Ctrl/Shift + bấm',
      clockSync: 'Cài đặt Windows → Thời gian & ngôn ngữ → Đồng bộ ngay',
      desktopApp: 'bản desktop SanoVids',
    })
    // the Windows sentences already shipped in folderTrash keep their words
    expect(`Bản cũ vẫn nằm trong ${t.trash} — ${t.trashRestore}.`).toBe('Bản cũ vẫn nằm trong Thùng rác của Windows — mở Thùng rác để khôi phục.')
    expect(t.trashFailReason).toBe('(file đang mở trong chương trình khác, hoặc Thùng rác của ổ này đang tắt / đầy / không có)')
  })

  it('Mac', () => {
    const t = textsFor('mac')
    expect(t).toMatchObject({
      os: 'macOS',
      fileManager: 'Finder',
      downloads: 'thư mục Tải về (Downloads)',
      trash: 'Thùng rác',
      saveDialog: 'hộp thoại Lưu của macOS',
      accountScope: 'theo tài khoản người dùng trên máy Mac',
      inputTools: 'EVKey, OpenKey, GoTiếngViệt…',
      mod: '⌘',
      modClick: '⌘ + bấm',
      modShiftClick: '⌘/Shift + bấm',
      secondaryClick: '⌃ + bấm hoặc bấm hai ngón',
      systemSettings: 'Cài đặt hệ thống',
      clockSync: 'Cài đặt hệ thống → Chung → Ngày & Giờ',
      desktopApp: 'bản desktop SanoVids',
    })
    expect(`Bản cũ vẫn nằm trong ${t.trash} — ${t.trashRestore}.`).toBe('Bản cũ vẫn nằm trong Thùng rác — mở Thùng rác trên Dock rồi kéo file về thư mục.')
    expect(t.trashFailReason).toBe('(ổ này không có Thùng rác — ví dụ ổ mạng — hoặc macOS chưa cho SanoVids truy cập thư mục)')
    expect(t.encryptedWith).toContain('Keychain')
  })

  it('the modifier phrases start with the modifier key', () => {
    for (const p of ['win', 'mac'] as const) {
      const t = textsFor(p)
      expect(t.modClick.startsWith(t.mod), p).toBe(true)
      expect(t.modShiftClick.startsWith(`${t.mod}/Shift`), p).toBe(true)
    }
  })
})

describe('lookup', () => {
  it('textsFor picks the platform; anything unexpected is the Windows default', () => {
    expect(textsFor('mac')).toBe(PLATFORM_TEXTS.mac)
    expect(textsFor('win')).toBe(PLATFORM_TEXTS.win)
    expect(textsFor('linux' as never)).toBe(PLATFORM_TEXTS.win)
  })

  it('platformText is this device (lib/platform PLATFORM)', () => {
    expect(platformText).toBe(textsFor(PLATFORM))
  })

  it('the tables are frozen (no caller can change another surface’s words)', () => {
    expect(Object.isFrozen(PLATFORM_TEXTS)).toBe(true)
    expect(Object.isFrozen(PLATFORM_TEXTS.win)).toBe(true)
    expect(Object.isFrozen(PLATFORM_TEXTS.mac)).toBe(true)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { textsFor } from '../platformText'

afterEach(() => {
  vi.doUnmock('../platform')
  vi.resetModules()
})

describe.each(['win', 'mac'] as const)('%s renderer copy', (platform) => {
  it('uses the platform account, encryption, trash failure and restore instructions', async () => {
    vi.resetModules()
    vi.doMock('../platform', () => ({ PLATFORM: platform }))
    const login = await import('../../components/dialogs/keepLoginModel')
    const trash = await import('../../core/folderTrash')
    const t = textsFor(platform)
    const on = login.keepLoginHint({ ok: true, keepLogin: true, available: true, chosen: false })
    const off = login.keepLoginHint({ ok: true, keepLogin: false, available: true, chosen: false })
    expect(on).toContain(t.encryptedWith)
    expect(off).toContain(t.account)
    // Off without a choice = the placement default, with its reason (Portable on Windows, outside Applications on a Mac).
    expect(off).toBe(`${login.KEEP_LOGIN_HINT_OFF} ${platform === 'mac' ? login.KEEP_LOGIN_HINT_MAC_OUTSIDE : login.KEEP_LOGIN_HINT_PORTABLE}`)
    expect(login.keepLoginHint({ ok: true, keepLogin: false, available: true, chosen: true })).toBe(login.KEEP_LOGIN_HINT_OFF)
    if (platform === 'mac') expect(off).not.toContain('Portable')
    else expect(off).not.toContain('Applications')
    expect(trash.unlinkToast({ kind: 'failed', code: 'S01', folder: 'Video', name: 'Cảnh.mp4' })?.text).toContain(t.trashFailReason)
    expect(trash.trashConfirmText(4, ['Video'])).toContain(t.trash)
    expect(trash.restoreToastText(false, 'S01', 'Video')).toContain(t.trashRestore)
    expect(trash.FOLDER_UNLINK_TRASH_ROW.hint).toContain(t.trash)
    for (const enabled of [false, true]) expect(trash.saveWireTitle(true, enabled)).toContain(t.modShiftClick)
    if (platform === 'mac') expect([on, off, trash.FOLDER_UNLINK_TRASH_ROW.hint, trash.restoreToastText(false, 'S01', 'Video')].join(' ')).not.toMatch(/Windows|Ctrl|File Explorer/)
  })

  it('the Run button names the platform key (⌘ on a Mac)', async () => {
    vi.resetModules()
    vi.doMock('../platform', () => ({ PLATFORM: platform }))
    const node = await import('../../components/canvas/sceneNodeModel')
    const title = node.runButtonView(null, { cost: 20, kind: 'canvasapp', code: 'S02', duration: 15 }).title
    expect(title).toBe(`Tạo video cho S02 · 15 giây · 20 credit (${platform === 'mac' ? '⌘' : 'Ctrl'}+Enter)`)
  })
})

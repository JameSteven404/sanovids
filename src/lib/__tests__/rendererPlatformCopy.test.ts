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
    if (platform === 'mac') expect(off).not.toContain('Portable')
    else expect(off).toContain('Portable')
    expect(trash.unlinkToast({ kind: 'failed', code: 'S01', folder: 'Video', name: 'Cảnh.mp4' })?.text).toContain(t.trashFailReason)
    expect(trash.trashConfirmText(4, ['Video'])).toContain(t.trash)
    expect(trash.restoreToastText(false, 'S01', 'Video')).toContain(t.trashRestore)
    expect(trash.FOLDER_UNLINK_TRASH_ROW.hint).toContain(t.trash)
    for (const enabled of [false, true]) expect(trash.saveWireTitle(true, enabled)).toContain(t.modShiftClick)
    if (platform === 'mac') expect([on, off, trash.FOLDER_UNLINK_TRASH_ROW.hint, trash.restoreToastText(false, 'S01', 'Video')].join(' ')).not.toMatch(/Windows|Ctrl|File Explorer/)
  })
})

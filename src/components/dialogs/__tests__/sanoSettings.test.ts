// D226 (providers/sano CANVASAPP_IN_SANO off): inside SANO the Settings dialog names no canvasapp, on either level and in
// the "Khôi phục…" confirmation. The row texts are read at import, so each case imports the dialog fresh inside SANO.
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { stubInsideSano } from '../../../providers/__tests__/insideSano'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

it.each(['basic', 'advanced'])('inside SANO, Settings level %s: no canvasapp', async (level) => {
  stubInsideSano({ __SANO_GATEWAY__: { token: () => 'tok' } })
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'bdp:pref:settingsLevel' ? JSON.stringify(level) : null), setItem() {}, removeItem() {} })
  vi.resetModules()
  const { SettingsDialog } = await import('../SettingsDialog')
  const html = renderToStaticMarkup(createElement(SettingsDialog))
  expect(html).toContain(level === 'basic' ? 'Node cảnh là chỗ sửa: bấm' : 'Đưa mọi cài đặt trên máy này về như lúc mới cài')
  expect(html).not.toMatch(/canvasapp/i)
})

it('"Khôi phục…" confirmation: no canvasapp inside SANO, unchanged outside', async () => {
  const { resetAllConfirmText } = await import('../SettingsAdvanced')
  expect(resetAllConfirmText(false)).toContain('cổng canvasapp.io.vn về Tắt; khung bên')
  stubInsideSano()
  expect(resetAllConfirmText(false)).toMatch(/cập nhật; khung bên .* thư mục đã chọn giữ nguyên\.$/)
  expect(resetAllConfirmText(false)).not.toMatch(/canvasapp/i)
})

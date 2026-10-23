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

it('"Khôi phục…" confirmation: inside SANO it still says the provider choice is reset, without naming canvasapp', async () => {
  const { resetAllConfirmText } = await import('../SettingsAdvanced')
  // outside SANO: unchanged
  expect(resetAllConfirmText(false, false)).toContain('cập nhật; cổng canvasapp.io.vn về Tắt; khung bên')
  expect(resetAllConfirmText(false, false)).toMatch(/thư mục đã chọn và đăng nhập canvasapp giữ nguyên\.$/)
  // inside SANO (D226): the reset still changes SanoVids' saved provider choice on this computer — said, not hidden
  const inSano = resetAllConfirmText(false, true)
  expect(inSano).toContain('cập nhật; lựa chọn nhà cung cấp video của SanoVids trên máy này về mặc định; khung bên')
  expect(inSano).toMatch(/thư mục đã chọn giữ nguyên\.$/)
  expect(inSano).not.toMatch(/canvasapp/i)
  // development mode open: the simulator, in both
  expect(resetAllConfirmText(true, true)).toContain('nhà cung cấp video về Phát triển (giả lập); khung bên')
})

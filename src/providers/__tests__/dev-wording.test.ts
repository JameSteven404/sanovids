// Development-mode wording (providers/dev/wording.ts): the real gateway's messages, rewritten for 'dev' takes so they
// never send the user to canvasapp.io.vn for a job that only exists in the simulation.
import { describe, expect, it } from 'vitest'
import { CanvasappError, errorFromResponse } from '../canvasapp/api'
import { devError, devResult, devWording, withDevWording } from '../dev/wording'
import { downloadFailedError, DEV_UNKNOWN_SUBMIT_ERROR, hasUncertainSubmitText, unknownSubmitError, UNKNOWN_SUBMIT_ERROR } from '../../store/runs'

describe('devWording', () => {
  it('points to the Bảng phát triển and names the simulation; idempotent', () => {
    const gone = 'Không thấy job trên canvasapp nữa (đã bị xoá?). Kiểm tra trên canvasapp.io.vn.'
    expect(devWording(gone)).toBe('Không thấy job trên canvasapp nữa (đã bị xoá?). Kiểm tra trong Bảng phát triển.')
    expect(devWording('… — kiểm tra trên canvasapp.io.vn trước khi chạy lại.')).toBe('… — kiểm tra trong Bảng phát triển trước khi chạy lại.')
    const login = errorFromResponse({ status: 401, contentType: 'application/json', json: { detail: 'Not authenticated' } }).message
    expect(login).toContain('Nhà cung cấp video') // the Settings section that exists now
    expect(login).not.toContain('Cổng canvasapp')
    expect(devWording(login)).toBe(login.replace('canvasapp.io.vn', 'canvasapp giả lập'))
    for (const t of [gone, login, 'Không kết nối được tới canvasapp.io.vn.']) {
      expect(devWording(t)).not.toContain('canvasapp.io.vn')
      expect(devWording(devWording(t))).toBe(devWording(t))
    }
  })

  it('devError keeps the error (code, status, flags) and only changes its words; devResult rewrites error / reason', () => {
    const e = new CanvasappError('network', 'Không kết nối được tới canvasapp.io.vn.', { uncertain: true, status: 0 })
    expect(devError(e)).toBe(e)
    expect(e).toMatchObject({ code: 'network', uncertain: true, message: 'Không kết nối được tới canvasapp giả lập.' })
    expect(devError('x')).toBe('x')
    expect(devResult([{ remoteId: 'a', state: 'failed', error: 'Kiểm tra trên canvasapp.io.vn.' }, { remoteId: 'b', state: 'processing' }])).toEqual([
      { remoteId: 'a', state: 'failed', error: 'Kiểm tra trong Bảng phát triển.' },
      { remoteId: 'b', state: 'processing' },
    ])
    expect(devResult({ ok: false, reason: 'Chưa đăng nhập canvasapp.io.vn.' })).toEqual({ ok: false, reason: 'Chưa đăng nhập canvasapp giả lập.' })
    const blob = new Blob(['v'])
    expect(devResult(blob)).toBe(blob)
  })

  it('withDevWording wraps every method (sync, async, throwing) and maps the listed results', async () => {
    const target = {
      id: 'dev',
      sync: (n: number) => n + 1,
      boom: () => {
        throw new Error('canvasapp.io.vn sập')
      },
      later: async () => {
        throw new CanvasappError('server', 'canvasapp.io.vn đang lỗi máy chủ — thử lại sau.')
      },
      poll: async () => [{ remoteId: 'r', state: 'failed' as const, error: 'Kiểm tra trên canvasapp.io.vn.' }],
    }
    const w = withDevWording(target, { poll: devResult })
    expect(w.id).toBe('dev')
    expect(w.sync(1)).toBe(2)
    expect(() => w.boom()).toThrow('canvasapp giả lập sập')
    await expect(w.later()).rejects.toMatchObject({ code: 'server', message: 'canvasapp giả lập đang lỗi máy chủ — thử lại sau.' })
    expect(await w.poll()).toEqual([{ remoteId: 'r', state: 'failed', error: 'Kiểm tra trong Bảng phát triển.' }])
  })
})

describe('engine texts per provider (store/runs)', () => {
  it('"không rõ đã gửi" and "không tải được video" send a dev take to the Bảng phát triển', () => {
    expect(unknownSubmitError('canvasapp')).toBe(UNKNOWN_SUBMIT_ERROR)
    expect(unknownSubmitError('dev')).toBe(DEV_UNKNOWN_SUBMIT_ERROR)
    expect(DEV_UNKNOWN_SUBMIT_ERROR).toContain('Bảng phát triển')
    expect(DEV_UNKNOWN_SUBMIT_ERROR).not.toContain('canvasapp.io.vn')
    // still recognised as "maybe billed" (takes saved with the text only)
    expect(hasUncertainSubmitText(DEV_UNKNOWN_SUBMIT_ERROR)).toBe(true)
    expect(hasUncertainSubmitText(UNKNOWN_SUBMIT_ERROR)).toBe(true)
    expect(downloadFailedError('HTTP 503', 'canvasapp')).toContain('Tải video trực tiếp trên canvasapp.io.vn')
    const dev = downloadFailedError('HTTP 503', 'dev')
    expect(dev).toContain('HTTP 503.')
    expect(dev).toContain('Bảng phát triển')
    expect(dev).not.toContain('canvasapp.io.vn')
  })
})

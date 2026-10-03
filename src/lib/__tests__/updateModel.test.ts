// Auto-update UI model (lib/updateModel): received states are validated, release notes never render HTML, numbers and
// dates read in Vietnamese, and the pill / dialog / toasts say exactly what the spec says for every state.
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  autoDownloadNote,
  dialogView,
  formatBytes,
  formatPercent,
  formatReleaseDate,
  formatSpeed,
  hasUpdateDetails,
  installBlockers,
  lastCheckText,
  manualCheckToast,
  noteBlocks,
  noticeToast,
  parseUpdateState,
  pillView,
  settingsIntroTitle,
  settingsStatusLine,
  UPDATE_ERROR_TEXT,
  type UpdateDialogCtx,
} from '../updateModel'
import type { UpdateKind, UpdateState, UpdateStatus } from '../updateTypes'

const base: UpdateState = { kind: 'installer', current: '0.5.0', status: 'idle', autoDownload: true }
const st = (patch: Partial<UpdateState>): UpdateState => ({ ...base, ...patch })
const MB = 1024 * 1024

describe('parseUpdateState', () => {
  const fallback = st({ status: 'none', current: '0.4.2' })

  it('keeps a valid state as it is', () => {
    const s: UpdateState = {
      kind: 'installer',
      current: '0.5.0',
      status: 'downloading',
      version: '0.5.1',
      releaseDate: '2026-10-03T08:00:00.000Z',
      notes: '## Có gì mới',
      size: 98 * MB,
      percent: 42.5,
      transferred: 41 * MB,
      total: 98 * MB,
      bytesPerSecond: 2 * MB,
      lastCheck: 1,
      autoDownload: false,
      notice: { kind: 'updated', from: '0.4.2', version: '0.5.0' },
    }
    expect(parseUpdateState(s, fallback)).toEqual(s)
    expect(parseUpdateState({ ...base, status: 'error', error: { code: 'offline', message: 'x' } }, fallback).error).toEqual({ code: 'offline', message: 'x' })
  })

  it('a wrong root, kind or status gives the fallback', () => {
    for (const raw of [null, undefined, 'ready', 42, [], { ...base, kind: 'store' }, { ...base, status: 'installing' }, { status: 'ready' }]) {
      expect(parseUpdateState(raw, fallback)).toBe(fallback)
    }
  })

  it('drops wrong optional fields, caps strings, clamps numbers', () => {
    const s = parseUpdateState(
      {
        ...base,
        current: 'x'.repeat(200),
        autoDownload: 'yes',
        status: 'available',
        version: '0.5.1<script>',
        releaseDate: 'd'.repeat(100),
        notes: 'n'.repeat(20_000),
        size: Number.NaN,
        percent: 250,
        transferred: -5,
        total: Number.POSITIVE_INFINITY,
        bytesPerSecond: '9',
        lastCheck: null,
        error: { code: 'boom', message: 'raw stack' },
        notice: { kind: 'updated', from: '0.4.2', version: 'nope' },
        extra: { injected: true },
      },
      fallback,
    )
    expect(s.current).toHaveLength(64)
    expect(s.autoDownload).toBe(true) // fallback's
    expect(s.version).toBeUndefined()
    expect(s.releaseDate).toHaveLength(40)
    expect(s.notes).toHaveLength(8000)
    expect(s.percent).toBe(100)
    for (const k of ['size', 'transferred', 'total', 'bytesPerSecond', 'lastCheck', 'error', 'notice', 'extra'] as const) expect(s).not.toHaveProperty(k)
    expect(parseUpdateState({ ...base, version: '1'.repeat(70) + '.0.0' }, fallback).version).toBeUndefined()
    expect(parseUpdateState({ ...base, error: { code: 'failed', message: 'm'.repeat(1000) } }, fallback).error?.message).toHaveLength(300)
    expect(parseUpdateState({ ...base, notice: { kind: 'install-failed', version: '0.5.1' } }, fallback).notice).toEqual({ kind: 'install-failed', version: '0.5.1' })
    expect(parseUpdateState({ ...base, version: '1.2.3-beta.1' }, fallback).version).toBe('1.2.3-beta.1')
  })
})

describe('noteBlocks', () => {
  it('headings, list items and paragraphs, markdown cleaned', () => {
    expect(noteBlocks('## Có gì mới\r\n- ✨ **Tự cập nhật** trong nền\n* `code` và __đậm__\n• chấm\n\nXem [trang](https://x.y) ![ảnh](a.png)')).toEqual([
      { kind: 'h', text: 'Có gì mới' },
      { kind: 'li', text: '✨ Tự cập nhật trong nền' },
      { kind: 'li', text: 'code và đậm' },
      { kind: 'li', text: 'chấm' },
      { kind: 'p', text: 'Xem trang ảnh' },
    ])
  })

  it('HTML never survives: tags are stripped, their text stays', () => {
    const blocks = noteBlocks('- <b>không phải HTML</b>\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>')
    expect(blocks).toEqual([
      { kind: 'li', text: 'không phải HTML' },
      { kind: 'p', text: 'alert(1)' },
    ])
    expect(JSON.stringify(blocks)).not.toMatch(/[<>]/)
  })

  it('comparisons and placeholders are text, not tags', () => {
    expect(noteBlocks('- Giá < 5 và > 3\n- dùng <phiên bản> mới\n- `release/ban-cu/<version>/`')).toEqual([
      { kind: 'li', text: 'Giá < 5 và > 3' },
      { kind: 'li', text: 'dùng <phiên bản> mới' },
      { kind: 'li', text: 'release/ban-cu/<version>/' },
    ])
  })

  it('caps: 80 blocks of 500 chars', () => {
    expect(noteBlocks(Array.from({ length: 200 }, (_, i) => `dòng ${i}`).join('\n'))).toHaveLength(80)
    expect(noteBlocks('a'.repeat(2000))[0].text).toHaveLength(500)
    expect(noteBlocks('')).toEqual([])
    expect(noteBlocks(undefined)).toEqual([])
    expect(noteBlocks('\n  \n')).toEqual([])
  })
})

describe('numbers and dates', () => {
  it('formatBytes / formatSpeed / formatPercent', () => {
    expect(formatBytes(93.5 * MB)).toBe('93,5 MB')
    expect(formatBytes(98 * MB)).toBe('98 MB')
    expect(formatBytes(41.24 * MB)).toBe('41,2 MB')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1,5 KB')
    expect(formatBytes(150 * MB)).toBe('150 MB')
    expect(formatBytes(2.25 * 1024 * MB)).toBe('2,3 GB')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatSpeed(2.1 * MB)).toBe('2,1 MB/giây')
    expect(formatPercent(42.9)).toBe('42%')
    expect(formatPercent(140)).toBe('100%')
    expect(formatPercent(-3)).toBe('0%')
    expect(formatPercent(undefined)).toBe('0%')
  })

  it('formatReleaseDate', () => {
    expect(formatReleaseDate('2026-10-03T12:00:00.000Z')).toBe('03/10/2026')
    expect(formatReleaseDate('garbage')).toBe('')
    expect(formatReleaseDate(undefined)).toBe('')
  })

  it('lastCheckText', () => {
    const now = new Date(2026, 9, 3, 15, 30).getTime()
    expect(lastCheckText(now - 20_000, now)).toBe('vừa xong')
    expect(lastCheckText(now + 5_000, now)).toBe('vừa xong') // clock skew
    expect(lastCheckText(now - 5 * 60_000, now)).toBe('5 phút trước')
    expect(lastCheckText(new Date(2026, 9, 3, 9, 5).getTime(), now)).toBe('lúc 09:05 hôm nay')
    expect(lastCheckText(new Date(2026, 9, 2, 23, 40).getTime(), now)).toBe('lúc 23:40, 02/10')
  })
})

describe('installBlockers', () => {
  const none = { queued: 0, processing: 0, sending: 0, pendingDownloads: 0, topupInFlight: false }
  it('nothing in progress → no lines', () => {
    expect(installBlockers(none)).toEqual([])
  })
  it('each kind of work, zero parts left out', () => {
    expect(installBlockers({ ...none, processing: 2, queued: 3 })).toEqual(['2 video đang tạo · 3 video đang chờ'])
    expect(installBlockers({ ...none, queued: 1 })).toEqual(['1 video đang chờ'])
    expect(installBlockers({ queued: 0, processing: 1, sending: 1, pendingDownloads: 4, topupInFlight: true })).toEqual([
      '1 video đang tạo',
      '1 video đang được gửi đi — SanoVids sẽ đợi gửi xong rồi mới khởi động lại.',
      'Đang nạp credit — nên đợi xong rồi hãy cập nhật.',
      '4 video đang chờ lưu vào thư mục — sẽ mất nếu khởi động lại.',
    ])
  })
})

describe('pillView', () => {
  const statuses: UpdateStatus[] = ['idle', 'checking', 'none', 'available', 'downloading', 'ready', 'error', 'unsupported']
  const ctx = { installWhenIdle: false, activeJobs: 0 }

  it('hidden for idle / checking / none / error / unsupported, and for every dev build', () => {
    for (const status of ['idle', 'checking', 'none', 'error', 'unsupported'] as UpdateStatus[]) {
      for (const kind of ['installer', 'portable', 'dev'] as UpdateKind[]) expect(pillView(st({ kind, status, version: '0.5.1' }), ctx)).toBeNull()
    }
    for (const status of statuses) {
      expect(pillView(st({ kind: 'dev', status, version: '0.5.1' }), ctx)).toBeNull()
      expect(pillView(st({ kind: 'dev', status, version: '0.5.1' }), { installWhenIdle: true, activeJobs: 2 })).toBeNull()
    }
  })

  it('installer: available, downloading, ready, waiting', () => {
    expect(pillView(st({ status: 'available', version: '0.5.1' }), ctx)).toEqual({
      tone: 'available',
      long: 'Có bản ',
      short: '0.5.1',
      title: 'Có bản SanoVids 0.5.1 — bấm để xem',
      version: '0.5.1',
    })
    expect(pillView(st({ status: 'downloading', version: '0.5.1', percent: 42.7 }), ctx)).toEqual({
      tone: 'downloading',
      long: 'Đang tải ',
      short: '42%',
      title: 'Đang tải bản SanoVids 0.5.1 (42%). Bạn cứ làm việc bình thường.',
      version: '0.5.1',
    })
    expect(pillView(st({ status: 'ready', version: '0.5.1' }), ctx)).toMatchObject({
      tone: 'ready',
      long: 'Cập nhật ',
      short: '0.5.1',
      title: 'Bản SanoVids 0.5.1 đã tải xong — bấm để khởi động lại và cập nhật',
    })
    expect(pillView(st({ status: 'ready', version: '0.5.1' }), { installWhenIdle: true, activeJobs: 3 })).toEqual({
      tone: 'waiting',
      long: '',
      short: 'Chờ cập nhật',
      title: 'SanoVids sẽ khởi động lại để cập nhật lên 0.5.1 khi xong 3 video. Bấm để xem.',
      version: '0.5.1',
    })
    // waiting for something other than videos (a top-up, downloads waiting for a folder): never "0 video"
    expect(pillView(st({ status: 'ready', version: '0.5.1' }), { installWhenIdle: true, activeJobs: 0 })?.title).toBe(
      'SanoVids sẽ khởi động lại để cập nhật lên 0.5.1 khi xong các việc đang dở. Bấm để xem.',
    )
    // waiting only applies to a downloaded update
    expect(pillView(st({ status: 'available', version: '0.5.1' }), { installWhenIdle: true, activeJobs: 3 })?.tone).toBe('available')
  })

  it('portable: only "available", pointing to the download page', () => {
    expect(pillView(st({ kind: 'portable', status: 'available', version: '0.5.1' }), ctx)).toEqual({
      tone: 'available',
      long: 'Bản mới ',
      short: '0.5.1',
      title: 'Có bản SanoVids 0.5.1 — bấm để xem cách tải',
      version: '0.5.1',
    })
    for (const status of ['downloading', 'ready'] as UpdateStatus[]) expect(pillView(st({ kind: 'portable', status, version: '0.5.1' }), ctx)).toBeNull()
  })

  it('no version → nothing to show', () => {
    expect(pillView(st({ status: 'available' }), ctx)).toBeNull()
  })
})

describe('dialogView', () => {
  const ctx: UpdateDialogCtx = { blockers: [], installWhenIdle: false, autoDownload: true, busy: null }
  const ids = (v: ReturnType<typeof dialogView>) => v.actions.map((a) => `${a.id}${a.primary ? '*' : ''}`)

  it('checking / none / dev / unsupported', () => {
    expect(dialogView(st({ status: 'checking' }), ctx)).toMatchObject({ statusText: 'Đang kiểm tra bản mới…' })
    expect(ids(dialogView(st({ status: 'checking' }), ctx))).toEqual(['close'])
    const none = dialogView(st({ status: 'none' }), ctx)
    expect(none.statusText).toBe('Bạn đang dùng bản mới nhất (0.5.0).')
    expect(ids(none)).toEqual(['close'])
    expect(none.showNotes).toBe(false)
    for (const s of [st({ kind: 'dev', status: 'unsupported' }), st({ kind: 'dev', status: 'ready', version: '0.5.1' })]) {
      expect(dialogView(s, ctx)).toMatchObject({ statusText: 'Bản này không tự cập nhật.' })
      expect(ids(dialogView(s, ctx))).toEqual(['close'])
    }
    // packaged build whose updater could not load
    expect(dialogView(st({ status: 'unsupported', error: { code: 'failed', message: 'Trình cập nhật không chạy được trong bản này.' } }), ctx).statusText).toBe(
      'Trình cập nhật không chạy được trong bản này.',
    )
    expect(ids(dialogView(st({ status: 'idle' }), ctx))).toEqual(['retry*', 'close'])
  })

  it('installer available: auto on / off', () => {
    const on = dialogView(st({ status: 'available', version: '0.5.1' }), ctx)
    expect(on.statusText).toBe('Đang chuẩn bị tải về…')
    expect(ids(on)).toEqual(['close'])
    expect(on.showNotes).toBe(true)
    const off = dialogView(st({ status: 'available', version: '0.5.1' }), { ...ctx, autoDownload: false })
    expect(off.statusText).toBe('Bấm “Tải bản cập nhật” để tải về. Trong lúc tải bạn vẫn làm việc bình thường.')
    expect(off.actions).toEqual([
      { id: 'download', label: 'Tải bản cập nhật', primary: true },
      { id: 'later', label: 'Để sau' },
    ])
  })

  it('downloading', () => {
    const v = dialogView(st({ status: 'downloading', version: '0.5.1', percent: 42, transferred: 41 * MB, total: 98 * MB, bytesPerSecond: 2.1 * MB }), ctx)
    expect(v.statusText).toBe('Đang tải về… 42% · 41 MB / 98 MB · 2,1 MB/giây')
    expect(v.hint).toBe('Bạn cứ làm việc bình thường — tải xong SanoVids sẽ báo.')
    expect(v.showProgress).toBe(true)
    expect(ids(v)).toEqual(['close'])
    expect(dialogView(st({ status: 'downloading', version: '0.5.1', percent: 0 }), ctx).statusText).toBe('Đang tải về… 0%')
  })

  it('ready: no blockers / blockers / waiting / busy', () => {
    const ready = st({ status: 'ready', version: '0.5.1', percent: 100 })
    const free = dialogView(ready, ctx)
    expect(free.statusText).toBe('Đã tải xong. Khởi động lại để cập nhật ngay — dự án, video và cài đặt giữ nguyên.')
    expect(free.hint).toBe('Chọn “Để sau” thì bản mới tự cài khi bạn tắt SanoVids.')
    expect(free.actions).toEqual([
      { id: 'restart', label: 'Khởi động lại để cập nhật', primary: true },
      { id: 'later', label: 'Để sau' },
    ])
    expect(free.callout).toBeUndefined()

    const busyWork = dialogView(ready, { ...ctx, blockers: ['2 video đang tạo'] })
    expect(busyWork.statusText).toBe('Đã tải xong. Có thể cập nhật khi xong việc đang dở, hoặc cập nhật ngay — dự án, video và cài đặt giữ nguyên.')
    expect(busyWork.callout?.title).toBe('Đang có việc chưa xong:')
    // only real work in the list; the reassurance is a paragraph under it
    expect(busyWork.callout?.lines).toEqual(['2 video đang tạo'])
    expect(busyWork.callout?.note).toMatch(/^Cập nhật ngay vẫn an toàn: .*Không bị trừ credit hai lần\.$/)
    expect(busyWork.actions).toEqual([
      { id: 'installWhenIdle', label: 'Cập nhật khi xong', primary: true },
      { id: 'installNow', label: 'Cập nhật ngay' },
      { id: 'later', label: 'Để sau' },
    ])

    const waiting = dialogView(ready, { ...ctx, blockers: ['2 video đang tạo'], installWhenIdle: true, activeJobs: 2 })
    expect(waiting.callout).toEqual({
      title: 'Sẽ tự khởi động lại để cập nhật khi xong 2 video.',
      lines: ['2 video đang tạo'],
      note: 'Nếu video bị kẹt (hết credit, cần đăng nhập…), bấm “Cập nhật ngay” hoặc “Huỷ chờ”.',
    })
    expect(ids(waiting)).toEqual(['installNow*', 'cancelWait', 'close'])
    // waiting for downloads that need a folder: says so, never "0 video"
    const folder = '1 video đang chờ lưu vào thư mục — sẽ mất nếu khởi động lại.'
    const waitingFolder = dialogView(ready, { ...ctx, blockers: [folder], installWhenIdle: true, activeJobs: 0 })
    expect(waitingFolder.callout).toMatchObject({ title: 'Sẽ tự khởi động lại để cập nhật khi xong các việc đang dở.', lines: [folder] })

    expect(dialogView(ready, { ...ctx, busy: 'waiting-send' }).busyText).toBe('Đang đợi gửi xong video…')
    expect(dialogView(ready, { ...ctx, busy: 'saving' }).busyText).toBe('Đang lưu dự án…')
    expect(dialogView(ready, { ...ctx, busy: 'restarting' }).busyText).toBe('Đang khởi động lại…')
    expect(free.busyText).toBeUndefined()
    // a failed install attempt is explained
    expect(dialogView({ ...ready, error: { code: 'install-failed', message: UPDATE_ERROR_TEXT['install-failed'] } }, ctx).hint).toBe(UPDATE_ERROR_TEXT['install-failed'])
  })

  it('portable available → the download page', () => {
    const v = dialogView(st({ kind: 'portable', status: 'available', version: '0.5.1' }), ctx)
    expect(v.statusText).toMatch(/^Bản portable không tự cài được\. .*hãy cài bản Setup\.$/)
    expect(v.actions).toEqual([
      { id: 'openPage', label: 'Tải bản mới', primary: true, title: 'Mở trang tải về trên GitHub trong trình duyệt' },
      { id: 'later', label: 'Để sau' },
    ])
  })

  it('error', () => {
    const v = dialogView(st({ status: 'error', error: { code: 'offline', message: UPDATE_ERROR_TEXT.offline } }), ctx)
    expect(v.statusText).toBe('Không kết nối được máy chủ cập nhật. SanoVids sẽ tự thử lại sau.')
    expect(ids(v)).toEqual(['retry*', 'close'])
    expect(v.actions[0].label).toBe('Thử lại')
    expect(v.showNotes).toBe(false)
    expect(dialogView(st({ status: 'error', version: '0.5.1', error: { code: 'checksum', message: UPDATE_ERROR_TEXT.checksum } }), ctx).showNotes).toBe(true)
  })

  it('signature refused: the text as is (no automatic retry), the download page first', () => {
    const v = dialogView(st({ status: 'error', version: '0.5.92', error: { code: 'signature', message: UPDATE_ERROR_TEXT.signature } }), ctx)
    expect(v.statusText).toBe(
      'Không xác minh được chữ ký số của tác giả trên bản cập nhật nên SanoVids đã bỏ file đó, không cài. Hãy tải bộ cài ở trang tải về rồi cài đè lên bản đang dùng.',
    )
    expect(v.statusText).not.toContain('tự thử lại')
    expect(v.actions).toEqual([
      { id: 'openPage', label: 'Mở trang tải về', primary: true, title: 'Mở trang tải về trên GitHub trong trình duyệt' },
      { id: 'retry', label: 'Thử lại' },
      { id: 'close', label: 'Đóng' },
    ])
    expect(v.showNotes).toBe(true)
    expect(v.showProgress).toBe(false)
    expect(dialogView(st({ status: 'error', error: { code: 'signature', message: UPDATE_ERROR_TEXT.signature } }), ctx).showNotes).toBe(false)
    // Other errors keep the automatic-retry sentence and "Thử lại" first.
    expect(ids(dialogView(st({ status: 'error', version: '0.5.92', error: { code: 'checksum', message: UPDATE_ERROR_TEXT.checksum } }), ctx))).toEqual(['retry*', 'close'])
  })

  it('"Xem chi tiết" also leads to a version refused for its signature (its dialog offers the download page)', () => {
    const sig = { code: 'signature' as const, message: UPDATE_ERROR_TEXT.signature }
    expect(hasUpdateDetails(st({ status: 'error', version: '0.5.92', error: sig }))).toBe(true)
    expect(hasUpdateDetails(st({ status: 'error', error: sig }))).toBe(false)
    expect(hasUpdateDetails(st({ status: 'error', version: '0.5.92', error: { code: 'checksum', message: UPDATE_ERROR_TEXT.checksum } }))).toBe(false)
    expect(hasUpdateDetails(st({ kind: 'dev', status: 'error', version: '0.5.92', error: sig }))).toBe(false)
    for (const status of ['available', 'downloading', 'ready'] as const) expect(hasUpdateDetails(st({ status, version: '0.5.1' }))).toBe(true)
    expect(hasUpdateDetails(st({ status: 'none' }))).toBe(false)
  })

  it('the signature text is the one main sends (electron/updater-rules.cjs)', () => {
    const mainRules = createRequire(import.meta.url)('../../../electron/updater-rules.cjs') as { ERROR_TEXT: Record<string, string> }
    expect(UPDATE_ERROR_TEXT.signature).toBe(mainRules.ERROR_TEXT.signature)
    expect(UPDATE_ERROR_TEXT.signature.length).toBeLessThanOrEqual(300)
    for (const code of Object.keys(mainRules.ERROR_TEXT)) expect(UPDATE_ERROR_TEXT[code as keyof typeof UPDATE_ERROR_TEXT], code).toBe(mainRules.ERROR_TEXT[code])
  })
})

describe('Settings texts', () => {
  it('intro title and status lines', () => {
    expect(settingsIntroTitle(st({}), false)).toBe('Phiên bản 0.5.0 · Bản cài')
    expect(settingsIntroTitle(st({ kind: 'portable' }), false)).toBe('Phiên bản 0.5.0 · Bản portable')
    expect(settingsIntroTitle(st({ kind: 'dev', status: 'unsupported' }), true)).toBe('Phiên bản 0.5.0 · Trình duyệt')
    expect(settingsIntroTitle(st({ kind: 'dev', status: 'unsupported' }), false)).toBe('Phiên bản 0.5.0 · Bản phát triển')
    const line = (s: UpdateState, autoDownload = true, web = false) => settingsStatusLine(s, { web, autoDownload })
    expect(line(st({}))).toBe('Chưa kiểm tra trong lần mở này.')
    expect(line(st({ status: 'checking' }))).toBe('Đang kiểm tra…')
    expect(line(st({ status: 'none' }))).toBe('Bạn đang dùng bản mới nhất.')
    expect(line(st({ status: 'available', version: '0.5.1' }))).toBe('Có bản 0.5.1 — đang tải về.')
    expect(line(st({ status: 'available', version: '0.5.1' }), false)).toBe('Có bản 0.5.1 — bấm “Xem chi tiết” để tải.')
    expect(line(st({ kind: 'portable', status: 'available', version: '0.5.1' }))).toBe('Có bản 0.5.1 — tải ở trang tải về.')
    expect(line(st({ status: 'downloading', version: '0.5.1', percent: 42 }))).toBe('Đang tải bản 0.5.1… 42%')
    expect(line(st({ status: 'ready', version: '0.5.1' }))).toBe('Bản 0.5.1 đã tải xong — khởi động lại để cập nhật (hoặc tự cài khi tắt app).')
    expect(line(st({ status: 'error', error: { code: 'offline', message: UPDATE_ERROR_TEXT.offline } }))).toBe(UPDATE_ERROR_TEXT.offline)
    expect(line(st({ kind: 'dev', status: 'unsupported' }))).toBe('Bản chạy từ mã nguồn không tự cập nhật.')
    expect(line(st({ kind: 'dev', status: 'unsupported' }), true, true)).toBe('Trên trình duyệt luôn dùng bản mới nhất; tự cập nhật chỉ có ở bản cài Windows.')
  })

  it('auto-download note', () => {
    expect(autoDownloadNote('installer')).toBeNull()
    expect(autoDownloadNote('portable')).toBe('Bản portable không tự cài — chỉ báo có bản mới.')
    expect(autoDownloadNote('dev')).toBe('Chỉ có ở bản cài (Setup).')
  })
})

describe('toasts', () => {
  it('manualCheckToast', () => {
    const ok = { ok: true } as const
    expect(manualCheckToast(st({ status: 'none' }), ok)).toEqual({ text: 'Bạn đang dùng bản mới nhất (0.5.0).', tone: 'success' })
    expect(manualCheckToast(st({ status: 'available', version: '0.5.1' }), ok)).toEqual({ text: 'Có bản 0.5.1 — đang tải về trong nền.', tone: 'info' })
    expect(manualCheckToast(st({ status: 'downloading', version: '0.5.1' }), ok)).toEqual({ text: 'Có bản 0.5.1 — đang tải về trong nền.', tone: 'info' })
    expect(manualCheckToast(st({ status: 'available', version: '0.5.1', autoDownload: false }), ok)).toEqual({ text: 'Có bản 0.5.1.', tone: 'info', action: 'open' })
    expect(manualCheckToast(st({ kind: 'portable', status: 'available', version: '0.5.1' }), ok)).toEqual({ text: 'Có bản 0.5.1.', tone: 'info', action: 'open' })
    expect(manualCheckToast(st({ status: 'ready', version: '0.5.1' }), ok)).toEqual({ text: 'Bản 0.5.1 đã tải xong.', tone: 'success', action: 'restart' })
    const offline = st({ status: 'error', error: { code: 'offline', message: UPDATE_ERROR_TEXT.offline } })
    expect(manualCheckToast(offline, { ok: false, code: 'offline', message: UPDATE_ERROR_TEXT.offline })).toEqual({ text: UPDATE_ERROR_TEXT.offline, tone: 'error' })
    expect(manualCheckToast(st({ kind: 'dev', status: 'unsupported' }), { ok: false, code: 'unsupported', message: 'x' })).toEqual({
      text: 'Bản này không tự cập nhật.',
      tone: 'info',
    })
    expect(manualCheckToast(st({ status: 'checking' }), { ok: false, code: 'busy', message: 'Đang kiểm tra hoặc đang tải bản cập nhật.' })).toEqual({
      text: 'Đang kiểm tra hoặc đang tải bản cập nhật.',
      tone: 'info',
    })
    expect(manualCheckToast(st({ status: 'idle' }), ok)).toBeNull()
  })

  it('noticeToast', () => {
    expect(noticeToast({ kind: 'updated', from: '0.4.2', version: '0.5.0' })).toEqual({ text: 'Đã cập nhật SanoVids lên 0.5.0.', tone: 'success', ms: 8000 })
    expect(noticeToast({ kind: 'install-failed', version: '0.5.1' })).toEqual({
      text: 'Chưa cài được bản 0.5.1. SanoVids sẽ thử lại khi bạn tắt app.',
      tone: 'warning',
      action: 'openPage',
    })
  })
})

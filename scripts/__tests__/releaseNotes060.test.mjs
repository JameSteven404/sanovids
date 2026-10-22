// The 0.6.0 notes users read, and the owner's 0.6.0 checklist, say what the app really does.
// Notes = docs/CHANGELOG-0.6.0-draft.md until the release step merges it, then the [0.6.0] section of CHANGELOG.md:
// scripts/update-notes.mjs copies that section into latest.yml, i.e. "Có gì mới" in the update dialog and the public
// download page. Guards found in review: the owner unlock of development mode is never described there (plan "ẩn chế
// độ Phát triển", question 11a: one sentence only), tester-only text stays out of it, and its claims match the code
// (Thư mục → Thùng rác on by default, retired reference videos, keep-login defaults, exports carry no videos, which
// library deletes ask first). docs/TEST-0.6.0.md (private) is checked against the same app facts.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractChangelogSection } from '../releaseLib.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const file = (rel) => path.join(root, ...rel.split('/'))
const exists = (rel) => fs.existsSync(file(rel))
const read = (rel) => fs.readFileSync(file(rel), 'utf8').replace(/\r\n?/g, '\n')

const DRAFT = 'docs/CHANGELOG-0.6.0-draft.md'
const CHECKLIST = 'docs/TEST-0.6.0.md'
/** The one sentence the public notes get about development mode (plan question 11a). */
const DEV_SENTENCE = 'Chế độ Phát triển (canvasapp giả lập) nay chỉ dành cho nhà phát triển.'
/** Marker of draft entries whose feature is still being merged; removed by the release step. */
const PENDING_MARK = '(khi bản thử có tính năng này)'

/** The user-facing 0.6.0 notes: the CHANGELOG.md section once merged, else the draft's (its heading has no date yet). */
function notes060() {
  const merged = extractChangelogSection(read('CHANGELOG.md'), '0.6.0')
  if (merged) return { from: 'CHANGELOG.md [0.6.0]', text: merged.body }
  if (!exists(DRAFT)) return null
  const lines = read(DRAFT).split('\n')
  const start = lines.findIndex((l) => l.startsWith('## [0.6.0]'))
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return { from: `${DRAFT} [0.6.0]`, text: lines.slice(start + 1, end < 0 ? undefined : end).join('\n') }
}

/** A string constant of a source file (`<name> = '…'`), read as text so no app module is loaded. */
function sourceString(rel, re) {
  const m = re.exec(read(rel))
  if (!m) throw new Error(`${rel}: ${re} not found — update this test with the code`)
  return m[1]
}

/** The numbered steps of the checklist ("12. **Title.** …" up to the next step or heading). */
function checklistSteps() {
  return read(CHECKLIST)
    .split(/\n(?=\d+\. \*\*|## )/)
    .filter((s) => /^\d+\. \*\*/.test(s))
    .map((s) => ({ n: Number(/^(\d+)\./.exec(s)[1]), text: s }))
}

const notes = notes060()

describe('0.6.0 release notes (what every Setup user reads under "Có gì mới")', () => {
  it('exist: the draft or the merged CHANGELOG.md section', () => {
    expect(notes, `no [0.6.0] section in CHANGELOG.md nor in ${DRAFT}`).not.toBeNull()
  })

  it('give development mode one sentence and never describe the owner unlock', () => {
    const { from, text } = notes
    expect(text, from).toContain(DEV_SENTENCE)
    for (const re of [/5 lần/, /SV1/, /mã 6 số/, /app xác thực/i, /Test giới hạn/i, /Tao ma mo khoa|scripts\/owner/i, /Khoá lại ngay/, /bấm (dòng )?phiên bản/i]) {
      expect(text, `${from} must not mention ${re}`).not.toMatch(re)
    }
  })

  it('hold no tester-only text (checklist links, test builds, internal design names)', () => {
    const { from, text } = notes
    const plain = text.split(PENDING_MARK).join('')
    expect(plain, from).not.toMatch(/TEST-0\.6\.0|danh sách kiểm tra|bản thử|người thử/i)
    expect(plain, from).not.toMatch(/mẫu D\b|app phải |cam kết tốc độ/)
    // Rendered as plain text in the update dialog: a relative link shows as raw markdown and breaks once merged.
    expect(plain, from).not.toMatch(/\]\((?!https?:\/\/)[^)]*\)/)
  })

  it('say the Thư mục → Thùng rác switch is on by default when the code makes it so', () => {
    const defaults = /DEFAULT_DOWNLOAD_PREFS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(read('src/lib/downloads.ts'))
    expect(defaults, 'DEFAULT_DOWNLOAD_PREFS not found in src/lib/downloads.ts').not.toBeNull()
    const on = /folderUnlinkTrash:\s*true\b/.test(defaults[1])
    const label = sourceString('src/core/folderTrash.ts', /FOLDER_UNLINK_TRASH_ROW = \{\s*label: '([^']+)'/)
    const { from, text } = notes
    expect(text, from).toContain(label)
    expect(text, from).not.toMatch(/Khi bật \*{0,2}Bỏ nối video/)
    if (on) expect(text, `${from}: say "${label}" is on by default`).toMatch(/mặc định bật/)
  })

  it('say what happens to old reference videos (blocked text, linked-only scenes now sent with images, next scene)', () => {
    const { from, text } = notes
    expect(read('src/components/canvas/ConnectMenu.tsx')).toContain("'Tạo cảnh tiếp theo từ video này'")
    expect(text, from).toContain('Tạo cảnh tiếp theo từ video này')
    expect(text, from).toMatch(/chỉ gửi ảnh|chạy với ảnh/)
    expect(text, from).toMatch(/\*\*Xem\*\*/)
  })

  it('give the keep-login defaults of the code', () => {
    const { defaultKeepLogin } = require('../../electron/keeplogin-rules.cjs')
    expect(defaultKeepLogin('installer')).toBe(true)
    expect(defaultKeepLogin('portable')).toBe(false)
    const { from, text } = notes
    expect(text, from).toMatch(/bật ở Setup/)
    expect(text, from).toMatch(/tắt ở Portable/)
  })

  it('never present a project export as a copy of the videos, nor promise a question before every blocking delete', () => {
    const { from, text } = notes
    if (/Xuất (bản sao )?dự án/.test(text)) expect(text, from).toMatch(/không (chứa|có|kèm) video/)
    // Only images an @image token names, or first / last frames, are asked about (core/placeholders assetDeleteImpact).
    expect(text, from).not.toMatch(/thiếu ảnh[^.\n]*app hỏi|app hỏi[^.\n]*thiếu ảnh/)
  })
})

describe.skipIf(!exists(CHECKLIST))('0.6.0 checklist (docs/TEST-0.6.0.md)', () => {
  it('quotes the toast a locked build shows instead of the cost dialog when the gateway is off', () => {
    const offReason = sourceString('src/providers/index.ts', /export const CANVASAPP_OFF_REASON = '([^']+)'/)
    expect(read(CHECKLIST)).toContain(offReason)
  })

  it('states that precondition in every non-DEV step that expects the cost dialog', () => {
    const steps = checklistSteps().filter(({ text }) => /(mở|kiểm tra) hộp (xác nhận|chi phí|chạy)/.test(text) && !/^\d+\. \*\*\[(DEV|Tài khoản thật)/.test(text))
    expect(steps.length).toBeGreaterThan(0)
    for (const { n, text } of steps) expect(text, `step ${n}`).toMatch(/cổng canvasapp\.io\.vn đã bật/)
  })

  it('checks the keep-login defaults of both builds before any step switches it', () => {
    const steps = checklistSteps()
    const firstToggle = steps.find(({ text }) => /Bật công tắc giữ đăng nhập|bật giữ đăng nhập/i.test(text))
    const defaults = steps.find(({ text }) => /Setup/.test(text) && /Portable/.test(text) && /công tắc (tắt|bật)/.test(text) && /không bấm/.test(text))
    expect(defaults, 'no step reads the switch default on Setup and Portable').toBeDefined()
    expect(firstToggle).toBeDefined()
    expect(defaults.n).toBeLessThan(firstToggle.n)
  })

  it('lets the Thư mục → Thùng rác step find the default instead of turning it on, and tries the off path', () => {
    const hint = sourceString('src/core/folderTrash.ts', /export const TRASH_FIRST_HINT = '([^']+)'/)
    const text = read(CHECKLIST)
    expect(text).not.toMatch(/Bật \*\*Bỏ nối video khỏi Thư mục/)
    expect(text).toContain(hint)
    expect(text).toMatch(/file đã lưu vẫn còn/)
  })

  it('never treats a project copy or export as holding videos', () => {
    const steps = checklistSteps()
    const copy = steps.find(({ text }) => /Mở bản sao dự án cũ/.test(text))
    expect(copy, 'the step that opens a copy of an old project').toBeDefined()
    expect(copy.text).toMatch(/không có video nào/)
    for (const { n, text } of steps.filter(({ text }) => /Xuất (bản sao )?dự án/.test(text))) {
      expect(text, `step ${n}`).toMatch(/không (chứa|có) video/)
    }
  })

  it('creates the scene copy that a later step works on', () => {
    const steps = checklistSteps()
    const user = steps.find(({ text }) => /Trên bản sao cảnh/.test(text))
    if (!user) return
    const maker = steps.find(({ n, text }) => n < user.n && /nhân bản \(Ctrl\+D\)/i.test(text))
    expect(maker, `step ${user.n} uses a scene copy no earlier step makes`).toBeDefined()
  })
})

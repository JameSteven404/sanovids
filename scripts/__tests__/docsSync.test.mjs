// The owner-facing docs say what the app and the release tooling really do: the update error texts quoted in
// docs/UPDATES.md are the app's own (electron/updater-rules.cjs ERROR_TEXT), and wording that was found to overstate
// the protections (tamper claims, the trust script's stores, SmartScreen, publisherName) does not come back.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const USER_DOCS = ['README.md', 'CHANGELOG.md', 'docs/SIGNING.md', 'docs/UPDATES.md', 'scripts/releases-repo/README.md']

describe('docs/UPDATES.md error table', () => {
  it('quotes every update error text of the app verbatim (update the table when a text changes)', () => {
    const { ERROR_TEXT } = require('../../electron/updater-rules.cjs')
    const doc = read('docs/UPDATES.md')
    const missing = Object.entries(ERROR_TEXT).filter(([, text]) => !doc.includes(text)).map(([code]) => code)
    expect(missing).toEqual([])
  })
})

describe('no overstated or stale claims', () => {
  it('nobody is told the install folder is fully tamper-proof', () => {
    for (const rel of USER_DOCS) {
      const text = read(rel)
      expect(text, rel).not.toMatch(/file trong thư mục cài bị sửa thì SanoVids \*\*không mở\*\*/)
      expect(text, rel).not.toMatch(/File của app bị sửa thì SanoVids không chạy/)
      expect(text, rel).not.toMatch(/nên không sửa được trên máy người dùng/)
    }
  })

  it('the trust script is documented as adding the Root store only', () => {
    for (const rel of USER_DOCS) {
      const text = read(rel)
      expect(text, rel).not.toMatch(/lần này chọn kho \*\*Trusted Publishers\*\*/)
      expect(text, rel).not.toMatch(/vào hai kho/)
    }
  })

  it('SmartScreen is not explained as a new-release effect that goes away', () => {
    for (const rel of USER_DOCS) expect(read(rel), rel).not.toMatch(/ít lượt tải|ít người tải/)
  })

  it('a missing publisherName is never described as switching update signature checks off', () => {
    for (const rel of [...USER_DOCS, 'scripts/tidy-release.mjs', 'scripts/releaseLib.mjs']) {
      const text = read(rel)
      expect(text, rel).not.toMatch(/thiếu = app không kiểm tra chữ ký|app sẽ không kiểm tra chữ ký số của bản cập nhật|signed-update lock/)
    }
  })

  it('the thumbprint is checked against a source other than the download page', () => {
    for (const rel of ['README.md', 'docs/SIGNING.md', 'scripts/releases-repo/README.md']) expect(read(rel), rel).toMatch(/nguồn khác trang/)
  })

  it('the licence files that ship are the ones the docs name', () => {
    for (const rel of ['README.md', 'scripts/releases-repo/README.md', 'CHANGELOG.md']) expect(read(rel), rel).toContain('THIRD-PARTY-NOTICES.txt')
    expect(read('docs/UPDATES.md')).toContain('(c) đủ **5 file**')
  })
})

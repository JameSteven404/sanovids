// Consistency checks of the signing / license files: the public certificate, the copy embedded in the trust script,
// the public download repo template (scripts/releases-repo) and the installer license page (build/license_vi.txt).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PINNED = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const AUTHOR = 'Nguyễn Giang Minh (Jame Steven)'
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const read = (rel) => fs.readFileSync(path.join(ROOT, rel))
const hasBom = (buf) => buf.subarray(0, 3).equals(BOM)
const text = (rel) => read(rel).subarray(3).toString('utf8')
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').toUpperCase()

const CER = 'build/signing/SanoVids-NguyenGiangMinh.cer'
const SCRIPTS = ['tin-cay-chung-chi.ps1', 'sao-luu-khoa-ky.ps1', 'khoi-phuc-khoa-ky.ps1'].map((f) => `scripts/signing/${f}`)
const LICENSES = ['LICENSE.txt', 'build/license_vi.txt', 'scripts/releases-repo/LICENSE.txt']

describe('public signing certificate', () => {
  it('is the pinned SanoVids certificate, public part only', () => {
    const der = read(CER)
    expect(der[0]).toBe(0x30) // DER, not PEM / PFX text
    expect(sha1(der)).toBe(PINNED)
    const cert = new crypto.X509Certificate(der)
    expect(cert.fingerprint.replace(/:/g, '')).toBe(PINNED)
    expect(cert.subject).toContain(`CN=${AUTHOR}`)
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.3') // code signing
    expect(der.length).toBeLessThan(4096)
  })

  it('is copied unchanged into the public download repo template', () => {
    expect(read('scripts/releases-repo/SanoVids-NguyenGiangMinh.cer').equals(read(CER))).toBe(true)
  })
})

describe('signing scripts', () => {
  it.each(SCRIPTS)('%s is UTF-8 with BOM (PowerShell 5.1) and pins the certificate', (rel) => {
    const buf = read(rel)
    expect(hasBom(buf)).toBe(true)
    const src = text(rel)
    expect(src).toContain(`$PinnedThumbprint = '${PINNED}'`)
    // A comment line right above the help block hides it from Get-Help: keep the blank line after #Requires.
    expect(src.startsWith('#Requires -Version 5.1\n\n<#') || src.startsWith('#Requires -Version 5.1\r\n\r\n<#')).toBe(true)
    expect(src).toBe(src.normalize('NFC'))
  })

  it('the trust script embeds exactly the public certificate', () => {
    const src = text('scripts/signing/tin-cay-chung-chi.ps1')
    const m = /\$CertBase64 = @'\r?\n([\s\S]*?)\r?\n'@/.exec(src)
    expect(m).not.toBeNull()
    const embedded = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
    expect(embedded.equals(read(CER))).toBe(true)
  })

  it('the download repo ships the same trust script', () => {
    expect(read('scripts/releases-repo/tin-cay-chung-chi.ps1').equals(read('scripts/signing/tin-cay-chung-chi.ps1'))).toBe(true)
  })
})

describe('license files', () => {
  it('are identical, UTF-8 with BOM (NSIS needs it for Vietnamese) and NFC', () => {
    const first = read(LICENSES[0])
    for (const rel of LICENSES) {
      const buf = read(rel)
      expect(buf.equals(first), rel).toBe(true)
      expect(hasBom(buf), rel).toBe(true)
    }
    const body = text(LICENSES[0])
    expect(body).toBe(body.normalize('NFC'))
  })

  it('carry the author, partner, pinned thumbprint and the six clauses', () => {
    const body = text('LICENSE.txt')
    expect(body.startsWith('SANOVIDS — GIẤY PHÉP SỬ DỤNG\n')).toBe(true)
    expect(body).toContain(`Bản quyền © 2026 ${AUTHOR}. Mọi quyền được bảo lưu.`)
    expect(body).toContain('Đồng hành: Sano Group.')
    expect(body).toContain(PINNED)
    for (let i = 1; i <= 6; i++) expect(body).toMatch(new RegExp(`^${i}\\. `, 'm'))
  })

  it('no non-localized license file in build/ overrides the localized installer page', () => {
    // electron-builder picks build/license.{txt,rtf,html} / eula.* before license_<lang>.txt.
    const names = fs.readdirSync(path.join(ROOT, 'build')).map((n) => n.toLowerCase())
    expect(names.filter((n) => /^(license|eula)\.(txt|rtf|html)$/.test(n))).toEqual([])
    expect(names).toContain('license_vi.txt')
  })
})

describe('no private key material next to the signing files', () => {
  it('build/ and scripts/ contain no .pfx / .p12 / .pvk / .key / .pem files', () => {
    const found = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(pfx|p12|pvk|key|pem)$/i.test(e.name)) found.push(path.relative(ROOT, p))
      }
    }
    walk(path.join(ROOT, 'build'))
    walk(path.join(ROOT, 'scripts'))
    expect(found).toEqual([])
  })
})

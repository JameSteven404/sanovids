// The owner's unlock tool (scripts/owner/mo-khoa.mjs) with THROW-AWAY keys and passwords in a temporary folder only
// (never the owner's real folder): the key file format (scrypt N = 2^17 + AES-256-GCM, never PEM / PKCS#8 password
// export), no overwrite, wrong password / edited file, weak parameters refused, codes that the app's own rules accept
// once and for one device, code lifetimes, "máy của bạn?" answers, the pin check and the self test.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  appDataDeviceFile,
  checkPins,
  createKeyFile,
  localDeviceCode,
  makeCode,
  otherDeviceChoice,
  ownerDir,
  parseArgs,
  readKeyFile,
  selfTest,
  unlockKey,
} from '../owner/mo-khoa.mjs'

const require = createRequire(import.meta.url)
const R = require('../../electron/devaccess-rules.cjs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanovids-owner-test-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const PASSWORD = 'mat-khau-vut-di-chi-de-thu' // throw-away
const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const verify = (pin, message, sig) => crypto.verify(null, message, crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pin.key }, format: 'jwk' }), sig)
const NOW = Date.UTC(2026, 9, 7, 9, 0, 0)

// one real key file (scrypt at full cost) shared by the tests below
const dir = path.join(tmp, 'owner')
const made = createKeyFile({ dir, password: PASSWORD, kid: 1 })
const keyFile = readKeyFile(made.file)
const privateKey = unlockKey(keyFile, PASSWORD)
const pins = R.parseDevUnlockPins([made.pin])
const DEVICE = R.deviceCodeOf(new Uint8Array(32).fill(5), sha256)

describe('tao-khoa: the key file', () => {
  it('is JSON with scrypt N ≥ 2^17 and AES-256-GCM; no PEM, no plain private key; prints a pin and a check code', () => {
    const text = fs.readFileSync(made.file, 'utf8')
    expect(text).not.toMatch(/BEGIN|PRIVATE KEY|ENCRYPTED/)
    const json = JSON.parse(text)
    expect(json).toMatchObject({ v: 1, kind: 'sanovids-dev-unlock-key', kid: 1, alg: 'ed25519', kdf: { name: 'scrypt', r: 8, p: 1 }, enc: { alg: 'aes-256-gcm' } })
    expect(json.kdf.N).toBeGreaterThanOrEqual(2 ** 17)
    expect(path.basename(made.file)).toBe('khoa-mo-khoa-1.json')
    expect(made.pin).toEqual({ kid: 1, alg: 'ed25519', key: json.pub })
    expect(R.pinProblems([made.pin])).toEqual([])
    expect(made.checkCode).toBe(R.pinCheckCode(json.pub, sha256))
    // the raw private key (PKCS#8 DER) never appears in the file
    const der = privateKey.export({ format: 'der', type: 'pkcs8' })
    expect(text).not.toContain(der.toString('base64'))
    expect(text).not.toContain(der.subarray(16).toString('base64'))
  })

  it('refuses to overwrite, refuses short passwords and bad kids', () => {
    expect(() => createKeyFile({ dir, password: PASSWORD, kid: 1 })).toThrow(/không ghi đè/)
    expect(() => createKeyFile({ dir: path.join(tmp, 'short'), password: 'ngan', kid: 1 })).toThrow(/ít nhất 12/)
    expect(() => createKeyFile({ dir: path.join(tmp, 'kid'), password: PASSWORD, kid: 16 })).toThrow(/kid/)
    expect(fs.existsSync(path.join(tmp, 'short'))).toBe(false)
  })

  it('wrong password, or one changed byte of ct / tag / pub → no key', () => {
    expect(() => unlockKey(keyFile, `${PASSWORD}x`)).toThrow(/Sai mật khẩu/)
    const json = JSON.parse(fs.readFileSync(made.file, 'utf8'))
    const flip = (b64) => {
      const b = Buffer.from(b64, 'base64')
      b[0] ^= 1
      return b.toString('base64')
    }
    for (const edit of [
      (j) => ({ ...j, enc: { ...j.enc, ct: flip(j.enc.ct) } }),
      (j) => ({ ...j, enc: { ...j.enc, tag: flip(j.enc.tag) } }),
      (j) => ({ ...j, pub: crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x }),
    ]) {
      const f = path.join(tmp, `edited-${crypto.randomUUID()}.json`)
      fs.writeFileSync(f, JSON.stringify(edit(json)))
      expect(() => unlockKey(readKeyFile(f), PASSWORD)).toThrow()
    }
  })

  it('refuses weaker scrypt, other KDFs and PEM files', () => {
    const json = JSON.parse(fs.readFileSync(made.file, 'utf8'))
    const write = (obj) => {
      const f = path.join(tmp, `weak-${crypto.randomUUID()}.json`)
      fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj))
      return f
    }
    expect(() => readKeyFile(write({ ...json, kdf: { ...json.kdf, N: 2 ** 14 } }))).toThrow(/scrypt/)
    expect(() => readKeyFile(write({ ...json, kdf: { ...json.kdf, name: 'pbkdf2' } }))).toThrow(/scrypt/)
    expect(() => readKeyFile(write({ ...json, kdf: { ...json.kdf, r: 1 } }))).toThrow(/scrypt/)
    const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: PASSWORD })
    expect(() => readKeyFile(write(pem))).toThrow(/PEM/)
    expect(() => readKeyFile(write({ ...json, kind: 'other' }))).toThrow(/không hợp lệ/)
  })
})

describe('tao-ma: codes', () => {
  it('a code the app accepts once, for its device only; two codes differ (nonce)', () => {
    const a = makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW })
    const b = makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW })
    expect(a.code).not.toBe(b.code)
    expect(a.code).toMatch(/^SV1(-[0-9A-HJKMNP-TV-Z]{8}){16}$/)
    expect(a).toMatchObject({ link: true, maxDays: 0, hours: 4 })
    const deviceId = R.parseDeviceCode(DEVICE)
    const input = R.classifyInput(a.code)
    const r = R.judgeSignedCode({ bytes: input.bytes, pins, deviceId, nowMs: NOW + 1000, used: [], verify })
    expect(r).toMatchObject({ ok: true, kid: 1, link: true, maxDays: 0 })
    expect(r.useByMs).toBe(a.useByMs)
    const used = R.withUsed([], r.nonce, r.useByMs, NOW)
    expect(R.judgeSignedCode({ bytes: input.bytes, pins, deviceId, nowMs: NOW + 2000, used, verify }).error).toBe('used')
    expect(R.judgeSignedCode({ bytes: R.classifyInput(b.code).bytes, pins, deviceId, nowMs: NOW + 2000, used, verify }).ok).toBe(true)
    expect(R.judgeSignedCode({ bytes: input.bytes, pins, deviceId: new Uint8Array(5), nowMs: NOW, used: [], verify }).error).toBe('other-device')
    expect(R.judgeSignedCode({ bytes: input.bytes, pins, deviceId, nowMs: a.useByMs + 1, used: [], verify }).error).toBe('expired')
  })

  it('lifetimes: linking 4 h (≤ 24 h), not linking 48 h (≤ 336 h); max days drop the link', () => {
    expect(makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW, hours: 24 }).hours).toBe(24)
    expect(() => makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW, hours: 25 })).toThrow(/1–24 giờ/)
    const plain = makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW, link: false })
    expect(plain).toMatchObject({ link: false, hours: 48 })
    expect(makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW, link: false, hours: 336 }).hours).toBe(336)
    expect(() => makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW, link: false, hours: 337 })).toThrow(/1–336 giờ/)
    const capped = makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW, maxDays: 2 })
    expect(capped).toMatchObject({ link: false, maxDays: 2, hours: 48 })
    const r = R.judgeSignedCode({ bytes: R.classifyInput(capped.code).bytes, pins, deviceId: R.parseDeviceCode(DEVICE), nowMs: NOW, used: [], verify })
    expect(r).toMatchObject({ ok: true, link: false, maxDays: 2 })
    expect(() => makeCode({ privateKey, kid: 1, deviceCode: 'ABC', nowMs: NOW })).toThrow(/Mã máy/)
    expect(() => makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: NOW, maxDays: 256 })).toThrow(/1–255/)
  })

  it('the longest code (336 h, use-by rounded up to the hour) is accepted right after it is made, whatever the minute', () => {
    const deviceId = R.parseDeviceCode(DEVICE)
    const hour = Date.UTC(2026, 9, 7, 10, 0, 0)
    for (const minute of [0, 1, 20, 59]) {
      const at = hour + minute * 60_000 + 7_000
      const made = makeCode({ privateKey, kid: 1, deviceCode: DEVICE, nowMs: at, link: false, hours: 336 })
      expect(made.useByMs - at).toBeGreaterThan(335 * R.HOUR_MS)
      const r = R.judgeSignedCode({ bytes: R.classifyInput(made.code).bytes, pins, deviceId, nowMs: at + 5 * 60_000, used: [], verify })
      expect(r, `minute ${minute}`).toMatchObject({ ok: true, link: false })
      // a clock that is really days behind is still told so
      expect(R.judgeSignedCode({ bytes: R.classifyInput(made.code).bytes, pins, deviceId, nowMs: at - 2 * R.DAY_MS, used: [], verify }).error).toBe('clock')
    }
  })

  it('another computer: c → a normal code, k → no link + max days (default 2), anything else cancels', () => {
    expect(otherDeviceChoice('c')).toEqual({ link: true, maxDays: 0 })
    expect(otherDeviceChoice('K', '')).toEqual({ link: false, maxDays: 2 })
    expect(otherDeviceChoice('k', '5')).toEqual({ link: false, maxDays: 5 })
    expect(otherDeviceChoice('k', '0')).toBeNull()
    expect(otherDeviceChoice('')).toBeNull()
    expect(otherDeviceChoice('yes')).toBeNull()
  })

  it('this computer is told from its dev-access.json (read only); none → unknown', () => {
    const secret = crypto.randomBytes(32)
    const f = path.join(tmp, 'dev-access.json')
    const rec = R.newRecord(secret.toString('base64url'))
    fs.writeFileSync(f, R.serializeRecord(rec))
    const before = fs.readFileSync(f, 'utf8')
    expect(localDeviceCode(f)).toBe(R.deviceCodeOf(secret, sha256))
    expect(fs.readFileSync(f, 'utf8')).toBe(before)
    expect(localDeviceCode(path.join(tmp, 'missing.json'))).toBeNull()
    fs.writeFileSync(f, 'garbage')
    expect(localDeviceCode(f)).toBeNull()
  })
})

describe('kiem-tra', () => {
  it('--chi-ghim: pin problems + check codes, from package.json only', () => {
    expect(checkPins({ sanovids: { signers: ['X'] } }).problems).toHaveLength(1)
    const ok = checkPins({ sanovids: { signers: ['X'], devUnlockKeys: [made.pin] } })
    expect(ok.problems).toEqual([])
    expect(ok.codes).toEqual([{ kid: 1, checkCode: made.checkCode }])
  })
  it('self test: signs with the key file and checks against the pin of the same kid', () => {
    expect(selfTest({ privateKey, kid: 1, pkg: { sanovids: { devUnlockKeys: [made.pin] } } }).ok).toBe(true)
    const other = { kid: 1, alg: 'ed25519', key: crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x }
    expect(selfTest({ privateKey, kid: 1, pkg: { sanovids: { devUnlockKeys: [other] } } })).toMatchObject({ ok: false })
    expect(selfTest({ privateKey, kid: 1, pkg: {} })).toMatchObject({ ok: false })
  })
})

describe('command line and files', () => {
  it('arguments', () => {
    expect(parseArgs(['tao-ma', '7KQ2-M9XD', '--han', '6', '--khong-lien-ket'])).toEqual({ cmd: 'tao-ma', positional: ['7KQ2-M9XD'], flags: { han: 6, 'khong-lien-ket': true } })
    expect(parseArgs(['kiem-tra', '--chi-ghim'])).toEqual({ cmd: 'kiem-tra', positional: [], flags: { 'chi-ghim': true } })
    expect(() => parseArgs(['tao-ma', '--han'])).toThrow(/Thiếu số/)
    expect(() => parseArgs(['tao-ma', '--bat-ky'])).toThrow(/không rõ/)
  })
  it('folders: the owner folder and SanoVids user data per platform (never inside the repo)', () => {
    expect(ownerDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a')).toBe(path.join('C:\\Users\\a\\AppData\\Local', 'SanoVids-owner'))
    expect(ownerDir({}, 'darwin', '/Users/a')).toBe(path.join('/Users/a', 'Library', 'Application Support', 'SanoVids-owner'))
    expect(appDataDeviceFile({ APPDATA: 'C:\\R' }, 'win32', 'C:\\Users\\a')).toBe(path.join('C:\\R', 'SanoVids', 'dev-access.json'))
  })
  it('the double-click wrappers are CRLF batch files calling the tool; the tool is never packaged', () => {
    for (const [name, cmd] of [
      ['Tao khoa mo khoa.bat', 'tao-khoa'],
      ['Tao ma mo khoa.bat', 'tao-ma'],
    ]) {
      const text = fs.readFileSync(path.join(ROOT, 'scripts', 'owner', name), 'utf8')
      expect(text).toContain(`node "%~dp0mo-khoa.mjs" ${cmd}\r\n`)
      expect(text.replace(/\r\n/g, '')).not.toContain('\n')
      expect(text).toContain('pause')
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.build.files.some((f) => f.includes('scripts'))).toBe(false)
  })
})

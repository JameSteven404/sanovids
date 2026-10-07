#!/usr/bin/env node
// SanoVids — the owner's development-mode unlock tool. Runs on the owner's own computer with Node's built-ins only (no
// npm install); never packaged (package.json build.files has no scripts/). Double-click wrappers: "Tao khoa mo khoa.bat",
// "Tao ma mo khoa.bat" next to this file.
//
//   node scripts/owner/mo-khoa.mjs tao-khoa [--kid N]
//       Creates the owner's Ed25519 unlock key ONCE: the private key is encrypted with a password (scrypt N = 2^17, r 8,
//       p 1 → AES-256-GCM; never Node's PKCS#8 password export, which uses PBKDF2 with 2048 rounds) into
//       %LOCALAPPDATA%\SanoVids-owner\khoa-mo-khoa-<kid>.json (Mac: ~/Library/Application Support/SanoVids-owner, 0600).
//       Refuses to overwrite. Prints the pin line for package.json sanovids.devUnlockKeys and its check code (both
//       public). Copy the key file to the backup USB; never send it or the password to anyone.
//   node scripts/owner/mo-khoa.mjs tao-ma [<mã máy>] [--han <giờ>] [--toi-da <ngày 1–255>] [--khong-lien-ket] [--kid N]
//       One code "SV1-…" for ONE device code, used ONCE: links an authenticator (default, valid 4 h, at most 24 h) or not
//       (--khong-lien-ket: 48 h, at most 336 h). A device code that is not this computer's (read-only look at
//       %APPDATA%\SanoVids\dev-access.json) asks "Đây là máy CỦA BẠN?": k = a code with at most N days, never linking.
//       The code is copied to the clipboard; delete the message that carried it once used.
//   node scripts/owner/mo-khoa.mjs kiem-tra [--chi-ghim] [--kid N]
//       --chi-ghim: the pins in the repo's package.json only (shape, no duplicate kid, no RFC 8032 test key) + their
//       check codes — no key file, no password. Without it: also signs a test message with the key file and checks it
//       against the pin of the same kid.
//
// The functions below are exported for scripts/__tests__/ownerTool.test.mjs, which uses throw-away keys and passwords
// in a temporary folder only. Pure code rules (payload, encoding, checks) are shared with the app:
// electron/devaccess-rules.cjs.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const rules = require('../../electron/devaccess-rules.cjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_PACKAGE = path.join(HERE, '..', '..', 'package.json')

export const KEY_KIND = 'sanovids-dev-unlock-key'
/** scrypt cost of the key file (≈ 0.2–0.5 s per password check); files with weaker parameters are refused. */
export const SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 })
const SCRYPT_MAXMEM = 256 * 1024 * 1024
export const MIN_PASSWORD = 12

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest()
const b64 = (buf) => Buffer.from(buf).toString('base64')
const unb64 = (s) => (typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) ? Buffer.from(s, 'base64') : null)

/** Where the owner's key files live. */
export function ownerDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'SanoVids-owner')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SanoVids-owner')
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'SanoVids-owner')
}

/** This computer's SanoVids dev-access.json (only READ, to tell "this computer" from another one). */
export function appDataDeviceFile(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'SanoVids', 'dev-access.json')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SanoVids', 'dev-access.json')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'SanoVids', 'dev-access.json')
}

export const keyFileName = (kid) => `khoa-mo-khoa-${kid}.json`

const aad = (kid, pub) => Buffer.from(`SanoVids/owner-key/v1|${kid}|${pub}`, 'utf8')

function deriveKey(password, salt, { N, r, p }) {
  return crypto.scryptSync(String(password).normalize('NFC'), salt, 32, { N, r, p, maxmem: SCRYPT_MAXMEM })
}

function checkPassword(password) {
  if (typeof password !== 'string' || [...password.normalize('NFC')].length < MIN_PASSWORD) {
    throw new Error(`Mật khẩu phải dài ít nhất ${MIN_PASSWORD} ký tự.`)
  }
}

/**
 * tao-khoa: a new key pair, the private key encrypted with `password` into `dir`/khoa-mo-khoa-<kid>.json (never
 * overwritten). → { file, pin: { kid, alg, key }, checkCode }
 */
export function createKeyFile({ dir, password, kid = 1 }) {
  if (!Number.isInteger(kid) || kid < 1 || kid > 15) throw new Error('kid phải là số nguyên 1–15.')
  checkPassword(password)
  const file = path.join(dir, keyFileName(kid))
  if (fs.existsSync(file)) throw new Error(`Đã có file khoá ${file} — không ghi đè. Muốn khoá mới thì dùng --kid khác.`)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' }).x
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = deriveKey(password, salt, SCRYPT)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(kid, pub))
  const ct = Buffer.concat([cipher.update(der), cipher.final()])
  const tag = cipher.getAuthTag()
  der.fill(0)
  key.fill(0)
  const body = {
    v: 1,
    kind: KEY_KIND,
    kid,
    alg: 'ed25519',
    pub,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: b64(salt) },
    enc: { alg: 'aes-256-gcm', iv: b64(iv), tag: b64(tag), ct: b64(ct) },
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const pin = { kid, alg: 'ed25519', key: pub }
  return { file, pin, checkCode: rules.pinCheckCode(pub, sha256) }
}

/** A key file, checked (weaker scrypt, PEM, anything unexpected → an Error). Nothing is decrypted here. */
export function readKeyFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  if (/BEGIN|PRIVATE KEY/.test(text)) throw new Error('Đây là file PEM, không phải file khoá mở khoá SanoVids — không dùng.')
  let k
  try {
    k = JSON.parse(text)
  } catch {
    throw new Error('File khoá hỏng (không đọc được JSON).')
  }
  const bad = (why) => new Error(`File khoá không hợp lệ: ${why}.`)
  if (!k || k.v !== 1 || k.kind !== KEY_KIND) throw bad('không phải file khoá mở khoá SanoVids')
  if (!Number.isInteger(k.kid) || k.kid < 1 || k.kid > 15) throw bad('kid')
  if (k.alg !== 'ed25519') throw bad('alg')
  const pub = rules.b64urlDecode(k.pub)
  if (!pub || pub.length !== 32 || typeof k.pub !== 'string' || k.pub.length !== 43) throw bad('khoá công khai')
  const kdf = k.kdf || {}
  if (kdf.name !== 'scrypt' || !Number.isInteger(kdf.N) || kdf.N < SCRYPT.N || !Number.isInteger(kdf.r) || kdf.r < SCRYPT.r || !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.N > 2 ** 20) {
    throw bad('chỉ nhận scrypt N ≥ 2^17, r ≥ 8')
  }
  const salt = unb64(kdf.salt)
  const enc = k.enc || {}
  const iv = unb64(enc.iv)
  const tag = unb64(enc.tag)
  const ct = unb64(enc.ct)
  if (!salt || salt.length < 16 || enc.alg !== 'aes-256-gcm' || !iv || iv.length !== 12 || !tag || tag.length !== 16 || !ct || ct.length < 16) throw bad('phần mã hoá')
  return { kid: k.kid, alg: k.alg, pub: k.pub, kdf: { N: kdf.N, r: kdf.r, p: kdf.p, salt }, enc: { iv, tag, ct } }
}

/** The private key of a read key file; a wrong password (or an edited file) → Error. */
export function unlockKey(keyFile, password) {
  const key = deriveKey(password, keyFile.kdf.salt, keyFile.kdf)
  let der
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, keyFile.enc.iv)
    decipher.setAAD(aad(keyFile.kid, keyFile.pub))
    decipher.setAuthTag(keyFile.enc.tag)
    der = Buffer.concat([decipher.update(keyFile.enc.ct), decipher.final()])
  } catch {
    throw new Error('Sai mật khẩu, hoặc file khoá đã bị sửa.')
  } finally {
    key.fill(0)
  }
  try {
    const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    if (crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x !== keyFile.pub) throw new Error('mismatch')
    return privateKey
  } catch {
    throw new Error('File khoá hỏng: khoá riêng không khớp khoá công khai.')
  } finally {
    der.fill(0)
  }
}

/**
 * One SV1 code. `link` (authenticator) is dropped whenever `maxDays` is set (a code for someone else's computer never
 * links). Hours: link 4 by default (≤ 24), otherwise 48 (≤ 336). → { code, useByMs, link, maxDays, hours }
 */
export function makeCode({ privateKey, kid, deviceCode, nowMs = Date.now(), hours, maxDays = 0, link = true, nonce = crypto.randomBytes(5) }) {
  const deviceId = rules.parseDeviceCode(deviceCode)
  if (!deviceId) throw new Error('Mã máy không hợp lệ (8 ký tự, ví dụ 7KQ2-M9XD).')
  if (!Number.isInteger(maxDays) || maxDays < 0 || maxDays > 255) throw new Error('Số ngày tối đa phải là 1–255.')
  const withLink = link && maxDays === 0
  const lim = rules.CODE_HOURS
  const h = hours === undefined ? (withLink ? lim.linkDefault : lim.plainDefault) : hours
  const max = withLink ? lim.linkMax : lim.plainMax
  if (!Number.isInteger(h) || h < 1 || h > max) throw new Error(`Hạn của mã ${withLink ? 'có liên kết app xác thực' : 'không liên kết'} phải là 1–${max} giờ.`)
  const useByHours = rules.useByHoursOf(nowMs + h * rules.HOUR_MS)
  const payload = rules.buildPayload({ kid, link: withLink, deviceId, useByHours, maxDays, nonce: Uint8Array.from(nonce) })
  const sig = crypto.sign(null, Buffer.from(rules.signedMessage(payload)), privateKey)
  return { code: rules.formatCode(payload, new Uint8Array(sig)), useByMs: rules.EPOCH_MS + useByHours * rules.HOUR_MS, link: withLink, maxDays, hours: h }
}

/** This computer's device code from a dev-access.json (read only), or null (no file / unreadable). */
export function localDeviceCode(deviceFile) {
  try {
    const rec = rules.parseRecord(fs.readFileSync(deviceFile, 'utf8'))
    const secret = rec ? rules.b64urlDecode(rec.device) : null
    return secret ? rules.deviceCodeOf(secret, sha256) : null
  } catch {
    return null
  }
}

/** "Đây là máy CỦA BẠN?" → c: a normal code · k: no link, at most `days` (default 2) · anything else: cancel (null). */
export function otherDeviceChoice(answer, daysText = '') {
  const a = String(answer || '').trim().toLowerCase()
  if (a === 'c' || a === 'có' || a === 'co') return { link: true, maxDays: 0 }
  if (a !== 'k' && a !== 'không' && a !== 'khong') return null
  const d = String(daysText || '').trim()
  const days = d === '' ? 2 : Number(d)
  if (!Number.isInteger(days) || days < 1 || days > 255) return null
  return { link: false, maxDays: days }
}

/** The pins of a package.json: problems (release gate wording) + the check code of each valid pin. */
export function checkPins(pkg) {
  const raw = pkg && pkg.sanovids && typeof pkg.sanovids === 'object' ? pkg.sanovids.devUnlockKeys : undefined
  const problems = rules.pinProblems(raw)
  const codes = rules.parseDevUnlockPins(raw).map((p) => ({ kid: p.kid, checkCode: rules.pinCheckCode(p.key, sha256) }))
  return { problems, codes }
}

/** Signs a test message with the key and checks it against the pin of the same kid in `pkg`. → { ok, reason } */
export function selfTest({ privateKey, kid, pkg }) {
  const raw = pkg && pkg.sanovids && typeof pkg.sanovids === 'object' ? pkg.sanovids.devUnlockKeys : undefined
  const pin = rules.parseDevUnlockPins(raw).find((p) => p.kid === kid)
  if (!pin) return { ok: false, reason: `package.json chưa ghim khoá kid ${kid}.` }
  const message = Buffer.from(rules.signedMessage(new Uint8Array(rules.PAYLOAD_BYTES)))
  const sig = crypto.sign(null, message, privateKey)
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pin.key }, format: 'jwk' })
  return crypto.verify(null, message, key, sig) ? { ok: true, reason: `Khớp khoá kid ${kid}.` } : { ok: false, reason: `Không khớp: package.json ghim một khoá khác cho kid ${kid}.` }
}

/** argv → { cmd, positional, flags } (flags: --han 4, --toi-da 2, --kid 1, --khong-lien-ket, --chi-ghim). */
export function parseArgs(argv) {
  const out = { cmd: argv[0] || '', positional: [], flags: {} }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--khong-lien-ket' || a === '--chi-ghim') out.flags[a.slice(2)] = true
    else if (a === '--han' || a === '--toi-da' || a === '--kid') {
      const v = argv[++i]
      if (v === undefined || !/^\d+$/.test(v)) throw new Error(`Thiếu số sau ${a}.`)
      out.flags[a.slice(2)] = Number(v)
    } else if (a.startsWith('--')) throw new Error(`Tuỳ chọn không rõ: ${a}`)
    else out.positional.push(a)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------

function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** A password typed without echo (a real console only — never read from a pipe or an environment variable). */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('Hãy chạy công cụ trong cửa sổ dòng lệnh (mật khẩu chỉ gõ tay, không nhận qua ống dẫn).'))
      return
    }
    process.stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let chars = []
    const finish = (value, error) => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return finish(chars.join(''))
        if (c === '\u0003') return finish('', new Error('Đã huỷ.'))
        if (c === '\u007f' || c === '\b') chars = chars.slice(0, -1)
        else if (c >= ' ') chars.push(c)
      }
    }
    stdin.on('data', onData)
  })
}

function copyToClipboard(text) {
  try {
    const run = process.platform === 'win32' ? spawnSync('clip', [], { input: text, windowsHide: true }) : process.platform === 'darwin' ? spawnSync('pbcopy', [], { input: text }) : null
    return !!run && run.status === 0
  } catch {
    return false
  }
}

function findKeyFile(dir, kid) {
  if (kid !== undefined) return path.join(dir, keyFileName(kid))
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => /^khoa-mo-khoa-\d+\.json$/.test(n))
  } catch {
    names = []
  }
  if (!names.length) throw new Error(`Chưa có file khoá trong ${dir}. Chạy "Tao khoa mo khoa.bat" trước (hoặc chép file khoá từ USB sao lưu vào đó).`)
  if (names.length > 1) throw new Error(`Có ${names.length} file khoá trong ${dir}: chọn một bằng --kid N.`)
  return path.join(dir, names[0])
}

const readRepoPackage = () => JSON.parse(fs.readFileSync(REPO_PACKAGE, 'utf8').replace(/^﻿/, ''))

async function cmdCreateKey(flags) {
  const kid = flags.kid ?? 1
  const dir = ownerDir()
  console.log(`Tạo khoá mở khoá chế độ Phát triển (kid ${kid}). File khoá sẽ nằm ở ${dir}.`)
  console.log(`Đặt một mật khẩu dài (ít nhất ${MIN_PASSWORD} ký tự), ghi giấy cất riêng. Công cụ cố ý chậm khi kiểm mật khẩu.`)
  const a = await askHidden('Mật khẩu: ')
  checkPassword(a)
  const b = await askHidden('Gõ lại mật khẩu: ')
  if (a !== b) throw new Error('Hai lần gõ mật khẩu không giống nhau.')
  const { file, pin, checkCode } = createKeyFile({ dir, password: a, kid })
  console.log('')
  console.log(`Đã tạo file khoá: ${file}`)
  console.log('')
  console.log('1) Dòng ghim (gửi cho người làm app, KHÔNG bí mật) — đặt vào package.json sanovids.devUnlockKeys:')
  console.log(`   ${JSON.stringify(pin)}`)
  console.log(`2) Mã kiểm tra (gửi kèm, KHÔNG bí mật): ${checkCode}`)
  console.log('3) Chép file khoá ở trên vào USB sao lưu (cùng chỗ với file sao lưu khoá ký .pfx).')
  console.log('   Không gửi file khoá hay mật khẩu cho bất kỳ ai.')
}

async function cmdMakeCode(positional, flags) {
  const keyPath = findKeyFile(ownerDir(), flags.kid)
  const keyFile = readKeyFile(keyPath)
  const deviceCode = positional[0] || (await askLine('Mã máy (ví dụ 7KQ2-M9XD): '))
  const deviceId = rules.parseDeviceCode(deviceCode)
  if (!deviceId) throw new Error('Mã máy không hợp lệ (8 ký tự, ví dụ 7KQ2-M9XD).')
  const pretty = rules.deviceCodeText(deviceId)
  let link = !flags['khong-lien-ket']
  let maxDays = flags['toi-da'] ?? 0
  if (maxDays) link = false
  const mine = localDeviceCode(appDataDeviceFile())
  if (mine !== pretty) {
    const hours = flags.han ?? (link && !maxDays ? rules.CODE_HOURS.linkDefault : rules.CODE_HOURS.plainDefault)
    console.log('')
    console.log(`!!! Mã này MỞ KHOÁ MỘT MÁY KHÁC (${pretty}${mine ? `, máy đang chạy công cụ là ${mine}` : ''}) trong ${hours} giờ.`)
    console.log('!!! Chỉ tạo nếu đó là máy của bạn hoặc máy bạn tin. Đừng tạo mã cho một mã máy ai đó nhắn tới nhờ "mở giùm".')
    const answer = await askLine('Đây là máy CỦA BẠN? (c/k): ')
    const daysText = String(answer).trim().toLowerCase().startsWith('k') && !maxDays ? await askLine('Mở tối đa bao nhiêu ngày? (1–255, Enter = 2): ') : String(maxDays || '')
    const choice = otherDeviceChoice(answer, daysText)
    if (!choice) {
      console.log('Đã huỷ — không tạo mã nào.')
      return
    }
    if (!choice.link) {
      link = false
      maxDays = choice.maxDays
    }
  }
  const password = await askHidden('Mật khẩu file khoá: ')
  const privateKey = unlockKey(keyFile, password)
  const made = makeCode({ privateKey, kid: keyFile.kid, deviceCode: pretty, hours: flags.han, maxDays, link })
  console.log('')
  console.log(made.code)
  console.log('')
  console.log(
    `Mã cho máy ${pretty}, dùng một lần, hết hạn sau ${made.hours} giờ${made.link ? ', có liên kết app xác thực' : ', không liên kết app xác thực'}${made.maxDays ? `, mở tối đa ${made.maxDays} ngày` : ''}.`,
  )
  console.log(copyToClipboard(made.code) ? 'Đã chép mã vào bộ nhớ tạm.' : 'Không chép được vào bộ nhớ tạm — hãy chọn và chép mã ở trên.')
  console.log('Dán xong thì xoá thư / tin nhắn chứa mã.')
}

async function cmdCheck(flags) {
  const pkg = readRepoPackage()
  const { problems, codes } = checkPins(pkg)
  for (const p of problems) console.log(`✗ ${p}`)
  for (const c of codes) console.log(`• kid ${c.kid}: mã kiểm tra ${c.checkCode} (so với mã chủ ứng dụng gửi)`)
  if (flags['chi-ghim']) {
    if (problems.length) process.exitCode = 1
    else console.log('✓ Ghim khoá mở khoá đúng hình dạng.')
    return
  }
  const keyFile = readKeyFile(findKeyFile(ownerDir(), flags.kid))
  const privateKey = unlockKey(keyFile, await askHidden('Mật khẩu file khoá: '))
  const r = selfTest({ privateKey, kid: keyFile.kid, pkg })
  console.log(`${r.ok ? '✓' : '✗'} ${r.reason}`)
  if (!r.ok || problems.length) process.exitCode = 1
}

async function main(argv) {
  const { cmd, positional, flags } = parseArgs(argv)
  if (cmd === 'tao-khoa') return cmdCreateKey(flags)
  if (cmd === 'tao-ma') return cmdMakeCode(positional, flags)
  if (cmd === 'kiem-tra') return cmdCheck(flags)
  console.log('Cách dùng: node scripts/owner/mo-khoa.mjs tao-khoa | tao-ma [mã máy] [--han giờ] [--toi-da ngày] [--khong-lien-ket] | kiem-tra [--chi-ghim]')
  process.exitCode = cmd ? 2 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`Lỗi: ${e && e.message ? e.message : e}`)
    process.exitCode = 1
  })
}

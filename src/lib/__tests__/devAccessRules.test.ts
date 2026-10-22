// electron/devaccess-rules.cjs — the pure decisions of the development-mode lock: encodings, input classification, the
// signed-code decision table (throw-away Ed25519 keys generated here + the public RFC 8032 TEST 1 vector), one use per
// code, RFC 6238 TOTP vectors, replay / old / skew, the wait after wrong codes, opAllowed, keep / cap, the stored
// record, access over time, and the public state never carrying a secret. No real key, no real code.
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const req = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const R = req('../../../electron/devaccess-rules.cjs') as any

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest()
const hmacSha1 = (k: Uint8Array, m: Uint8Array) => crypto.createHmac('sha1', k).update(m).digest()
const verify = (pin: { key: string }, message: Uint8Array, sig: Uint8Array) =>
  crypto.verify(null, message, crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pin.key }, format: 'jwk' }), sig)

function throwAwayKey(kid = 1) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { kid, privateKey, pin: { kid, alg: 'ed25519', key: publicKey.export({ format: 'jwk' }).x as string } }
}

const NOW = Date.UTC(2026, 9, 7, 10, 0, 0)
const DEVICE_SECRET = new Uint8Array(32).fill(7)
const DEVICE_ID: Uint8Array = R.deviceIdOf(DEVICE_SECRET, sha256)

function code(key: ReturnType<typeof throwAwayKey>, o: { device?: Uint8Array; hours?: number; link?: boolean; maxDays?: number; nonce?: Uint8Array; flags?: number; ver?: number } = {}) {
  const payload: Uint8Array = R.buildPayload({
    kid: key.kid,
    link: o.link ?? true,
    deviceId: o.device ?? DEVICE_ID,
    useByHours: R.useByHoursOf(NOW + (o.hours ?? 4) * R.HOUR_MS),
    maxDays: o.maxDays ?? 0,
    nonce: o.nonce ?? crypto.randomBytes(5),
  })
  if (o.flags !== undefined) payload[1] = o.flags
  if (o.ver !== undefined) payload[0] = (o.ver << 4) | key.kid
  const sig = crypto.sign(null, Buffer.from(R.signedMessage(payload)), key.privateKey)
  return R.formatCode(payload, new Uint8Array(sig)) as string
}

const judge = (text: string, pins: unknown[], extra: Record<string, unknown> = {}) => {
  const c = R.classifyInput(text)
  expect(c.kind).toBe('signed')
  return R.judgeSignedCode({ bytes: c.bytes, pins, deviceId: DEVICE_ID, nowMs: NOW, used: [], verify, ...extra })
}

describe('encodings', () => {
  it('Crockford base32 round-trips, reads O/I/L, refuses U', () => {
    const bytes = crypto.randomBytes(80)
    const text = R.crockfordEncode(bytes)
    expect(text).toHaveLength(128)
    expect(Buffer.from(R.crockfordDecode(text)).equals(bytes)).toBe(true)
    expect(Array.from(R.crockfordDecode('0O1IL'.toLowerCase() + '000') ?? [])).toEqual(Array.from(R.crockfordDecode('00111000')))
    expect(R.crockfordDecode('U0000000')).toBeNull()
    expect(R.crockfordDecode('')).toBeNull()
  })

  it('base32 (authenticator secret) and base64url round-trip', () => {
    const s = crypto.randomBytes(20)
    expect(R.base32Encode(s)).toHaveLength(32)
    expect(Buffer.from(R.base32Decode(R.base32Encode(s))).equals(s)).toBe(true)
    expect(R.base32Encode(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    const k = crypto.randomBytes(32)
    expect(R.b64urlEncode(k)).toBe(k.toString('base64url'))
    expect(Buffer.from(R.b64urlDecode(k.toString('base64url'))).equals(k)).toBe(true)
    expect(R.b64urlDecode('a')).toBeNull()
  })

  it('device code: 40-bit id in Crockford, XXXX-XXXX, parsed back from any spelling', () => {
    const codeText = R.deviceCodeOf(DEVICE_SECRET, sha256)
    expect(codeText).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(Array.from(R.parseDeviceCode(codeText.toLowerCase().replace('-', ' ')))).toEqual(Array.from(DEVICE_ID))
    expect(R.parseDeviceCode('ABC')).toBeNull()
    // a different secret → a different device
    expect(R.deviceCodeOf(new Uint8Array(32).fill(8), sha256)).not.toBe(codeText)
  })
})

describe('classifyInput', () => {
  it('6 / 8 digits, SV1 codes with dashes / spaces / case, garbage — never throws', () => {
    expect(R.classifyInput('123 456')).toEqual({ kind: 'totp', digits: '123456' })
    expect(R.classifyInput('1234-5678')).toEqual({ kind: 'email', digits: '12345678' })
    const key = throwAwayKey()
    const c = code(key)
    expect(c.startsWith('SV1-')).toBe(true)
    const signed = R.classifyInput(`  ${c.toLowerCase().replace(/-/g, ' ')} `)
    expect(signed.kind).toBe('signed')
    expect(signed.text).toBe(c)
    expect(R.classifyInput(c.slice(4)).kind).toBe('signed') // without the prefix
    expect(R.classifyInput(c.slice(0, -1)).kind).toBe('bad')
    expect(R.classifyInput('x'.repeat(301)).kind).toBe('bad')
    for (const junk of ['', '12345', '1234567', 'hello', null, 42, {}]) expect(R.classifyInput(junk as never).kind).toBe('bad')
  })
})

describe('signed codes (judgeSignedCode)', () => {
  const key = throwAwayKey(1)
  const pins = R.parseDevUnlockPins([key.pin])

  it('accepts a valid code once: link, max days, use-by, nonce', () => {
    const r = judge(code(key), pins)
    expect(r.ok).toBe(true)
    expect(r.link).toBe(true)
    expect(r.maxDays).toBe(0)
    expect(r.useByMs).toBeGreaterThan(NOW)
    expect(r.useByMs - NOW).toBeLessThanOrEqual(4 * R.HOUR_MS + R.HOUR_MS)
    // the same code again → used
    const used = R.withUsed([], r.nonce, r.useByMs, NOW)
    expect(judge(code(key, { nonce: Buffer.from(R.crockfordDecode(r.nonce)) }), pins, { used }).error).toBe('used')
    // another code (another nonce) for the same device is fine
    expect(judge(code(key), pins, { used }).ok).toBe(true)
  })

  it('decision order: newer-format → no-keys → unknown-key → bad-signature → flags → other-device → expired → clock → used', () => {
    expect(judge(code(key, { ver: 2 }), pins).error).toBe('newer-format')
    expect(judge(code(key), []).error).toBe('no-keys')
    const other = throwAwayKey(2)
    expect(judge(code(other), pins).error).toBe('unknown-key')
    // a pin with the right kid but another key: bad signature
    const impostor = throwAwayKey(1)
    expect(judge(code(impostor), pins).error).toBe('bad-signature')
    // tampered byte (payload) → bad signature, never "other-device"
    const c = R.classifyInput(code(key))
    const tampered = Uint8Array.from(c.bytes)
    tampered[3] ^= 1
    expect(R.judgeSignedCode({ bytes: tampered, pins, deviceId: DEVICE_ID, nowMs: NOW, used: [], verify }).error).toBe('bad-signature')
    // unknown flag bits / no dev bit: only checked after the signature
    expect(judge(code(key, { flags: 1 | 4 }), pins).error).toBe('malformed')
    expect(judge(code(key, { flags: 2 }), pins).error).toBe('malformed')
    const otherDevice = judge(code(key, { device: R.deviceIdOf(new Uint8Array(32).fill(9), sha256) }), pins)
    expect(otherDevice.error).toBe('other-device')
    expect(otherDevice.codeDevice).toMatch(/^.{4}-.{4}$/)
    expect(otherDevice.thisDevice).toBe(R.deviceCodeText(DEVICE_ID))
    // other-device comes before expired
    expect(judge(code(key, { device: R.deviceIdOf(new Uint8Array(32).fill(9), sha256), hours: -2 }), pins).error).toBe('other-device')
    expect(judge(code(key, { hours: -2 }), pins).error).toBe('expired')
    expect(judge(code(key, { hours: 15 * 24 }), pins).error).toBe('clock')
    // expired before used
    const r = judge(code(key), pins)
    expect(judge(code(key, { hours: -2, nonce: Buffer.from(R.crockfordDecode(r.nonce)) }), pins, { used: [{ n: r.nonce, exp: NOW + 1000 }] }).error).toBe('expired')
    expect(R.judgeSignedCode({ bytes: new Uint8Array(10), pins, deviceId: DEVICE_ID, nowMs: NOW, used: [], verify }).error).toBe('malformed')
  })

  it('a verify that throws counts as a bad signature', () => {
    expect(judge(code(key), pins, { verify: () => { throw new Error('boom') } }).error).toBe('bad-signature')
  })

  it('RFC 8032 TEST 1 verifies (the injected check is real Ed25519) but is never accepted as a pin', () => {
    const pub = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url')
    const sig = Buffer.from(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
      'hex',
    )
    expect(verify({ key: pub }, new Uint8Array(0), sig)).toBe(true)
    expect(R.RFC8032_TEST_KEYS).toContain(pub)
    expect(R.parseDevUnlockPins([{ kid: 1, alg: 'ed25519', key: pub }])).toEqual([])
    expect(R.pinProblems([{ kid: 1, alg: 'ed25519', key: pub }]).join(' ')).toMatch(/RFC 8032/)
  })

  it('pins: strict shape, duplicate kids dropped, problems listed for the release gate', () => {
    const a = throwAwayKey(1).pin
    const b = throwAwayKey(2).pin
    expect(R.parseDevUnlockPins([a, b]).map((p: { kid: number }) => p.kid)).toEqual([1, 2])
    expect(R.parseDevUnlockPins([a, { ...b, kid: 1 }])).toEqual([])
    expect(R.parseDevUnlockPins([{ ...a, extra: 1 }, { ...a, alg: 'rsa' }, { ...a, kid: 16 }, { ...a, key: 'abc' }])).toEqual([])
    expect(R.pinProblems(undefined)).toHaveLength(1)
    expect(R.pinProblems([])).toHaveLength(1)
    expect(R.pinProblems([a, b])).toEqual([])
    expect(R.pinProblems([a, { ...b, kid: 1 }]).join(' ')).toMatch(/trùng/)
    expect(R.pinProblems([{ ...a, test: true }]).join(' ')).toMatch(/đúng ba trường/)
    expect(R.pinCheckCode(a.key, sha256)).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
  })

  it('stored code: re-verified at start without the used list; a dropped key fails', () => {
    const c = R.classifyInput(code(key))
    expect(R.storedCodeOk({ bytes: c.bytes, pins, deviceId: DEVICE_ID, verify })).toBe(true)
    expect(R.storedCodeOk({ bytes: c.bytes, pins: [], deviceId: DEVICE_ID, verify })).toBe(false)
    expect(R.storedCodeOk({ bytes: c.bytes, pins, deviceId: new Uint8Array(5), verify })).toBe(false)
  })

  it('used list: expired entries pruned, at most 64, the earliest expiry goes first', () => {
    expect(R.pruneUsed([{ n: '0000000A', exp: NOW - 1 }, { n: '0000000B', exp: NOW + 1 }], NOW)).toEqual([{ n: '0000000B', exp: NOW + 1 }])
    let used: unknown[] = []
    for (let i = 0; i < 70; i++) used = R.withUsed(used, R.crockfordEncode(Uint8Array.of(0, 0, 0, 0, i)), NOW + 1000 + i, NOW)
    expect(used).toHaveLength(64)
    expect((used as { exp: number }[]).some((u) => u.exp === NOW + 1000)).toBe(false)
    expect((used as { exp: number }[]).some((u) => u.exp === NOW + 1069)).toBe(true)
    expect(R.pruneUsed([{ n: 'bad', exp: NOW + 5 }, null, 'x'], NOW)).toEqual([])
  })
})

describe('authenticator (RFC 6238, SHA-1)', () => {
  const secret = Buffer.from('12345678901234567890')
  const at = (t: number) => R.hotp(secret, Math.floor(t / 30), hmacSha1, 6)

  it('Appendix B vectors (cut to 6 digits)', () => {
    expect(R.hotp(secret, Math.floor(59 / 30), hmacSha1, 8)).toBe('94287082')
    expect(at(59)).toBe('287082')
    expect(at(1111111109)).toBe('081804')
    expect(at(1111111111)).toBe('050471')
    expect(at(1234567890)).toBe('005924')
    expect(at(2000000000)).toBe('279037')
    expect(at(20000000000)).toBe('353130')
  })

  it('±1 step, strictly newer than lastStep; replay / old never count as wrong', () => {
    const now = 1234567890 * 1000
    const c = Math.floor(now / 30000)
    const ok = R.judgeTotp({ secret, digits: R.hotp(secret, c, hmacSha1), nowMs: now, lastStep: -1, hmacSha1 })
    expect(ok).toEqual({ ok: true, step: c })
    expect(R.judgeTotp({ secret, digits: R.hotp(secret, c - 1, hmacSha1), nowMs: now, lastStep: -1, hmacSha1 })).toEqual({ ok: true, step: c - 1 })
    const replay = R.judgeTotp({ secret, digits: R.hotp(secret, c, hmacSha1), nowMs: now, lastStep: c, hmacSha1 })
    expect(replay).toMatchObject({ ok: false, error: 'totp-replay', counts: false })
    const skew = R.judgeTotp({ secret, digits: R.hotp(secret, c + 6, hmacSha1), nowMs: now, lastStep: -1, hmacSha1 })
    expect(skew).toMatchObject({ ok: false, error: 'totp-skew', minutes: 3, counts: true })
    expect(R.judgeTotp({ secret, digits: '000000' === R.hotp(secret, c, hmacSha1) ? '111111' : '000000', nowMs: now, lastStep: -1, hmacSha1 }).error).toMatch(/totp-(wrong|skew)/)
    expect(R.judgeTotp({ secret, digits: 'abc', nowMs: now, lastStep: -1, hmacSha1 })).toMatchObject({ error: 'totp-wrong', counts: true })
  })

  it('clock set back after a 6-digit unlock: the computer alone never jams; a phone that ran fast says how long to wait', () => {
    const t0 = 1_790_000_000_000
    const c0 = Math.floor(t0 / 30000)
    // unlocked with the phone's code at step c0
    let last = R.judgeTotp({ secret, digits: R.hotp(secret, c0, hmacSha1), nowMs: t0, lastStep: -1, hmacSha1 }).step
    // (a) the computer's clock went back 4 minutes, the phone is right: its next code (step c0 + 1) is still newer
    const back = t0 - 4 * 60_000
    const r = R.judgeTotp({ secret, digits: R.hotp(secret, c0 + 1, hmacSha1), nowMs: back + 8 * 30000 + 1, lastStep: last, hmacSha1 })
    expect(r.ok).toBe(true)
    // (b) the phone ran 3 minutes fast (lastStep 6 steps ahead), now corrected: the right code is "old", 3 minutes
    last = c0 + 6
    const old = R.judgeTotp({ secret, digits: R.hotp(secret, c0, hmacSha1), nowMs: t0, lastStep: last, hmacSha1 })
    expect(old).toMatchObject({ ok: false, error: 'totp-old', minutes: 3, counts: false })
    // 3 minutes later the phone's code passes lastStep
    const later = t0 + 3 * 60_000 + 30_000
    expect(R.judgeTotp({ secret, digits: R.hotp(secret, Math.floor(later / 30000), hmacSha1), nowMs: later, lastStep: last, hmacSha1 }).ok).toBe(true)
  })

  it('otpauth URI (accented label), groups, label', () => {
    const uri = R.otpauthUri({ secretB32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', deviceCode: '7KQ2-M9XD' })
    expect(uri).toBe('otpauth://totp/SanoVids:M%C3%A1y%207KQ2?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=SanoVids&algorithm=SHA1&digits=6&period=30')
    expect(R.secretGroups('ABCDEFGHIJ')).toEqual(['ABCD', 'EFGH', 'IJ'])
    expect(R.totpLabel('7KQ2-M9XD')).toBe('SanoVids · Máy 7KQ2')
  })
})

describe('wrong codes: wait', () => {
  it('the 5th wrong code waits 5 min, then twice as long each time, at most 60 min; a right one resets', () => {
    let f = { n: 0, waitUntil: 0 }
    for (let i = 0; i < 4; i++) f = R.afterFail(f, NOW)
    expect(f).toEqual({ n: 4, waitUntil: 0 })
    f = R.afterFail(f, NOW)
    expect(f.waitUntil - NOW).toBe(5 * 60_000)
    expect(R.failState(f, NOW + 1000)).toEqual({ waiting: true, waitUntil: f.waitUntil })
    expect(R.afterFail(f, NOW).waitUntil - NOW).toBe(10 * 60_000)
    let g = f
    for (let i = 0; i < 6; i++) g = R.afterFail(g, NOW)
    expect(g.waitUntil - NOW).toBe(60 * 60_000)
    expect(R.afterSuccess()).toEqual({ n: 0, waitUntil: 0 })
    expect(R.failState({ n: -1 }, NOW)).toEqual({ waiting: false, waitUntil: 0 })
  })
})

describe('opAllowed (main checks every request; the page is never trusted)', () => {
  const link = (open: boolean, started = false, pending = false) => ({ open, started, pending })
  it('every cell of the table', () => {
    for (const access of ['locked', 'unlocked', 'build']) {
      for (const op of ['getState', 'lock', 'linkCancel']) expect(R.opAllowed(op, { access })).toBe(true)
    }
    expect(R.opAllowed('unlock', { access: 'locked' })).toBe(true)
    expect(R.opAllowed('unlock', { access: 'unlocked' })).toBe('not-needed')
    expect(R.opAllowed('unlock', { access: 'build' })).toBe('not-needed')
    expect(R.opAllowed('setKeep', { access: 'locked' })).toBe('locked')
    expect(R.opAllowed('setKeep', { access: 'unlocked' })).toBe(true)
    expect(R.opAllowed('setKeep', { access: 'build' })).toBe('build')
    expect(R.opAllowed('totpRemove', { access: 'locked' })).toBe('locked')
    expect(R.opAllowed('totpRemove', { access: 'unlocked' })).toBe(true)
    expect(R.opAllowed('totpRemove', { access: 'build' })).toBe('build')
    expect(R.opAllowed('totpBegin', { access: 'build', link: link(true) })).toBe('build')
    expect(R.opAllowed('totpBegin', { access: 'unlocked', link: link(false) })).toBe('link-window')
    expect(R.opAllowed('totpBegin', { access: 'unlocked', link: link(true) })).toBe(true)
    expect(R.opAllowed('totpBegin', { access: 'unlocked', link: link(true, true) })).toBe('link-used')
    expect(R.opAllowed('totpBegin', { access: 'locked', link: link(false) })).toBe('link-window')
    expect(R.opAllowed('totpConfirm', { access: 'unlocked', link: link(true, true, true) })).toBe(true)
    expect(R.opAllowed('totpConfirm', { access: 'unlocked', link: link(true, true, false) })).toBe('link-window')
    expect(R.opAllowed('totpConfirm', { access: 'build', link: link(true, true, true) })).toBe('build')
    expect(R.opAllowed('emailStart', { access: 'locked' })).toBe('unknown-op')
  })
})

describe('keep / cap / unlock times', () => {
  it('keepUntil never passes capUntil; until-locked refused under a cap', () => {
    expect(R.keepUntil({ nowMs: NOW, days: 7, capUntil: null })).toEqual({ ok: true, until: NOW + 7 * R.DAY_MS })
    expect(R.keepUntil({ nowMs: NOW, days: 0, capUntil: null })).toEqual({ ok: true, until: null })
    expect(R.keepUntil({ nowMs: NOW, days: 30, capUntil: NOW + 2 * R.DAY_MS })).toEqual({ ok: true, until: NOW + 2 * R.DAY_MS })
    expect(R.keepUntil({ nowMs: NOW, days: 0, capUntil: NOW + 2 * R.DAY_MS })).toEqual({ ok: false, error: 'cap' })
    expect(R.keepUntil({ nowMs: NOW, days: 3, capUntil: null })).toEqual({ ok: false, error: 'bad-days' })
  })
  it('a code with max days bounds the device keep (0 = none)', () => {
    expect(R.unlockTimes({ nowMs: NOW, keepDays: 7, maxDays: 0 })).toEqual({ until: NOW + 7 * R.DAY_MS, capUntil: null })
    expect(R.unlockTimes({ nowMs: NOW, keepDays: 7, maxDays: 2 })).toEqual({ until: NOW + 2 * R.DAY_MS, capUntil: NOW + 2 * R.DAY_MS })
    expect(R.unlockTimes({ nowMs: NOW, keepDays: 0, maxDays: 0 })).toEqual({ until: null, capUntil: null })
    expect(R.unlockTimes({ nowMs: NOW, keepDays: 0, maxDays: 3 })).toEqual({ until: NOW + 3 * R.DAY_MS, capUntil: NOW + 3 * R.DAY_MS })
  })
})

describe('record + access', () => {
  const key = throwAwayKey(3)
  const pins = R.parseDevUnlockPins([key.pin])
  const device = Buffer.from(DEVICE_SECRET).toString('base64url')

  it('parseRecord is strict (garbage, unknown wrap, bad used list → null) and round-trips', () => {
    const rec = R.newRecord(device)
    expect(R.parseRecord(R.serializeRecord(rec))).toEqual(rec)
    expect(R.parseRecord('{nope')).toBeNull()
    expect(R.parseRecord({ ...rec, v: 2 })).toBeNull()
    expect(R.parseRecord({ ...rec, keepDays: 3 })).toBeNull()
    expect(R.parseRecord({ ...rec, totp: { wrap: 'rot13', secret: 'X', lastStep: 1, linkedAt: 1 } })).toBeNull()
    expect(R.parseRecord({ ...rec, used: [{ n: 'x', exp: 1 }] })).toBeNull()
    expect(R.parseRecord({ ...rec, unlock: { method: 'magic', at: 1, until: null, capUntil: null } })).toBeNull()
    expect(R.parseRecord({ ...rec, device: 'short' })).toBeNull()
    const linked = { ...rec, totp: { wrap: 'none', secret: R.base32Encode(crypto.randomBytes(20)), lastStep: 5, linkedAt: NOW } }
    expect(R.parseRecord(linked)).toEqual(linked)
    const dpapi = { ...rec, totp: { wrap: 'dpapi', secretEnc: crypto.randomBytes(40).toString('base64'), lastStep: 5, linkedAt: NOW } }
    expect(R.parseRecord(dpapi)).toEqual(dpapi)
  })

  it('accessOf: build wins; expiry; clock back > 5 min; a dropped key locks a code unlock', () => {
    const c = R.classifyInput(code(key))
    const unlocked = { ...R.newRecord(device), unlock: { method: 'code', at: NOW, until: NOW + R.DAY_MS, capUntil: null, code: c.text } }
    const base = { record: unlocked, pins, verify, deviceId: DEVICE_ID }
    expect(R.accessOf({ ...base, buildOpen: true, nowMs: NOW }).access).toBe('build')
    expect(R.accessOf({ ...base, nowMs: NOW + 1000 })).toMatchObject({ access: 'unlocked', method: 'code', until: NOW + R.DAY_MS })
    expect(R.accessOf({ ...base, nowMs: NOW + R.DAY_MS })).toMatchObject({ access: 'locked', reason: 'expired' })
    expect(R.accessOf({ ...base, nowMs: NOW - 6 * 60_000 })).toMatchObject({ access: 'locked', reason: 'clock-back' })
    expect(R.accessOf({ ...base, nowMs: NOW - 4 * 60_000 }).access).toBe('unlocked')
    expect(R.accessOf({ ...base, pins: [], nowMs: NOW + 1000 })).toMatchObject({ access: 'locked', reason: 'key-removed' })
    expect(R.accessOf({ ...base, record: { ...unlocked, unlock: { ...unlocked.unlock, capUntil: NOW + 5 } }, nowMs: NOW + 10 })).toMatchObject({ reason: 'expired' })
    expect(R.accessOf({ ...base, record: R.newRecord(device), nowMs: NOW })).toMatchObject({ access: 'locked', reason: null })
    const totp = { ...R.newRecord(device), unlock: { method: 'totp', at: NOW, until: null, capUntil: null } }
    expect(R.accessOf({ ...base, record: totp, nowMs: NOW + 400 * R.DAY_MS })).toMatchObject({ access: 'unlocked', until: null })
  })

  it('devOpenBuild follows the DevTools rule unless a test build bakes the lock', () => {
    expect(R.devOpenBuild({ devToolsAllowed: true, testDevLock: false })).toBe(true)
    expect(R.devOpenBuild({ devToolsAllowed: true, testDevLock: true })).toBe(false)
    expect(R.devOpenBuild({ devToolsAllowed: false, testDevLock: false })).toBe(false)
    expect(R.devOpenBuild({})).toBe(false)
  })

  it('stateView never carries a secret, a stored code or a nonce', () => {
    const secret = R.base32Encode(crypto.randomBytes(20))
    const c = R.classifyInput(code(key))
    const rec = {
      ...R.newRecord(device),
      unlock: { method: 'code', at: NOW, until: NOW + 1000, capUntil: null, code: c.text },
      used: [{ n: 'ABCDEFGH', exp: NOW + 5 }],
      totp: { wrap: 'none', secret, lastStep: 3, linkedAt: NOW },
    }
    const acc = R.accessOf({ record: rec, nowMs: NOW, pins, verify, deviceId: DEVICE_ID })
    const view = R.stateView({ acc, record: rec, link: { until: NOW + 100, started: true, pending: crypto.randomBytes(20) }, persist: true, totpLost: false, nowMs: NOW, deviceCode: '7KQ2-M9XD' })
    const text = JSON.stringify(view)
    expect(text).not.toContain(secret)
    expect(text).not.toContain(c.text.slice(4, 20))
    expect(text).not.toContain('ABCDEFGH')
    expect(text).not.toContain(device)
    expect(Object.keys(view).sort()).toEqual(['access', 'capUntil', 'deviceCode', 'email', 'keepDays', 'linkStarted', 'linkUntil', 'method', 'persist', 'totp', 'until', 'waitUntil'])
    expect(view).toMatchObject({ access: 'unlocked', linkUntil: NOW + 100, linkStarted: true, totp: { linked: true, lost: false, label: 'SanoVids · Máy 7KQ2' } })
    expect(R.stateView({ acc, record: rec, link: null, persist: false, totpLost: true, nowMs: NOW, deviceCode: '' }).totp).toEqual({ linked: false, label: 'SanoVids · Máy ', lost: true })
  })
})

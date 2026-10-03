// Code-signature pinning: electron/updater-rules.cjs (the PowerShell script, its output parser and the decision table)
// and electron/signature.cjs (spawning it — here with an injected fake spawn, never a real PowerShell).
import { EventEmitter } from 'node:events'
import nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import signatureSource from '../../../electron/signature.cjs?raw'

type Status = 'signed' | 'unsigned' | 'other-signer' | 'tampered' | 'unknown'
type Reason = 'ok' | 'not-signed' | 'hash-mismatch' | 'other-signer' | 'bad-chain' | 'verify-failed' | 'no-pins'
interface Verdict {
  ok: boolean
  status: Status
  reason: Reason
  thumbprint?: string
  signer?: string
  timestamped: boolean
}
interface Parsed {
  v: number | null
  status: number | null
  sigType: string | null
  thumbprint: string | null
  signer: string | null
  tsThumbprint: string | null
  chainOk: boolean
  chainStatus: string[]
  chainLen: number | null
  hresult: string | null
  error: string | null
}
interface SigRules {
  SIGNATURE_SCRIPT: string
  powershellArgs(): string[]
  powershellEnv(base: Record<string, string | undefined>, file: string): Record<string, string>
  parseSignerPins(raw: unknown): string[]
  parseSignatureOutput(stdout: unknown): Parsed | null
  judgeSignature(parsed: unknown, pins: unknown): Verdict
}
type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => unknown
interface SignatureMod {
  SIGNATURE_TIMEOUT_MS: number
  readSignerPins(pkgJsonPath?: string): string[]
  checkFileSignature(
    file: unknown,
    opts: { pins: unknown; timeoutMs?: number; log?: (line: string) => void; powershellPath?: string; spawnImpl?: SpawnFn },
  ): Promise<Verdict>
}

const req = createRequire(import.meta.url)
const rules = req('../../../electron/updater-rules.cjs') as SigRules
const signature = req('../../../electron/signature.cjs') as SignatureMod

const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const TEST_PIN = '0662783CF35AB824E68897E1AD699B19CE5E7883'
const IMPOSTOR = '5B768D22' + '0123456789ABCDEF0123456789ABCDEF'
const DIGICERT_TS = '51D9ABDA034973D84F4266ACA48248E6B369C439'

/** The genuine self-signed release (proven: Status UnknownError, 0x800B0109, chain = the one untrusted root). */
const GENUINE: Parsed = {
  v: 1,
  status: 1,
  sigType: 'Authenticode',
  thumbprint: PIN,
  signer: 'Nguyễn Giang Minh (Jame Steven)',
  tsThumbprint: DIGICERT_TS,
  chainOk: true,
  chainStatus: ['UntrustedRoot'],
  chainLen: 1,
  hresult: '0x800B0109',
  error: null,
}
const judge = (patch: Partial<Parsed>, pins: unknown = [PIN]) => rules.judgeSignature({ ...GENUINE, ...patch }, pins)

describe('judgeSignature: the decision table, in order', () => {
  it('row 1: no pins → unknown / no-pins, whatever the file', () => {
    for (const pins of [[], null, undefined, 'x', ['nope'], [42]]) {
      expect(rules.judgeSignature(GENUINE, pins), String(pins)).toMatchObject({ ok: false, status: 'unknown', reason: 'no-pins' })
    }
    expect(rules.judgeSignature(null, [])).toMatchObject({ reason: 'no-pins' })
  })

  it('row 2: no usable output → unknown / verify-failed', () => {
    const failed = { ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false }
    expect(rules.judgeSignature(null, [PIN])).toEqual(failed)
    expect(rules.judgeSignature('x', [PIN])).toEqual(failed)
    expect(judge({ v: 2 })).toEqual(failed)
    expect(judge({ v: null })).toEqual(failed)
    expect(judge({ status: null })).toEqual(failed)
    expect(judge({ status: 1.5 })).toEqual(failed)
    // FileNotFound (the script's catch)
    expect(judge({ status: -1, error: 'System.IO.FileNotFoundException', sigType: null, thumbprint: null, tsThumbprint: null })).toEqual(failed)
  })

  it('row 3: NotSigned → unsigned / not-signed', () => {
    expect(judge({ status: 2, hresult: '0x800B0100', sigType: 'None', thumbprint: null, signer: null, tsThumbprint: null, chainOk: false, chainStatus: [], chainLen: 0 })).toEqual({
      ok: false,
      status: 'unsigned',
      reason: 'not-signed',
      timestamped: false,
    })
  })

  it('row 4: HashMismatch → tampered, even with the pinned signer (status before thumbprint)', () => {
    expect(judge({ status: 3, hresult: '0x80096010' })).toEqual({
      ok: false,
      status: 'tampered',
      reason: 'hash-mismatch',
      thumbprint: PIN,
      signer: 'Nguyễn Giang Minh (Jame Steven)',
      timestamped: true,
    })
  })

  it('row 5: not Authenticode, or no usable thumbprint → unknown / verify-failed', () => {
    expect(judge({ sigType: 'Catalog' })).toMatchObject({ ok: false, status: 'unknown', reason: 'verify-failed' })
    expect(judge({ sigType: null })).toMatchObject({ reason: 'verify-failed' })
    expect(judge({ thumbprint: null })).toMatchObject({ reason: 'verify-failed' })
    expect(judge({ thumbprint: 'ABC' })).toMatchObject({ reason: 'verify-failed' })
    expect(judge({ thumbprint: `${PIN}00` })).toMatchObject({ reason: 'verify-failed' })
  })

  it('row 6: an impostor with the author\'s exact name → other-signer (the CN is never trusted)', () => {
    expect(judge({ thumbprint: IMPOSTOR })).toEqual({
      ok: false,
      status: 'other-signer',
      reason: 'other-signer',
      thumbprint: IMPOSTOR,
      signer: 'Nguyễn Giang Minh (Jame Steven)',
      timestamped: true,
    })
    // A Microsoft-signed DLL (real output of the script on d3dcompiler_47.dll).
    expect(judge({ status: 0, hresult: '0x00000000', thumbprint: '6ACE61BAE3F09F4DD2697806D73E022CBFE70EB4', signer: 'Microsoft Corporation', chainOk: false, chainStatus: ['NotTimeValid'], chainLen: 3 })).toMatchObject({
      status: 'other-signer',
    })
  })

  it('row 7b: the genuine self-signed release → signed, timestamped', () => {
    expect(judge({})).toEqual({ ok: true, status: 'signed', reason: 'ok', thumbprint: PIN, signer: 'Nguyễn Giang Minh (Jame Steven)', timestamped: true })
  })

  it('row 7a: a machine that trusts the certificate (tin-cay-chung-chi.ps1) → signed', () => {
    expect(judge({ status: 0, hresult: '0x00000000', chainStatus: [] })).toMatchObject({ ok: true, status: 'signed', reason: 'ok' })
    expect(judge({ status: 0, hresult: null, chainStatus: [], chainLen: 2 })).toMatchObject({ ok: true, status: 'signed' })
    expect(judge({ status: 0, hresult: '0x00000000', chainStatus: ['UntrustedRoot'] })).toMatchObject({ ok: true })
    // Not timestamped is still signed (only the release gate requires a timestamp).
    expect(judge({ tsThumbprint: null })).toMatchObject({ ok: true, status: 'signed', timestamped: false })
  })

  it('row 8: anything else → unknown / bad-chain', () => {
    const bad = (patch: Partial<Parsed>) => expect(judge(patch), JSON.stringify(patch)).toMatchObject({ ok: false, status: 'unknown', reason: 'bad-chain', thumbprint: PIN })
    bad({ hresult: null }) // status 1 with no hresult
    bad({ hresult: '0x800B0101' }) // CERT_E_EXPIRED
    // NotTimeValid only passes next to a timestamp (updaterRules.test.ts: "clock skew / expiry").
    bad({ chainStatus: ['UntrustedRoot', 'NotTimeValid'], tsThumbprint: null })
    bad({ chainStatus: ['NotTimeValid'] })
    bad({ chainStatus: [] })
    bad({ chainLen: 2 })
    bad({ chainLen: null })
    bad({ chainOk: false })
    bad({ status: 4 })
    bad({ status: 5 })
    bad({ status: 6 })
    bad({ status: 0, hresult: '0x800B0109', chainStatus: [] })
    bad({ status: 0, hresult: '0x00000000', chainStatus: [], chainOk: false })
    bad({ status: 0, hresult: '0x00000000', chainStatus: ['Revoked'] })
  })

  it('pins are normalized (lower case, spaces) and a test pin next to the real one works', () => {
    expect(judge({}, [PIN.toLowerCase()])).toMatchObject({ ok: true })
    expect(judge({}, ['7489 ABFA C1A7 CD23 D5FF B078 5CA7 CAB4 14AE 49ED'])).toMatchObject({ ok: true })
    expect(judge({ thumbprint: TEST_PIN }, [PIN, TEST_PIN])).toMatchObject({ ok: true, thumbprint: TEST_PIN })
    expect(judge({ thumbprint: PIN.toLowerCase() })).toMatchObject({ ok: true, thumbprint: PIN })
  })

  it('the signer name is display-only, cleaned and capped', () => {
    expect(judge({ signer: 'A\u0000B\u001bC\u0085D' }).signer).toBe('ABCD')
    expect(judge({ signer: 'x'.repeat(500) }).signer).toHaveLength(200)
    expect(judge({ signer: null })).not.toHaveProperty('signer')
    expect(judge({ signer: 'Nguyễn Giang Minh (Jame Steven)', thumbprint: IMPOSTOR }).ok).toBe(false)
  })
})

describe('parseSignerPins', () => {
  it('keeps 40-hex thumbprints only, upper-cased, deduped, at most 8', () => {
    expect(rules.parseSignerPins([PIN])).toEqual([PIN])
    expect(rules.parseSignerPins([` ${PIN.toLowerCase()} `, PIN, TEST_PIN])).toEqual([PIN, TEST_PIN])
    expect(rules.parseSignerPins(['nope', 42, null, `${PIN}0`, PIN.slice(1), `G${PIN.slice(1)}`, PIN])).toEqual([PIN])
    const many = Array.from({ length: 12 }, (_, i) => i.toString(16).toUpperCase().repeat(40))
    expect(rules.parseSignerPins(many)).toEqual(many.slice(0, 8))
    for (const bad of [null, undefined, PIN, {}, { 0: PIN }, 42]) expect(rules.parseSignerPins(bad)).toEqual([])
  })
})

describe('parseSignatureOutput', () => {
  const wrap = (o: unknown) => `SVSIG${JSON.stringify(o)}SVSIG`

  it('reads the JSON between the first and the last marker', () => {
    const raw = { ...GENUINE, signer: 'X' }
    expect(rules.parseSignatureOutput(`junk\r\n${wrap(raw)}\r\n`)).toEqual(raw)
    // Real output for the author's name: every non-ASCII char \u-escaped by the script.
    const escaped = 'SVSIG{"v":1,"status":1,"sigType":"Authenticode","thumbprint":"7489abfac1a7cd23d5ffb0785ca7cab414ae49ed","signer":"Nguy\\u1ec5n Giang Minh (Jame Steven)","tsThumbprint":null,"chainOk":true,"chainStatus":["UntrustedRoot"],"chainLen":1,"hresult":"0x800B0109","error":null}SVSIG'
    const p = rules.parseSignatureOutput(escaped)
    expect(p?.signer).toBe('Nguyễn Giang Minh (Jame Steven)')
    expect(p?.thumbprint).toBe(PIN) // upper-cased
    expect(rules.judgeSignature(p, [PIN])).toMatchObject({ ok: true, timestamped: false })
  })

  it('normalizes the shapes PowerShell may produce', () => {
    expect(rules.parseSignatureOutput(wrap({ ...GENUINE, chainStatus: 'UntrustedRoot' }))?.chainStatus).toEqual(['UntrustedRoot'])
    expect(rules.parseSignatureOutput(wrap({ ...GENUINE, chainStatus: { value: ['UntrustedRoot'], Count: 1 } }))?.chainStatus).toEqual(['UntrustedRoot'])
    expect(rules.parseSignatureOutput(wrap({ ...GENUINE, chainStatus: null }))?.chainStatus).toEqual([])
    expect(rules.parseSignatureOutput(wrap({ ...GENUINE, chainStatus: [5] }))?.chainStatus).toEqual(['5'])
    const odd = rules.parseSignatureOutput(wrap({ v: '1', status: '1', sigType: 7, chainOk: 'true', chainLen: '1', error: { x: 1 } }))
    expect(odd).toMatchObject({ v: null, status: null, sigType: null, chainOk: false, chainLen: null, error: '[object Object]' })
    expect(rules.judgeSignature(odd, [PIN]).reason).toBe('verify-failed')
  })

  it('garbage, no markers, one marker, bad JSON → null', () => {
    for (const bad of [null, undefined, 42, '', 'garbage', JSON.stringify(GENUINE), 'SVSIG{"v":1}', 'SVSIGSVSIG', 'SVSIG{"v":1SVSIG', 'SVSIG[1,2]SVSIG', 'SVSIGnullSVSIG', 'SVSIG"x"SVSIG']) {
      expect(rules.parseSignatureOutput(bad), String(bad)).toBeNull()
    }
  })
})

describe('the PowerShell command', () => {
  it('one literal line: no double quote, newline or backtick; the path only via env', () => {
    const s = rules.SIGNATURE_SCRIPT
    expect(s.includes('"')).toBe(false)
    expect(s.includes('\n')).toBe(false)
    expect(s.includes('\r')).toBe(false)
    expect(s.includes('`')).toBe(false)
    expect(s.length).toBeLessThan(8000)
    expect(s).toContain('$env:SANOVIDS_SIG_PATH')
    expect(s).toContain('Get-AuthenticodeSignature -LiteralPath $p')
    expect(s).toContain("'1.3.6.1.5.5.7.3.3'") // code signing EKU
    expect(s).toContain('X509RevocationMode]::NoCheck')
    expect(s).toContain('AllowUnknownCertificateAuthority')
    expect(s).toContain("GetField('win32Error'")
    expect(s).toContain("AppendFormat('\\u{0:x4}'")
    expect(s).toMatch(/^\$ErrorActionPreference='Stop'; /)
    expect(s.endsWith("[Console]::Out.Write('SVSIG'+$sb.ToString()+'SVSIG')")).toBe(true)
    // try/catch is one statement
    expect(s).toContain('} } catch { $r.error=$_.Exception.GetType().FullName }; ')
    expect(s).not.toMatch(/\}\s*;\s*catch/)
    // Never read the localized texts.
    expect(s).not.toMatch(/StatusMessage|\.Subject\b/)
  })

  it('powershellArgs: literal -Command, no -EncodedCommand, no Bypass', () => {
    const args = rules.powershellArgs()
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', rules.SIGNATURE_SCRIPT])
    expect(args.slice(-2)).toEqual(['-Command', rules.SIGNATURE_SCRIPT])
    expect(args.join(' ')).not.toMatch(/EncodedCommand|Bypass|ExecutionPolicy/i)
    expect(rules.powershellArgs()).not.toBe(args) // a fresh array each time
  })

  it('powershellEnv drops PSModulePath (any case) and sets SANOVIDS_SIG_PATH', () => {
    const base = { Path: 'C:\\Windows', PSModulePath: 'x', psmodulepath: 'y', PSMODULEPATH: 'z', sanovids_sig_path: 'evil', HOME: 'h', EMPTY: undefined }
    const env = rules.powershellEnv(base, 'D:\\a b\\Nguyễn\'s $x.exe')
    expect(env).toEqual({ Path: 'C:\\Windows', HOME: 'h', SANOVIDS_SIG_PATH: 'D:\\a b\\Nguyễn\'s $x.exe' })
    expect(base.PSModulePath).toBe('x') // the base is not changed
    expect(rules.powershellEnv(null as never, 'f')).toEqual({ SANOVIDS_SIG_PATH: 'f' })
  })
})

// ---- electron/signature.cjs ----

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = 0
  kill() {
    this.killed++
    return true
  }
}

interface SpawnCall {
  cmd: string
  args: string[]
  opts: Record<string, unknown>
}

function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: SpawnCall[] = []
  const children: FakeChild[] = []
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const child = new FakeChild()
    children.push(child)
    setImmediate(() => script(child))
    return child
  }
  return { spawnImpl, calls, children }
}

const OUT_GENUINE = `SVSIG${JSON.stringify(GENUINE)}SVSIG`
const close = (child: FakeChild, code: number) => {
  child.stdout.end()
  child.stderr.end()
  setImmediate(() => child.emit('close', code))
}

describe.runIf(process.platform === 'win32')('checkFileSignature (fake spawn)', () => {
  const FILE = 'D:\\x\\SanoVids-Setup-0.5.0.exe'

  it('spawns Windows PowerShell with the literal command, no shell, the path only in the env', async () => {
    const lines: string[] = []
    const { spawnImpl, calls } = fakeSpawn((child) => {
      child.stdout.write(OUT_GENUINE.slice(0, 40))
      child.stdout.write(OUT_GENUINE.slice(40))
      close(child, 0)
    })
    const v = await signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl, log: (l) => lines.push(l) })
    expect(v).toEqual({ ok: true, status: 'signed', reason: 'ok', thumbprint: PIN, signer: 'Nguyễn Giang Minh (Jame Steven)', timestamped: true })
    expect(calls).toHaveLength(1)
    const { cmd, args, opts } = calls[0]
    expect(cmd).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
    expect(args).toEqual(rules.powershellArgs())
    expect(opts).toMatchObject({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const env = opts.env as Record<string, string>
    expect(env.SANOVIDS_SIG_PATH).toBe(nodePath.resolve(FILE))
    expect(Object.keys(env).some((k) => k.toLowerCase() === 'psmodulepath')).toBe(false)
    expect(args.join(' ')).not.toContain('SanoVids-Setup')
    expect(lines).toContain('signature ok status=1 hresult=0x800B0109 thumb=7489ABFA file=SanoVids-Setup-0.5.0.exe')
  })

  it('a custom PowerShell path is used as given', async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => close(child, 0))
    await signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl, powershellPath: 'C:\\ps\\powershell.exe' })
    expect(calls[0].cmd).toBe('C:\\ps\\powershell.exe')
  })

  it('PowerShell missing (ENOENT error event) → unknown, never a rejection', async () => {
    const lines: string[] = []
    const { spawnImpl } = fakeSpawn((child) => {
      child.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }))
      close(child, -4058)
    })
    const v = await signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl, log: (l) => lines.push(l) })
    expect(v).toEqual({ ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false })
    expect(lines.some((l) => l.includes('ENOENT'))).toBe(true)
    expect(lines).toContain('signature verify-failed status=- hresult=- thumb=- file=SanoVids-Setup-0.5.0.exe')
  })

  it('a spawn that throws → unknown', async () => {
    const spawnImpl: SpawnFn = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    await expect(signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl })).resolves.toMatchObject({ ok: false, reason: 'verify-failed' })
    await expect(signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl: () => null })).resolves.toMatchObject({ ok: false, reason: 'verify-failed' })
  })

  it('a hung PowerShell is killed at the timeout → unknown', async () => {
    const { spawnImpl, children } = fakeSpawn(() => {
      /* never answers */
    })
    const lines: string[] = []
    const v = await signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl, timeoutMs: 30, log: (l) => lines.push(l) })
    expect(v).toMatchObject({ ok: false, status: 'unknown', reason: 'verify-failed' })
    expect(children[0].killed).toBe(1)
    expect(lines.some((l) => l.includes('timeout after 30 ms'))).toBe(true)
    // A late answer changes nothing.
    children[0].stdout.write(OUT_GENUINE)
    close(children[0], 0)
  })

  it('non-zero exit with no stdout → unknown; stderr never decides', async () => {
    const lines: string[] = []
    const noOut = fakeSpawn((child) => {
      child.stderr.write('Get-AuthenticodeSignature : blocked by policy')
      close(child, 1)
    })
    expect(await signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl: noOut.spawnImpl, log: (l) => lines.push(l) })).toMatchObject({
      ok: false,
      reason: 'verify-failed',
    })
    expect(lines.some((l) => l.startsWith('signature stderr: Get-AuthenticodeSignature : blocked'))).toBe(true)
    const withErr = fakeSpawn((child) => {
      child.stderr.write('WARNING: something\r\nsecond line')
      child.stdout.write(OUT_GENUINE)
      close(child, 0)
    })
    const lines2: string[] = []
    expect(await signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl: withErr.spawnImpl, log: (l) => lines2.push(l) })).toMatchObject({ ok: true })
    expect(lines2.every((l) => !/[\r\n]/.test(l))).toBe(true)
  })

  it('valid markers decide every verdict (impostor, tampered, unsigned)', async () => {
    const run = (o: Partial<Parsed>) =>
      signature.checkFileSignature(FILE, {
        pins: [PIN],
        spawnImpl: fakeSpawn((child) => {
          child.stdout.write(`SVSIG${JSON.stringify({ ...GENUINE, ...o })}SVSIG`)
          close(child, 0)
        }).spawnImpl,
      })
    expect(await run({ thumbprint: IMPOSTOR })).toMatchObject({ status: 'other-signer' })
    expect(await run({ status: 3, hresult: '0x80096010' })).toMatchObject({ status: 'tampered' })
    expect(await run({ status: 2, sigType: 'None', thumbprint: null })).toMatchObject({ status: 'unsigned' })
  })

  it('stdout is capped at 64 KB (markers past the cap are not read)', async () => {
    const { spawnImpl } = fakeSpawn((child) => {
      child.stdout.write('x'.repeat(70 * 1024))
      child.stdout.write(OUT_GENUINE)
      close(child, 0)
    })
    expect(await signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl })).toMatchObject({ ok: false, reason: 'verify-failed' })
  })

  it('no pins or no file → no PowerShell at all', async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => close(child, 0))
    expect(await signature.checkFileSignature(FILE, { pins: [], spawnImpl })).toMatchObject({ ok: false, status: 'unknown', reason: 'no-pins' })
    expect(await signature.checkFileSignature(FILE, { pins: ['bad'], spawnImpl })).toMatchObject({ reason: 'no-pins' })
    expect(await signature.checkFileSignature('', { pins: [PIN], spawnImpl })).toMatchObject({ reason: 'verify-failed' })
    expect(await signature.checkFileSignature(null, { pins: [PIN], spawnImpl })).toMatchObject({ reason: 'verify-failed' })
    expect(calls).toHaveLength(0)
  })

  it('a throwing logger never breaks the check', async () => {
    const { spawnImpl } = fakeSpawn((child) => {
      child.stdout.write(OUT_GENUINE)
      close(child, 0)
    })
    const log = () => {
      throw new Error('disk full')
    }
    expect(await signature.checkFileSignature(FILE, { pins: [PIN], spawnImpl, log })).toMatchObject({ ok: true })
  })
})

describe.runIf(process.platform !== 'win32')('checkFileSignature off Windows', () => {
  it('resolves unknown without spawning', async () => {
    const { spawnImpl, calls } = fakeSpawn(() => undefined)
    expect(await signature.checkFileSignature('/x', { pins: [PIN], spawnImpl })).toEqual({ ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false })
    expect(calls).toHaveLength(0)
  })
})

describe('readSignerPins', () => {
  it('reads sanovids.signers of the app package.json by default', () => {
    expect(signature.readSignerPins()).toEqual([PIN])
    expect(signature.SIGNATURE_TIMEOUT_MS).toBe(60_000)
  })

  it('any problem → [] (fail closed)', () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sanovids-pins-'))
    try {
      const write = (name: string, text: string) => {
        const p = nodePath.join(dir, name)
        nodeFs.writeFileSync(p, text, 'utf8')
        return p
      }
      expect(signature.readSignerPins(write('ok.json', JSON.stringify({ sanovids: { signers: [PIN.toLowerCase(), TEST_PIN] } })))).toEqual([PIN, TEST_PIN])
      expect(signature.readSignerPins(write('bom.json', `\uFEFF${JSON.stringify({ sanovids: { signers: [PIN] } })}`))).toEqual([PIN])
      expect(signature.readSignerPins(write('under-build.json', JSON.stringify({ build: { sanovids: { signers: [PIN] } } })))).toEqual([])
      expect(signature.readSignerPins(write('string.json', JSON.stringify({ sanovids: { signers: PIN } })))).toEqual([])
      expect(signature.readSignerPins(write('bad.json', '{ nope'))).toEqual([])
      expect(signature.readSignerPins(write('null.json', 'null'))).toEqual([])
      expect(signature.readSignerPins(nodePath.join(dir, 'missing.json'))).toEqual([])
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('signature.cjs stays usable outside Electron', () => {
  it('requires only node built-ins and the pure rules', () => {
    expect(signatureSource).not.toContain("require('electron')")
    expect(signatureSource).not.toContain('require("electron")')
    const required = [...signatureSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort()
    expect(required).toEqual(['./updater-rules.cjs', 'node:child_process', 'node:fs', 'node:path'])
  })
})

// electron/signature.cjs, the parts the inherited environment must never steer (which powershell.exe runs, what
// environment it gets) and the one-PowerShell batch check the app's self-check uses (the exe + the DLLs next to it,
// hardening-rules.SELF_CHECK_FILES). Fake spawns, plus one real Windows PowerShell run on Electron's own DLLs.
import { EventEmitter } from 'node:events'
import nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import nodePath from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

type Status = 'signed' | 'unsigned' | 'other-signer' | 'tampered' | 'unknown'
interface Verdict {
  ok: boolean
  status: Status
  reason: string
  thumbprint?: string
  signer?: string
  timestamped: boolean
}
type Parsed = Record<string, unknown> & { status: number | null; error: string | null; signer: string | null }
interface FileResult {
  file: unknown
  parsed: Parsed | null
  verdict: Verdict
}
type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => unknown
interface RunOpts {
  pins: unknown
  timeoutMs?: number
  log?: (line: string) => void
  powershellPath?: string
  spawnImpl?: SpawnFn
  env?: Record<string, string | undefined>
}
interface FakeFs {
  realpathSync: { native: (p: string) => string }
}
interface SignatureMod {
  checkFileSignature(file: unknown, opts: RunOpts): Promise<Verdict>
  checkFilesSignature(files: unknown, opts: RunOpts): Promise<FileResult[]>
  resolvePowershell(env?: Record<string, string | undefined>, fsImpl?: FakeFs): { root: string; exe: string }
  powershellChildEnv(baseEnv: unknown, root: string): Record<string, string>
  batchSignatureScript(): string
}
interface Rules {
  SIGNATURE_SCRIPT: string
  powershellArgs(): string[]
}
interface Hardening {
  SELF_CHECK_FILES: readonly { name: string; kind: 'author' | 'microsoft' }[]
  selfCheckFileState(kind: unknown, result: unknown, pins: unknown): 'ok' | 'bad' | 'unknown'
}

const req = createRequire(import.meta.url)
const signature = req('../../../electron/signature.cjs') as SignatureMod
const rules = req('../../../electron/updater-rules.cjs') as Rules
const hardening = req('../../../electron/hardening-rules.cjs') as Hardening

const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const PS = '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** realpathSync.native over a map of lower-case path → real path (anything else: ENOENT). */
const fakeFs = (real: Record<string, string>): FakeFs => ({
  realpathSync: {
    native: (p: string) => {
      const hit = real[p.toLowerCase()]
      if (!hit) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return hit
    },
  },
})
const C_PS = 'C:\\Windows' + PS
const D_PS = 'D:\\Windows' + PS
const BOTH = fakeFs({ [C_PS.toLowerCase()]: C_PS, [D_PS.toLowerCase()]: D_PS })

describe('resolvePowershell: the environment never picks the verifier', () => {
  it('SystemRoot is used only when it reads <drive>:\\Windows and its powershell.exe really is there', () => {
    expect(signature.resolvePowershell({ SystemRoot: 'D:\\Windows' }, BOTH)).toEqual({ root: 'D:\\Windows', exe: D_PS })
    expect(signature.resolvePowershell({ SystemRoot: 'D:\\Windows\\' }, BOTH)).toEqual({ root: 'D:\\Windows', exe: D_PS })
    expect(signature.resolvePowershell({ systemroot: 'D:\\WINDOWS' }, BOTH)).toEqual({ root: 'D:\\WINDOWS', exe: 'D:\\WINDOWS' + PS })
    expect(signature.resolvePowershell({ SYSTEMROOT: 'C:\\WINDOWS' }, BOTH)).toEqual({ root: 'C:\\WINDOWS', exe: 'C:\\WINDOWS' + PS })
  })

  it('anything else falls back to C:\\Windows', () => {
    for (const bad of ['D:\\attacker', 'D:\\attacker\\Windows', '\\\\server\\share\\Windows', '\\\\?\\D:\\Windows', 'D:\\Windows\\..\\evil', 'D:Windows', 'Windows', '', 'C:\\Windows.old']) {
      expect(signature.resolvePowershell({ SystemRoot: bad }, BOTH), bad).toEqual({ root: 'C:\\Windows', exe: C_PS })
    }
    expect(signature.resolvePowershell({}, BOTH)).toEqual({ root: 'C:\\Windows', exe: C_PS })
  })

  it('a junction / subst drive / share behind a good-looking SystemRoot is refused (real path must be the same file)', () => {
    const junction = fakeFs({ [D_PS.toLowerCase()]: 'C:\\Users\\x\\evil\\Windows' + PS, [C_PS.toLowerCase()]: C_PS })
    expect(signature.resolvePowershell({ SystemRoot: 'D:\\Windows' }, junction)).toEqual({ root: 'C:\\Windows', exe: C_PS })
    const share = fakeFs({ [D_PS.toLowerCase()]: '\\\\attacker\\share\\Windows' + PS, [C_PS.toLowerCase()]: C_PS })
    expect(signature.resolvePowershell({ SystemRoot: 'D:\\Windows' }, share)).toEqual({ root: 'C:\\Windows', exe: C_PS })
    // nothing verifiable at all → the C:\Windows path anyway (spawning it fails → verdict unknown)
    expect(signature.resolvePowershell({ SystemRoot: 'D:\\Windows' }, fakeFs({}))).toEqual({ root: 'C:\\Windows', exe: C_PS })
  })

  it.runIf(process.platform === 'win32')('on this PC: the real Windows PowerShell', () => {
    const { exe } = signature.resolvePowershell()
    expect(exe).toMatch(/^[A-Za-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    expect(nodeFs.existsSync(exe)).toBe(true)
    expect(signature.resolvePowershell({ SystemRoot: 'D:\\attacker' }).exe.toLowerCase()).toBe(C_PS.toLowerCase())
  })
})

describe('powershellChildEnv: an allowlisted environment', () => {
  const base = {
    TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
    tmp: 'C:\\t',
    USERPROFILE: 'C:\\Users\\u',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    ProgramData: 'C:\\ProgramData',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    NUMBER_OF_PROCESSORS: '12',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    __PSLockdownPolicy: '4',
    // dropped
    SystemRoot: 'D:\\attacker',
    WINDIR: 'D:\\attacker',
    Path: 'C:\\evil;C:\\Windows\\System32',
    COR_ENABLE_PROFILING: '1',
    COR_PROFILER: '{00000000-0000-0000-0000-000000000000}',
    COR_PROFILER_PATH: 'C:\\evil\\p.dll',
    COMPlus_ETWEnabled: '0',
    DOTNET_gcServer: '1',
    PSModulePath: 'C:\\evil\\modules',
    PSExecutionPolicyPreference: 'Bypass',
    NODE_OPTIONS: '--inspect',
    ELECTRON_RUN_AS_NODE: '1',
    SANOVIDS_SIG_PATH: 'C:\\x.exe',
    SANOVIDS_PROFILE_DIR: 'C:\\p',
    RANDOM_THING: 'x',
    NUMBER: undefined as unknown as string,
  }

  it('keeps folders / machine facts / an admin lockdown policy, forces SystemRoot, windir and a Windows-only PATH', () => {
    const env = signature.powershellChildEnv(base, 'C:\\Windows')
    expect(env).toEqual({
      TEMP: base.TEMP,
      tmp: base.tmp,
      USERPROFILE: base.USERPROFILE,
      LOCALAPPDATA: base.LOCALAPPDATA,
      APPDATA: base.APPDATA,
      ProgramData: base.ProgramData,
      'ProgramFiles(x86)': base['ProgramFiles(x86)'],
      NUMBER_OF_PROCESSORS: '12',
      PROCESSOR_ARCHITECTURE: 'AMD64',
      __PSLockdownPolicy: '4',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      Path: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\',
    })
  })

  it('no profiler / runtime / module / execution-policy variable ever reaches the child', () => {
    const keys = Object.keys(signature.powershellChildEnv(base, 'D:\\Windows')).map((k) => k.toLowerCase())
    for (const k of keys) expect(k, k).not.toMatch(/^(cor_|complus_|dotnet_|coreclr_|psmodulepath$|psexecutionpolicypreference$|node_|electron_|sanovids_)/)
    expect(signature.powershellChildEnv(null, '').SystemRoot).toBe('C:\\Windows')
  })
})

describe('batchSignatureScript: one PowerShell for several files', () => {
  const script = signature.batchSignatureScript()

  it('runs SIGNATURE_SCRIPT unchanged once per path of SANOVIDS_SIG_PATHS, one record per line', () => {
    expect(script.startsWith('foreach($q in $env:SANOVIDS_SIG_PATHS.Split([char]124)){ $env:SANOVIDS_SIG_PATH=$q; ')).toBe(true)
    expect(script).toContain(rules.SIGNATURE_SCRIPT)
    expect(script.endsWith('; [Console]::Out.Write([char]10) }')).toBe(true)
  })

  it('nothing a command line could re-split: no double quote, newline or backtick; braces balanced', () => {
    expect(script).not.toMatch(/["\n\r`]/)
    let depth = 0
    for (const ch of script.replace(/'[^']*'/g, "''")) {
      if (ch === '{') depth++
      if (ch === '}') depth--
      expect(depth).toBeGreaterThanOrEqual(0)
    }
    expect(depth).toBe(0)
    expect(script.length).toBeLessThan(12_000)
  })
})

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
const close = (child: FakeChild, code: number) => {
  child.stdout.end()
  child.stderr.end()
  setImmediate(() => child.emit('close', code))
}
const rec = (o: Record<string, unknown>) =>
  'SVSIG' +
  JSON.stringify({
    v: 1,
    status: 1,
    sigType: 'Authenticode',
    thumbprint: PIN,
    signer: 'Nguyễn Giang Minh (Jame Steven)',
    tsThumbprint: '51D9ABDA034973D84F4266ACA48248E6B369C439',
    chainOk: true,
    chainStatus: ['UntrustedRoot'],
    chainLen: 1,
    hresult: '0x800B0109',
    error: null,
    ...o,
  }) +
  'SVSIG'
const MS_REC = rec({ status: 0, hresult: '0x00000000', thumbprint: '6ACE61BAE3F09F4DD2697806D73E022CBFE70EB4', signer: 'Microsoft Corporation', chainStatus: [], chainLen: 3 })

describe.runIf(process.platform === 'win32')('checkFilesSignature (fake spawn)', () => {
  const DIR = 'D:\\Apps\\SanoVids'
  const FILES = [`${DIR}\\SanoVids.exe`, `${DIR}\\ffmpeg.dll`, `${DIR}\\d3dcompiler_47.dll`]
  const HOSTILE = { TEMP: 'C:\\t', SystemRoot: 'D:\\attacker', COR_ENABLE_PROFILING: '1', COR_PROFILER: '{x}', PSModulePath: 'C:\\evil', Path: 'C:\\evil' }

  it('one PowerShell for every file: literal -Command, paths only in env SANOVIDS_SIG_PATHS, allowlisted env', async () => {
    const lines: string[] = []
    const { spawnImpl, calls } = fakeSpawn((child) => {
      child.stdout.write(`${rec({})}\r\n${rec({ status: 2, sigType: 'None', thumbprint: null, signer: null, hresult: '0x800B0100' })}\n`)
      child.stdout.write(`WARNING: something unrelated\n${MS_REC}\n`)
      close(child, 0)
    })
    const out = await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl, env: HOSTILE, log: (l) => lines.push(l) })
    expect(calls).toHaveLength(1)
    const { cmd, args, opts } = calls[0]
    expect(cmd.toLowerCase()).toBe(C_PS.toLowerCase()) // SystemRoot=D:\attacker is ignored
    expect(args).toEqual([...rules.powershellArgs().slice(0, -1), signature.batchSignatureScript()])
    expect(args.at(-2)).toBe('-Command')
    expect(args.join(' ')).not.toMatch(/EncodedCommand|Bypass|SanoVids\.exe|ffmpeg/i)
    expect(opts).toMatchObject({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const env = opts.env as Record<string, string>
    expect(env.SANOVIDS_SIG_PATHS).toBe(FILES.map((f) => nodePath.resolve(f)).join('|'))
    expect(env.SANOVIDS_SIG_PATH).toBeUndefined()
    expect(env.SystemRoot.toLowerCase()).toBe('c:\\windows')
    expect(env.Path.toLowerCase()).not.toContain('evil')
    expect(Object.keys(env).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(['psmodulepath']))
    expect(Object.keys(env).some((k) => /^cor_/i.test(k))).toBe(false)
    // verdicts in order, raw output kept
    expect(out.map((r) => r.file)).toEqual(FILES)
    expect(out.map((r) => r.verdict.status)).toEqual(['signed', 'unsigned', 'other-signer'])
    expect(out[2].parsed).toMatchObject({ status: 0, signer: 'Microsoft Corporation' })
    expect(hardening.selfCheckFileState('microsoft', out[2], [PIN])).toBe('ok')
    expect(hardening.selfCheckFileState('author', out[1], [PIN])).toBe('bad')
    expect(lines).toContain('signature ok status=1 hresult=0x800B0109 thumb=7489ABFA file=SanoVids.exe')
    expect(lines).toContain('signature not-signed status=2 hresult=0x800B0100 thumb=- file=ffmpeg.dll')
  })

  it('not exactly one record per file → every verdict unknown', async () => {
    const lines: string[] = []
    const { spawnImpl } = fakeSpawn((child) => {
      child.stdout.write(`${rec({})}\n${rec({})}\n`)
      close(child, 0)
    })
    const out = await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl, log: (l) => lines.push(l) })
    expect(out.map((r) => r.verdict)).toEqual(FILES.map(() => ({ ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false })))
    expect(lines.some((l) => l.includes('2 signature records for 3 files'))).toBe(true)
    const extra = fakeSpawn((child) => {
      child.stdout.write([rec({}), rec({}), rec({}), rec({})].join('\n'))
      close(child, 0)
    })
    expect((await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl: extra.spawnImpl })).every((r) => r.verdict.status === 'unknown')).toBe(true)
  })

  it('a run-level error record (e.g. ConstrainedLanguage, reported once) stands for every file — never a pass', async () => {
    const { spawnImpl } = fakeSpawn((child) => {
      child.stdout.write(`SVSIG${JSON.stringify({ v: 1, status: -1, error: 'clm' })}SVSIG\n`)
      close(child, 0)
    })
    const out = await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl })
    expect(out).toHaveLength(3)
    for (const r of out) {
      expect(r.verdict.ok).toBe(false)
      expect(r.parsed).toMatchObject({ error: 'clm' })
    }
  })

  it('a bad record only fails its own file', async () => {
    const { spawnImpl } = fakeSpawn((child) => {
      child.stdout.write(`${rec({})}\nSVSIG{broken SVSIG\n${MS_REC}\n`)
      close(child, 0)
    })
    const out = await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl })
    expect(out.map((r) => r.verdict.status)).toEqual(['signed', 'unknown', 'other-signer'])
    expect(out[1].parsed).toBeNull()
  })

  it('timeout, missing PowerShell, a throwing spawn → every verdict unknown, never a rejection', async () => {
    const hung = fakeSpawn(() => undefined)
    const lines: string[] = []
    const t = await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl: hung.spawnImpl, timeoutMs: 30, log: (l) => lines.push(l) })
    expect(t.every((r) => r.verdict.status === 'unknown' && r.parsed === null)).toBe(true)
    expect(hung.children[0].killed).toBe(1)
    expect(lines.some((l) => l.includes('timeout after 30 ms'))).toBe(true)
    const enoent = fakeSpawn((child) => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      close(child, -4058)
    })
    expect((await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl: enoent.spawnImpl })).every((r) => r.verdict.reason === 'verify-failed')).toBe(true)
    const thrower: SpawnFn = () => {
      throw new Error('EACCES')
    }
    expect((await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl: thrower })).every((r) => r.verdict.status === 'unknown')).toBe(true)
    const log = () => {
      throw new Error('disk full')
    }
    const ok = fakeSpawn((child) => {
      child.stdout.write([rec({}), rec({}), MS_REC].join('\n'))
      close(child, 0)
    })
    expect((await signature.checkFilesSignature(FILES, { pins: [PIN], spawnImpl: ok.spawnImpl, log })).map((r) => r.verdict.status)).toEqual(['signed', 'signed', 'other-signer'])
  })

  it('no spawn for an empty list, no pins, or a bad file list', async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => close(child, 0))
    expect(await signature.checkFilesSignature([], { pins: [PIN], spawnImpl })).toEqual([])
    expect(await signature.checkFilesSignature('x', { pins: [PIN], spawnImpl })).toEqual([])
    expect((await signature.checkFilesSignature(FILES, { pins: [], spawnImpl })).map((r) => r.verdict.reason)).toEqual(['no-pins', 'no-pins', 'no-pins'])
    for (const bad of [[...FILES, 'D:\\a|b.dll'], [...FILES, 'D:\\a\nb.dll'], [...FILES, ''], [...FILES, 7], Array.from({ length: 17 }, (_, i) => `D:\\f${i}.dll`)]) {
      const out = await signature.checkFilesSignature(bad, { pins: [PIN], spawnImpl })
      expect(out).toHaveLength(bad.length)
      expect(out.every((r) => r.verdict.status === 'unknown')).toBe(true)
    }
    expect(calls).toHaveLength(0)
  })
})

describe.runIf(process.platform === 'win32')('checkFileSignature: the hostile environment is ignored too (updater path)', () => {
  it('real C:\\Windows PowerShell, allowlisted env, the path in SANOVIDS_SIG_PATH', async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => {
      child.stdout.write(rec({}))
      close(child, 0)
    })
    const env = { TEMP: 'C:\\t', SystemRoot: 'D:\\attacker', COR_ENABLE_PROFILING: '1', COMPlus_x: '1', DOTNET_y: '1', PSModulePath: 'C:\\evil' }
    const v = await signature.checkFileSignature('D:\\x\\SanoVids-Setup-0.5.0.exe', { pins: [PIN], spawnImpl, env })
    expect(v).toMatchObject({ ok: true, status: 'signed' })
    expect(calls[0].cmd.toLowerCase()).toBe(C_PS.toLowerCase())
    expect(calls[0].args).toEqual(rules.powershellArgs())
    const childEnv = calls[0].opts.env as Record<string, string>
    expect(Object.keys(childEnv).sort()).toEqual(['Path', 'SANOVIDS_SIG_PATH', 'SystemRoot', 'TEMP', 'windir'])
    expect(childEnv.SANOVIDS_SIG_PATH).toBe(nodePath.resolve('D:\\x\\SanoVids-Setup-0.5.0.exe'))
  })
})

// One real Windows PowerShell run of the batch script on files that are always there: Electron's own DLLs.
const ELECTRON_DIST = nodePath.resolve('node_modules/electron/dist')
describe.runIf(process.platform === 'win32' && nodeFs.existsSync(nodePath.join(ELECTRON_DIST, 'd3dcompiler_47.dll')))('checkFilesSignature (real PowerShell)', () => {
  it('reads Microsoft’s and the unsigned DLLs, and a missing file, in one run', async () => {
    const files = ['d3dcompiler_47.dll', 'ffmpeg.dll', 'does-not-exist.dll'].map((n) => nodePath.join(ELECTRON_DIST, n))
    const lines: string[] = []
    const out = await signature.checkFilesSignature(files, { pins: [PIN], log: (l) => lines.push(l) })
    expect(out, lines.join('\n')).toHaveLength(3)
    // d3dcompiler_47.dll: Valid, Microsoft Corporation (not ours) → the self-check accepts it
    expect(out[0].parsed, lines.join('\n')).toMatchObject({ v: 1, status: 0, sigType: 'Authenticode', signer: 'Microsoft Corporation', error: null })
    expect(out[0].verdict.status).toBe('other-signer')
    expect(hardening.selfCheckFileState('microsoft', out[0], [PIN])).toBe('ok')
    // ffmpeg.dll as Electron ships it: NotSigned (the build signs it) → an author DLL in that state is 'bad'
    expect(out[1].verdict).toMatchObject({ ok: false, status: 'unsigned', reason: 'not-signed' })
    expect(hardening.selfCheckFileState('author', out[1], [PIN])).toBe('bad')
    // missing file → the script's catch → unknown
    expect(out[2].parsed).toMatchObject({ error: 'System.IO.FileNotFoundException' })
    expect(out[2].verdict).toMatchObject({ ok: false, status: 'unknown', reason: 'verify-failed' })
  }, 90_000)
})

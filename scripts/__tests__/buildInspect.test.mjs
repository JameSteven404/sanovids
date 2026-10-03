// Unit tests of scripts/buildInspect.mjs: PowerShell argument / env builders, output parsers (fixtures captured from
// real Windows PowerShell 5.1 runs), the spawn wrapper with a fake child, and a whole inspectWindowsBuild() over a fake
// win-unpacked folder with canned PowerShell answers. No PowerShell is started here.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MICROSOFT_DLLS,
  SIGNED_DLLS,
  VERSION_INFO_ENV,
  VERSION_INFO_SCRIPT,
  defaultPowershellPath,
  inspectAppUpdateYml,
  inspectWindowsBuild,
  judgeMicrosoftSigned,
  parseMarked,
  parseRawSignature,
  parseVersionInfoOutput,
  runPowerShell,
  scriptEnv,
  versionInfoArgs,
} from '../buildInspect.mjs'
import { AUTHOR, COPYRIGHT_BUILD } from '../releaseLib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PIN = '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'
const MS_THUMB = '6ACE61BAE3F09F4DD2697806D73E022CBFE70EB4'

// Real outputs (PowerShell 5.1, Windows 10): VERSION_INFO_SCRIPT on electron.exe, d3dcompiler_47.dll, the 0.4.2 Setup
// and a missing file; the spec SIGNATURE_SCRIPT on d3dcompiler_47.dll and ffmpeg.dll.
const VI_ELECTRON =
  'SVVER{"v":1,"companyName":"GitHub, Inc.","legalCopyright":"Copyright (C) 2015 GitHub, Inc. All rights reserved.","productName":"Electron","fileDescription":"Electron","fileVersion":"44.5.1","productVersion":"44.5.1","originalFilename":"electron.exe","error":null}SVVER'
const VI_D3D =
  'SVVER{"v":1,"companyName":"Microsoft Corporation","legalCopyright":"\\u00a9 Microsoft Corporation. All rights reserved.","productName":"Microsoft\\u00ae Windows\\u00ae Operating System","fileDescription":"Direct3D HLSL Compiler for Redistribution","fileVersion":"10.0.26100.7705 (WinBuild.160101.0800)","productVersion":"10.0.26100.7705","originalFilename":"d3dcompiler_47.dll","error":null}SVVER'
const VI_SETUP_042 =
  'SVVER{"v":1,"companyName":"SanoVids","legalCopyright":"\\u00a9 2026 SanoVids","productName":"SanoVids","fileDescription":"SanoVids \\u2014 d\\u1ef1ng phim AI theo t\\u1eebng c\\u1ea3nh tr\\u00ean canvas","fileVersion":"0.4.2","productVersion":"0.4.2","originalFilename":"","error":null}SVVER'
const VI_MISSING =
  'SVVER{"v":1,"companyName":null,"legalCopyright":null,"productName":null,"fileDescription":null,"fileVersion":null,"productVersion":null,"originalFilename":null,"error":"System.Management.Automation.MethodInvocationException"}SVVER'
const SIG_D3D =
  'SVSIG{"v":1,"status":0,"sigType":"Authenticode","thumbprint":"6ACE61BAE3F09F4DD2697806D73E022CBFE70EB4","signer":"Microsoft Corporation","tsThumbprint":"8FA7937A36EE604D487E36DFAEDEAD5DEBC25120","chainOk":false,"chainStatus":["NotTimeValid"],"chainLen":3,"hresult":"0x00000000","error":null}SVSIG'
const SIG_FFMPEG_UNSIGNED =
  'SVSIG{"v":1,"status":2,"sigType":"None","thumbprint":null,"signer":null,"tsThumbprint":null,"chainOk":false,"chainStatus":[],"chainLen":0,"hresult":"0x800B0100","error":null}SVSIG'

/** Escapes like the PowerShell scripts do: every char above 126 as \uXXXX. */
const asciiJson = (obj) => JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** A fake child_process: emits `stdout` (string chunks) then exit/close with `code` on the next tick unless told otherwise. */
function fakeSpawn(answer) {
  const calls = []
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
      return true
    }
    calls.push({ cmd, args, opts, child })
    const a = answer(cmd, args, opts, child) ?? {}
    if (a.throw) throw a.throw
    setImmediate(() => {
      if (a.error) return child.emit('error', a.error)
      if (a.hang) return
      for (const chunk of [].concat(a.stdout ?? [])) child.stdout.emit('data', Buffer.from(chunk))
      child.stderr.emit('data', Buffer.from(a.stderr ?? ''))
      child.emit('exit', a.code ?? 0, null)
      child.emit('close', a.code ?? 0, null)
    })
    return child
  }
  return { spawnImpl, calls }
}

describe('PowerShell builders', () => {
  it('VERSION_INFO_SCRIPT is one literal line safe for Node quoting', () => {
    expect(VERSION_INFO_SCRIPT).not.toMatch(/["\n\r`]/)
    expect(VERSION_INFO_SCRIPT.length).toBeLessThan(8000)
    expect(VERSION_INFO_SCRIPT).toContain('$env:SANOVIDS_VI_PATH')
    expect(VERSION_INFO_SCRIPT).toContain('[System.Diagnostics.FileVersionInfo]::GetVersionInfo($p)')
    expect(VERSION_INFO_SCRIPT).toContain("AppendFormat('\\u{0:x4}',[int]$x)")
    expect(VERSION_INFO_SCRIPT.startsWith("$ErrorActionPreference='Stop'; ")).toBe(true)
    expect(VERSION_INFO_SCRIPT.endsWith("[Console]::Out.Write('SVVER'+$sb.ToString()+'SVVER')")).toBe(true)
    // PowerShell rejects a statement separator between a try block and its catch
    expect(VERSION_INFO_SCRIPT).not.toMatch(/\}\s*;\s*catch/)
    expect(VERSION_INFO_SCRIPT).toMatch(/\} catch \{ \$r\.error=/)
  })
  it('versionInfoArgs: literal -Command, no encoded command, no policy bypass', () => {
    const args = versionInfoArgs()
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', VERSION_INFO_SCRIPT])
    expect(args.join(' ')).not.toMatch(/EncodedCommand|Bypass|ExecutionPolicy/i)
  })
  it('scriptEnv drops PSModulePath (any case) and any other spelling of the path variable', () => {
    const base = { Path: 'C:\\Windows', PSModulePath: 'x', psmodulepath: 'y', PsModulePath: 'z', sanovids_vi_path: 'old', SystemRoot: 'C:\\Windows' }
    const env = scriptEnv(base, VERSION_INFO_ENV, 'C:\\a b\\SanoVids.exe')
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PSMODULEPATH')).toEqual([])
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'SANOVIDS_VI_PATH')).toEqual(['SANOVIDS_VI_PATH'])
    expect(env.SANOVIDS_VI_PATH).toBe('C:\\a b\\SanoVids.exe')
    expect(env.Path).toBe('C:\\Windows')
    expect(base.PSModulePath).toBe('x')
    expect(scriptEnv(null, 'SANOVIDS_SIG_PATH', 'f')).toEqual({ SANOVIDS_SIG_PATH: 'f' })
  })
  it('defaultPowershellPath uses SystemRoot', () => {
    expect(defaultPowershellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(defaultPowershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })
})

describe('parsers', () => {
  it('parseMarked: between the first and the last marker, objects only', () => {
    expect(parseMarked('noise SVVER{"a":1}SVVER tail', 'SVVER')).toEqual({ a: 1 })
    expect(parseMarked('SVVER{"a":"SVVER"}SVVER', 'SVVER')).toEqual({ a: 'SVVER' })
    expect(parseMarked('garbage', 'SVVER')).toBeNull()
    expect(parseMarked('SVVER{"a":1}', 'SVVER')).toBeNull()
    expect(parseMarked('SVVER{bad json}SVVER', 'SVVER')).toBeNull()
    expect(parseMarked('SVVER[1,2]SVVER', 'SVVER')).toBeNull()
    expect(parseMarked(null, 'SVVER')).toBeNull()
  })
  it('parseVersionInfoOutput: real outputs, \\u escapes decode', () => {
    expect(parseVersionInfoOutput(VI_ELECTRON)).toMatchObject({ companyName: 'GitHub, Inc.', productName: 'Electron', fileVersion: '44.5.1' })
    expect(parseVersionInfoOutput(VI_D3D)).toMatchObject({ legalCopyright: '© Microsoft Corporation. All rights reserved.' })
    const setup = parseVersionInfoOutput(VI_SETUP_042)
    expect(setup).toEqual({
      companyName: 'SanoVids',
      legalCopyright: '© 2026 SanoVids',
      productName: 'SanoVids',
      fileDescription: 'SanoVids — dựng phim AI theo từng cảnh trên canvas',
      fileVersion: '0.4.2',
      productVersion: '0.4.2',
      originalFilename: '',
    })
    const author = parseVersionInfoOutput(`SVVER${asciiJson({ v: 1, companyName: AUTHOR, legalCopyright: COPYRIGHT_BUILD, error: null })}SVVER`)
    expect(author.companyName).toBe(AUTHOR)
    expect(author.legalCopyright).toBe(COPYRIGHT_BUILD)
    expect(author.productName).toBeNull()
  })
  it('parseVersionInfoOutput: errors, other versions and garbage → null', () => {
    expect(parseVersionInfoOutput(VI_MISSING)).toBeNull()
    expect(parseVersionInfoOutput(VI_ELECTRON.replace('"v":1', '"v":2'))).toBeNull()
    expect(parseVersionInfoOutput('At line:1 char:635')).toBeNull()
    expect(parseVersionInfoOutput('')).toBeNull()
  })
  it('parseRawSignature + judgeMicrosoftSigned', () => {
    const d3d = parseRawSignature(SIG_D3D)
    expect(d3d).toMatchObject({ status: 0, thumbprint: MS_THUMB, signer: 'Microsoft Corporation' })
    expect(judgeMicrosoftSigned('d3dcompiler_47.dll', d3d, [PIN])).toEqual({ level: 'ok', text: 'd3dcompiler_47.dll: chữ ký gốc của Microsoft Corporation còn nguyên' })
    // re-signed with our certificate → Microsoft's signature is gone
    const resigned = judgeMicrosoftSigned('dxil.dll', { ...d3d, thumbprint: PIN, signer: AUTHOR }, [PIN.toLowerCase()])
    expect(resigned.level).toBe('fail')
    expect(resigned.text).toMatch(/ký lại/)
    expect(judgeMicrosoftSigned('dxil.dll', parseRawSignature(SIG_FFMPEG_UNSIGNED), [PIN])).toMatchObject({ level: 'fail' })
    expect(judgeMicrosoftSigned('dxil.dll', { ...d3d, status: 1 }, [PIN])).toMatchObject({ level: 'fail' })
    expect(judgeMicrosoftSigned('dxil.dll', { ...d3d, status: 3 }, [PIN]).text).toMatch(/Status 3/)
    expect(judgeMicrosoftSigned('dxil.dll', { ...d3d, error: 'System.IO.FileNotFoundException' }, [PIN])).toMatchObject({ level: 'fail' })
    expect(judgeMicrosoftSigned('dxil.dll', null, [PIN])).toMatchObject({ level: 'fail' })
    expect(parseRawSignature(SIG_D3D.replace('"v":1', '"v":7'))).toBeNull()
    expect(parseRawSignature('SVSIGSVSIG')).toBeNull()
  })
})

describe('runPowerShell (fake child)', () => {
  const opts = { args: ['-Command', 'x'], env: { A: '1' }, powershellPath: 'C:\\ps.exe' }
  it('collects stdout and spawns without a shell, hidden, stdin ignored', async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: ['SVVER{"v"', ':1}SVVER'], stderr: 'warning on stderr', code: 0 }))
    const r = await runPowerShell({ ...opts, spawnImpl })
    expect(r).toEqual({ stdout: 'SVVER{"v":1}SVVER', code: 0, error: null })
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('C:\\ps.exe')
    expect(calls[0].args).toEqual(['-Command', 'x'])
    expect(calls[0].opts).toEqual({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { A: '1' } })
  })
  it('a spawn error (ENOENT) or a synchronous throw resolves, never rejects', async () => {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    expect(await runPowerShell({ ...opts, spawnImpl: fakeSpawn(() => ({ error: enoent })).spawnImpl })).toEqual({ stdout: '', code: null, error: 'ENOENT' })
    const thrown = await runPowerShell({ ...opts, spawnImpl: fakeSpawn(() => ({ throw: Object.assign(new Error('x'), { code: 'EACCES' }) })).spawnImpl })
    expect(thrown).toEqual({ stdout: '', code: null, error: 'EACCES' })
  })
  it('a hung child is killed (only that one) at the timeout', async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ hang: true }))
    const r = await runPowerShell({ ...opts, spawnImpl, timeoutMs: 20 })
    expect(r.error).toBe('timeout')
    expect(calls[0].child.killed).toBe(true)
  })
  it('a non-zero exit with no output is reported as such', async () => {
    const r = await runPowerShell({ ...opts, spawnImpl: fakeSpawn(() => ({ code: 1 })).spawnImpl })
    expect(r).toEqual({ stdout: '', code: 1, error: null })
    expect(parseVersionInfoOutput(r.stdout)).toBeNull()
  })
  it('keeps at most 64 KB of stdout', async () => {
    const big = 'x'.repeat(40 * 1024)
    const r = await runPowerShell({ ...opts, spawnImpl: fakeSpawn(() => ({ stdout: [big, big, big] })).spawnImpl })
    expect(r.stdout.length).toBe(64 * 1024)
  })
})

describe('inspectAppUpdateYml', () => {
  let dir
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanovids-yml-'))
  })
  afterAll(() => {
    if (dir && dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true })
  })
  const write = (name, text) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, text, 'utf8')
    return p
  }
  it('accepts the signed feed with the exact UTF-8 publisherName', () => {
    const r = inspectAppUpdateYml(write('good.yml', SIGNED_YML), AUTHOR)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ level: 'ok', group: 'Nguồn cập nhật' })
  })
  it('a decomposed (NFD) name parses equal but is not the exact bytes', () => {
    const r = inspectAppUpdateYml(write('nfd.yml', SIGNED_YML.replace(AUTHOR, AUTHOR.normalize('NFD'))), AUTHOR)
    expect(r.map((x) => x.text)).toEqual(['app-update.yml không chứa đúng chuỗi UTF-8 của publisherName.'])
  })
  it('a "Nguy?n" name is called out as an encoding problem', () => {
    const r = inspectAppUpdateYml(write('q.yml', SIGNED_YML.replace(AUTHOR, 'Nguy?n Giang Minh (Jame Steven)')), AUTHOR)
    expect(r.every((x) => x.level === 'fail')).toBe(true)
    expect(r.map((x) => x.text)).toContain('app-update.yml ghi publisherName bị lỗi mã hoá ("Nguy?n Giang Minh (Jame Steven)").')
  })
  it('missing publisherName / missing file / unreadable YAML fail once each', () => {
    expect(inspectAppUpdateYml(write('none.yml', SIGNED_YML.replace(`publisherName:\n  - ${AUTHOR}\n`, '')), AUTHOR).map((x) => x.text)).toEqual([
      'app-update.yml thiếu publisherName — app sẽ không kiểm tra chữ ký số của bản cập nhật.',
    ])
    expect(inspectAppUpdateYml(path.join(dir, 'absent.yml'), AUTHOR)).toEqual([{ level: 'fail', group: 'Nguồn cập nhật', text: 'Thiếu resources/app-update.yml.' }])
    expect(inspectAppUpdateYml(null, AUTHOR)).toHaveLength(1)
    expect(inspectAppUpdateYml(write('bad.yml', 'a: [unclosed'), AUTHOR).map((x) => x.text)).toEqual(['app-update.yml không đọc được.'])
  })
})

// ───────────────────────────── whole inspection over a fake build ─────────────────────────────

const hasSignatureModule = fs.existsSync(path.join(root, 'electron', 'signature.cjs'))
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const GOOD_WIRE = [48, 48, 48, 48, 49, 49, 48, 48, 49]
const fakeExe = (wire) => Buffer.concat([Buffer.from('MZ fake exe '), Buffer.from(SENTINEL), Buffer.from([1, wire.length, ...wire]), Buffer.from(' end')])
const SIGNED_YML = `owner: JameSteven404\nrepo: sanovids-releases\nprovider: github\nreleaseType: release\npublisherName:\n  - ${AUTHOR}\nupdaterCacheDirName: sanovids-updater\n`
const EXPECT = { pins: [PIN], author: AUTHOR, copyright: COPYRIGHT_BUILD, publisherName: AUTHOR }

/** Genuine self-signed answer (status 1 / 0x800B0109 / [UntrustedRoot] / chain 1, timestamped). */
const sigAnswer = (over = {}) =>
  `SVSIG${asciiJson({
    v: 1,
    status: 1,
    sigType: 'Authenticode',
    thumbprint: PIN,
    signer: AUTHOR,
    tsThumbprint: '51D9ABDA034973D84F4266ACA48248E6B369C439',
    chainOk: true,
    chainStatus: ['UntrustedRoot'],
    chainLen: 1,
    hresult: '0x800B0109',
    error: null,
    ...over,
  })}SVSIG`

describe.skipIf(!hasSignatureModule)('inspectWindowsBuild over a fake build (canned PowerShell answers)', () => {
  let dir
  let build
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanovids-inspect-'))
    const unpacked = path.join(dir, 'win-unpacked')
    fs.mkdirSync(path.join(unpacked, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(unpacked, 'SanoVids.exe'), fakeExe(GOOD_WIRE))
    for (const n of [...SIGNED_DLLS, ...MICROSOFT_DLLS]) fs.writeFileSync(path.join(unpacked, n), 'MZ dll')
    fs.writeFileSync(path.join(unpacked, 'resources', 'elevate.exe'), 'MZ elevate')
    fs.writeFileSync(path.join(unpacked, 'resources', 'app.asar'), 'asar')
    fs.writeFileSync(path.join(unpacked, 'resources', 'app-update.yml'), SIGNED_YML, 'utf8')
    fs.writeFileSync(path.join(dir, 'SanoVids-Setup-0.5.0.exe'), 'MZ setup')
    fs.writeFileSync(path.join(dir, 'SanoVids-Portable-0.5.0.exe'), 'MZ portable')
    build = {
      setupPath: path.join(dir, 'SanoVids-Setup-0.5.0.exe'),
      portablePath: path.join(dir, 'SanoVids-Portable-0.5.0.exe'),
      unpackedDir: unpacked,
      exeName: 'SanoVids.exe',
      expect: EXPECT,
      powershellPath: 'C:\\fake\\powershell.exe',
      timeoutMs: 5000,
    }
  })
  afterAll(() => {
    if (dir && dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Canned answers keyed by the file in the env; `override(file)` may return another stdout. */
  const answers = (override = () => null) =>
    fakeSpawn((_cmd, _args, opts) => {
      const sig = opts.env.SANOVIDS_SIG_PATH
      const vi = opts.env[VERSION_INFO_ENV]
      const file = sig ?? vi
      const o = override(path.basename(file), sig ? 'sig' : 'vi')
      if (o != null) return { stdout: o }
      if (vi) return { stdout: `SVVER${asciiJson({ v: 1, companyName: AUTHOR, legalCopyright: COPYRIGHT_BUILD, productName: 'SanoVids', error: null })}SVVER` }
      if (MICROSOFT_DLLS.includes(path.basename(sig))) return { stdout: SIG_D3D }
      return { stdout: sigAnswer() }
    })

  it('a genuine signed build passes every check', async () => {
    const { spawnImpl, calls } = answers()
    const results = await inspectWindowsBuild({ ...build, spawnImpl })
    const fails = results.filter((r) => r.level !== 'ok')
    expect(fails).toEqual([])
    // 4 main files + 4 DLLs + 2 Microsoft DLLs + 3 VersionInfo reads, all through the fake PowerShell path
    expect(calls).toHaveLength(13)
    for (const c of calls) {
      expect(c.cmd).toBe('C:\\fake\\powershell.exe')
      expect(c.opts.shell).toBe(false)
      expect(c.args).toContain('-Command')
      expect(c.args.join(' ')).not.toMatch(/EncodedCommand|Bypass/i)
    }
    expect(results.filter((r) => r.group === 'Chữ ký số' && r.level === 'ok')).toHaveLength(10)
    expect(results.some((r) => r.group === 'Fuse' && r.level === 'ok')).toBe(true)
  })

  it('names every broken piece', async () => {
    const { spawnImpl } = answers((name, kind) => {
      if (kind === 'sig' && name === 'SanoVids-Portable-0.5.0.exe') return sigAnswer({ tsThumbprint: null })
      if (kind === 'sig' && name === 'elevate.exe') return SIG_FFMPEG_UNSIGNED
      if (kind === 'sig' && name === 'SanoVids.exe') return sigAnswer({ thumbprint: '5B768D22' + '0'.repeat(32) })
      if (kind === 'sig' && name === 'dxil.dll') return sigAnswer()
      if (kind === 'vi' && name === 'SanoVids.exe') return `SVVER${asciiJson({ v: 1, companyName: 'Nguyễn Giang Minh', legalCopyright: COPYRIGHT_BUILD, error: null })}SVVER`
      return null
    })
    const results = await inspectWindowsBuild({ ...build, spawnImpl })
    const fails = results.filter((r) => r.level === 'fail').map((r) => r.text)
    expect(fails.some((t) => /SanoVids-Portable-0\.5\.0\.exe .*thiếu dấu thời gian/.test(t))).toBe(true)
    expect(fails).toContain('resources/elevate.exe chưa được ký số.')
    expect(fails.some((t) => t.startsWith('SanoVids.exe được ký bởi') && t.includes('5B768D22'))).toBe(true)
    expect(fails.some((t) => /dxil\.dll bị ký lại/.test(t))).toBe(true)
    expect(fails).toContain('SanoVids.exe: CompanyName là "Nguyễn Giang Minh", cần "Nguyễn Giang Minh (Jame Steven)".')
  })

  it('fuses, app.asar.unpacked and app-update.yml problems fail', async () => {
    const unpacked = build.unpackedDir
    const exe = path.join(unpacked, 'SanoVids.exe')
    const yml = path.join(unpacked, 'resources', 'app-update.yml')
    const extra = path.join(unpacked, 'resources', 'app.asar.unpacked')
    try {
      fs.writeFileSync(exe, fakeExe([49, 48, 49, 49, 48, 48, 48, 49, 49]))
      fs.mkdirSync(extra)
      fs.writeFileSync(yml, SIGNED_YML.replace(AUTHOR, 'Nguy?n Giang Minh (Jame Steven)'), 'utf8')
      const results = await inspectWindowsBuild({ ...build, spawnImpl: answers().spawnImpl })
      const fails = results.filter((r) => r.level === 'fail')
      expect(fails.filter((r) => r.group === 'Fuse')).toHaveLength(6)
      expect(fails.some((r) => r.group === 'app.asar' && /app\.asar\.unpacked/.test(r.text))).toBe(true)
      expect(fails.some((r) => r.group === 'Nguồn cập nhật' && /lỗi mã hoá/.test(r.text))).toBe(true)
      expect(fails.some((r) => r.group === 'Nguồn cập nhật' && /^publisherName trong app-update.yml/.test(r.text))).toBe(true)

      fs.writeFileSync(yml, SIGNED_YML.replace(`publisherName:\n  - ${AUTHOR}\n`, ''), 'utf8')
      const noName = await inspectWindowsBuild({ ...build, spawnImpl: answers().spawnImpl })
      expect(noName.filter((r) => r.group === 'Nguồn cập nhật').map((r) => r.text)).toEqual([
        'app-update.yml thiếu publisherName — app sẽ không kiểm tra chữ ký số của bản cập nhật.',
      ])
      // feed: false leaves app-update.yml to the caller (publish-release group f)
      const noFeed = await inspectWindowsBuild({ ...build, feed: false, spawnImpl: answers().spawnImpl })
      expect(noFeed.some((r) => r.group === 'Nguồn cập nhật')).toBe(false)
    } finally {
      fs.writeFileSync(exe, fakeExe(GOOD_WIRE))
      fs.rmSync(extra, { recursive: true, force: true })
      fs.writeFileSync(yml, SIGNED_YML, 'utf8')
    }
  })

  it('missing inputs and an empty pin list fail instead of passing', async () => {
    const results = await inspectWindowsBuild({ ...build, setupPath: null, portablePath: path.join(dir, 'nope.exe'), expect: { ...EXPECT, pins: [] }, spawnImpl: answers().spawnImpl })
    const fails = results.filter((r) => r.level === 'fail').map((r) => r.text)
    expect(fails.some((t) => /^Thiếu Setup/.test(t))).toBe(true)
    expect(fails.some((t) => /^Thiếu nope\.exe/.test(t))).toBe(true)
    expect(fails.some((t) => /sanovids\.signers/.test(t))).toBe(true)
  })
})

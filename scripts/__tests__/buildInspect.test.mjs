// Unit tests of scripts/buildInspect.mjs: PowerShell argument / env builders, output parsers (fixtures captured from
// real Windows PowerShell 5.1 runs), the spawn wrapper with a fake child, and a whole inspectWindowsBuild() over a fake
// win-unpacked folder with canned PowerShell answers. No PowerShell is started here.
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MICROSOFT_DLLS,
  MICROSOFT_SIGNER,
  SIGNED_DLLS,
  VERSION_INFO_ENV,
  VERSION_INFO_SCRIPT,
  asarHeaderSha256,
  defaultPowershellPath,
  inspectAppUpdateYml,
  inspectShippedFiles,
  inspectWindowsBuild,
  judgeMicrosoftSigned,
  judgeOtherCodeFile,
  listCodeFiles,
  parseMarked,
  parseRawSignature,
  parseVersionInfoOutput,
  readExeIntegrityResources,
  runPowerShell,
  scriptEnv,
  versionInfoArgs,
} from '../buildInspect.mjs'
import { AUTHOR, COPYRIGHT_BUILD, PUBLISHER_NAME_MISSING } from '../releaseLib.mjs'

const require = createRequire(import.meta.url)
/** resedit, resolved like scripts/buildInspect.mjs does (it ships with app-builder-lib). */
const { NtExecutable, NtExecutableResource } = createRequire(require.resolve('app-builder-lib/package.json'))('resedit')
const rules = require('../../electron/updater-rules.cjs')

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
    // a CLR profiler / runtime override must not run inside the check
    const clr = scriptEnv({ COR_ENABLE_PROFILING: '1', cor_profiler_path: 'x.dll', COMPlus_X: '1', DOTNET_Y: '1', CORECLR_Z: '1', CORNER: 'keep' }, 'SANOVIDS_SIG_PATH', 'f')
    expect(clr).toEqual({ CORNER: 'keep', SANOVIDS_SIG_PATH: 'f' })
  })
  it('defaultPowershellPath uses SystemRoot only when it reads <drive>:\\Windows', () => {
    expect(defaultPowershellPath({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(defaultPowershellPath({ SYSTEMROOT: 'C:\\WINDOWS\\' })).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    for (const bad of ['D:\\Win', 'C:\\evil', 'D:\\attacker\\Windows', '\\\\server\\share\\Windows', ''])
      expect(defaultPowershellPath({ SystemRoot: bad })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(defaultPowershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })
  it('the DLL lists are the app self-check lists (electron/hardening-rules.cjs)', () => {
    const hardening = require('../../electron/hardening-rules.cjs')
    expect(SIGNED_DLLS).toBe(hardening.SIGNED_DLLS)
    expect(MICROSOFT_DLLS).toBe(hardening.MICROSOFT_DLLS)
    expect(MICROSOFT_SIGNER).toBe('Microsoft Corporation')
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
    // Microsoft's DLLs: a valid signature by anyone else is not Microsoft's
    expect(judgeMicrosoftSigned('dxil.dll', d3d, [PIN], { signer: 'Microsoft Corporation' }).level).toBe('ok')
    expect(judgeMicrosoftSigned('dxil.dll', { ...d3d, signer: 'Contoso' }, [PIN], { signer: 'Microsoft Corporation' })).toEqual({
      level: 'fail',
      text: 'dxil.dll: ký bởi "Contoso", không phải Microsoft Corporation.',
    })
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
      PUBLISHER_NAME_MISSING,
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
const SIGNED_YML = `owner: JameSteven404\nrepo: sanovids-releases\nprovider: github\nreleaseType: release\npublisherName:\n  - ${AUTHOR}\nupdaterCacheDirName: sanovids-updater\n`
const EXPECT = { pins: [PIN], author: AUTHOR, copyright: COPYRIGHT_BUILD, publisherName: AUTHOR }
const OTHER_PIN = 'B'.repeat(40)

/** A minimal asar: size pickle, header pickle (payload size, JSON length, JSON, padding), then file data. */
function fakeAsar(files = { 'package.json': { size: 2, offset: '0' } }, data = Buffer.from('{}')) {
  const json = Buffer.from(JSON.stringify({ files }), 'utf8')
  const padded = Math.ceil(json.length / 4) * 4
  const headerPickleSize = 8 + padded
  const buf = Buffer.alloc(8 + headerPickleSize + data.length)
  buf.writeUInt32LE(4, 0)
  buf.writeUInt32LE(headerPickleSize, 4)
  buf.writeUInt32LE(4 + padded, 8)
  buf.writeUInt32LE(json.length, 12)
  json.copy(buf, 16)
  data.copy(buf, 8 + headerPickleSize)
  return buf
}
const headerSha = (asar) => createHash('sha256').update(asar.subarray(16, 16 + asar.readUInt32LE(12))).digest('hex')
const integrityText = (sha) => JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: sha }])

/** A real (tiny) PE built with resedit, optionally carrying an INTEGRITY/ELECTRONASAR resource, then the fuse wire. */
function fakePe(integrity, wire = GOOD_WIRE) {
  const exe = NtExecutable.createEmpty(false, false)
  if (integrity != null) {
    const res = NtExecutableResource.from(exe)
    res.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR', bin: Buffer.from(integrity), lang: 1033, codepage: 1200 })
    res.outputResource(exe)
  }
  return Buffer.concat([Buffer.from(exe.generate()), Buffer.from(SENTINEL), Buffer.from([1, wire.length, ...wire]), Buffer.from(' end')])
}

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

describe('code files, integrity resource, shipped files (helpers)', () => {
  let dir
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanovids-pe-'))
  })
  afterAll(() => {
    if (dir && dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('listCodeFiles walks every folder for *.exe / *.dll / *.node…, sorted, forward slashes', () => {
    const d = path.join(dir, 'walk')
    fs.mkdirSync(path.join(d, 'resources', 'native'), { recursive: true })
    fs.mkdirSync(path.join(d, 'locales'), { recursive: true })
    for (const f of ['SanoVids.exe', 'ffmpeg.dll', 'resources/elevate.exe', 'resources/native/addon.node', 'locales/vi.pak', 'LICENSE.txt', 'x.DLL']) {
      fs.writeFileSync(path.join(d, ...f.split('/')), 'x')
    }
    expect(listCodeFiles(d)).toEqual(['SanoVids.exe', 'ffmpeg.dll', 'resources/elevate.exe', 'resources/native/addon.node', 'x.DLL'])
    expect(listCodeFiles(path.join(dir, 'absent'))).toEqual([])
    expect(listCodeFiles(null)).toEqual([])
  })

  it('readExeIntegrityResources reads the resource of a real PE; asarHeaderSha256 hashes the raw header only', () => {
    const asar = fakeAsar()
    const asarPath = path.join(dir, 'app.asar')
    fs.writeFileSync(asarPath, asar)
    expect(asarHeaderSha256(asarPath)).toBe(headerSha(asar))
    const exePath = path.join(dir, 'with.exe')
    fs.writeFileSync(exePath, fakePe(integrityText(headerSha(asar))))
    expect(readExeIntegrityResources(exePath)).toEqual([integrityText(headerSha(asar))])
    const bare = path.join(dir, 'bare.exe')
    fs.writeFileSync(bare, fakePe(null))
    expect(readExeIntegrityResources(bare)).toEqual([])
    fs.writeFileSync(path.join(dir, 'short.asar'), Buffer.from([4, 0, 0]))
    expect(() => asarHeaderSha256(path.join(dir, 'short.asar'))).toThrow()
  })

  it('judgeOtherCodeFile: ours, a vendor signature, or a fail that names win.signExts', () => {
    const judge = rules.judgeSignature
    const parsed = (over) => rules.parseSignatureOutput(sigAnswer(over))
    expect(judgeOtherCodeFile('libfoo.dll', parsed(), [PIN], { judgeSignature: judge })).toEqual({ level: 'ok', text: `libfoo.dll: ký bởi ${AUTHOR}` })
    // signed by a pin, but not by the release certificate
    expect(judgeOtherCodeFile('libfoo.dll', parsed({ thumbprint: OTHER_PIN }), [PIN, OTHER_PIN], { signer: PIN, judgeSignature: judge }).level).toBe('fail')
    // a vendor DLL (valid third-party signature)
    const vendor = judgeOtherCodeFile('libEGL.dll', rules.parseSignatureOutput(SIG_D3D), [PIN], { judgeSignature: judge })
    expect(vendor).toEqual({ level: 'ok', text: 'libEGL.dll: chữ ký gốc của Microsoft Corporation còn nguyên' })
    // unsigned → the fix is win.signExts
    const unsigned = judgeOtherCodeFile('resources/native/addon.node', rules.parseSignatureOutput(SIG_FFMPEG_UNSIGNED), [PIN], { judgeSignature: judge })
    expect(unsigned.level).toBe('fail')
    expect(unsigned.text).toContain('Thêm "addon.node" vào package.json build.win.signExts')
    // ours but modified after signing
    expect(judgeOtherCodeFile('a.dll', parsed({ status: 3, hresult: '0x80096010' }), [PIN], { judgeSignature: judge }).text).toMatch(/bị sửa/)
    // ours with a broken chain is not reported as "add to signExts"
    expect(judgeOtherCodeFile('a.dll', parsed({ status: 4, hresult: null }), [PIN], { judgeSignature: judge }).text).toMatch(/chuỗi chứng chỉ/)
    // no output at all
    expect(judgeOtherCodeFile('a.dll', null, [PIN], { judgeSignature: judge }).text).toMatch(/không đọc được/)
  })

  it('inspectShippedFiles: present and byte-identical to the repo source', () => {
    const d = path.join(dir, 'ship')
    fs.mkdirSync(d)
    const src = path.join(dir, 'LICENSE.src.txt')
    fs.writeFileSync(src, '\uFEFFlicence\n')
    fs.writeFileSync(path.join(d, 'LICENSE.txt'), '\uFEFFlicence\n')
    expect(inspectShippedFiles(d, [{ name: 'LICENSE.txt', source: src }])).toEqual([
      { level: 'ok', group: 'Giấy phép', text: 'LICENSE.txt có trong thư mục cài, giống hệt bản trong repo' },
    ])
    fs.writeFileSync(path.join(d, 'LICENSE.txt'), 'licence\n')
    expect(inspectShippedFiles(d, [{ name: 'LICENSE.txt', source: src }])[0].text).toMatch(/khác/)
    expect(inspectShippedFiles(d, [{ name: 'THIRD-PARTY-NOTICES.txt', source: src }])[0].text).toMatch(/^Thiếu THIRD-PARTY-NOTICES\.txt cạnh file exe \(package\.json build\.extraFiles/)
    expect(inspectShippedFiles(d, [{ name: 'X.txt', source: path.join(dir, 'nope.txt') }])[0].text).toMatch(/^Thiếu file nguồn/)
    expect(inspectShippedFiles(d, undefined)).toEqual([])
  })
})

// Windows only, like the other fake-spawn signature tests: electron/signature.cjs answers "unknown" on any other platform
// before it spawns anything, so every signature check here would fail off Windows.
describe.runIf(hasSignatureModule && process.platform === 'win32')('inspectWindowsBuild over a fake build (canned PowerShell answers)', () => {
  let dir
  let build
  let unpacked
  let asar
  const OLD = new Date('2026-01-01T00:00:00Z')
  /** Rewrites a win-unpacked file and keeps it older than the installers (as electron-builder leaves them). */
  const writeUnpacked = (rel, data) => {
    const p = path.join(unpacked, ...rel.split('/'))
    fs.writeFileSync(p, data)
    fs.utimesSync(p, OLD, OLD)
  }
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanovids-inspect-'))
    unpacked = path.join(dir, 'win-unpacked')
    fs.mkdirSync(path.join(unpacked, 'resources'), { recursive: true })
    asar = fakeAsar()
    writeUnpacked('resources/app.asar', asar)
    writeUnpacked('SanoVids.exe', fakePe(integrityText(headerSha(asar))))
    for (const n of [...SIGNED_DLLS, ...MICROSOFT_DLLS]) writeUnpacked(n, 'MZ dll')
    writeUnpacked('resources/elevate.exe', 'MZ elevate')
    writeUnpacked('resources/app-update.yml', SIGNED_YML)
    writeUnpacked('LICENSE.txt', '\uFEFFlicence\n')
    fs.writeFileSync(path.join(dir, 'LICENSE.repo.txt'), '\uFEFFlicence\n')
    fs.writeFileSync(path.join(dir, 'SanoVids-Setup-0.5.0.exe'), 'MZ setup')
    fs.writeFileSync(path.join(dir, 'SanoVids-Portable-0.5.0.exe'), 'MZ portable')
    build = {
      setupPath: path.join(dir, 'SanoVids-Setup-0.5.0.exe'),
      portablePath: path.join(dir, 'SanoVids-Portable-0.5.0.exe'),
      unpackedDir: unpacked,
      exeName: 'SanoVids.exe',
      expect: { ...EXPECT, signer: PIN, shippedFiles: [{ name: 'LICENSE.txt', source: path.join(dir, 'LICENSE.repo.txt') }] },
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
    expect(results.some((r) => r.group === 'app.asar' && /INTEGRITY\/ELECTRONASAR\) khớp/.test(r.text))).toBe(true)
    expect(results.some((r) => r.group === 'Bản build' && r.level === 'ok')).toBe(true)
    expect(results.some((r) => r.group === 'Giấy phép' && r.level === 'ok')).toBe(true)
  })

  it('every PowerShell child gets a filtered environment (no profiler / runtime overrides, no PSModulePath)', async () => {
    const { spawnImpl, calls } = answers()
    const env = { ...process.env, COR_ENABLE_PROFILING: '1', COR_PROFILER_PATH: 'C:\\x\\evil.dll', DOTNET_X: '1', PSModulePath: 'C:\\evil' }
    await inspectWindowsBuild({ ...build, env, spawnImpl })
    expect(calls).toHaveLength(13)
    for (const c of calls) {
      const keys = Object.keys(c.opts.env).map((k) => k.toUpperCase())
      expect(keys.some((k) => k.startsWith('COR_') || k.startsWith('DOTNET_') || k === 'PSMODULEPATH')).toBe(false)
    }
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

  it('every file must carry THE release certificate when expect.signer is set (pins [OLD, NEW])', async () => {
    const { spawnImpl } = answers((name, kind) => (kind === 'sig' && (name === 'SanoVids-Setup-0.5.0.exe' || name === 'ffmpeg.dll') ? sigAnswer({ thumbprint: OTHER_PIN }) : null))
    const results = await inspectWindowsBuild({ ...build, expect: { ...build.expect, pins: [PIN, OTHER_PIN] }, spawnImpl })
    const fails = results.filter((r) => r.level === 'fail').map((r) => r.text)
    expect(fails).toHaveLength(2)
    expect(fails.every((t) => t.includes(OTHER_PIN) && t.includes('SIGNER_THUMBPRINT'))).toBe(true)
    // without a signer, any pin is enough (E2E harnesses with a test pin)
    const loose = await inspectWindowsBuild({ ...build, expect: { ...EXPECT, pins: [PIN, OTHER_PIN] }, spawnImpl: answers((name, kind) => (kind === 'sig' && name === 'ffmpeg.dll' ? sigAnswer({ thumbprint: OTHER_PIN }) : null)).spawnImpl })
    expect(loose.filter((r) => r.level === 'fail')).toEqual([])
  })

  it('an extra code file is checked too: unsigned fails (win.signExts), vendor-signed and our nested files pass', async () => {
    fs.mkdirSync(path.join(unpacked, 'resources', 'native'), { recursive: true })
    try {
      writeUnpacked('libnew.dll', 'MZ new')
      writeUnpacked('libvendor.dll', 'MZ vendor')
      writeUnpacked('resources/native/ours.node', 'MZ ours')
      const { spawnImpl, calls } = answers((name, kind) => {
        if (kind !== 'sig') return null
        if (name === 'libnew.dll') return SIG_FFMPEG_UNSIGNED
        if (name === 'libvendor.dll') return SIG_D3D
        return null
      })
      const results = await inspectWindowsBuild({ ...build, spawnImpl })
      expect(calls).toHaveLength(16)
      const fails = results.filter((r) => r.level === 'fail').map((r) => r.text)
      expect(fails).toEqual(['libnew.dll: không được ký bởi tác giả, cũng không mang chữ ký hợp lệ của hãng khác. Thêm "libnew.dll" vào package.json build.win.signExts rồi build lại.'])
      expect(results.some((r) => r.level === 'ok' && r.text === 'libvendor.dll: chữ ký gốc của Microsoft Corporation còn nguyên')).toBe(true)
      expect(results.some((r) => r.level === 'ok' && r.text === `resources/native/ours.node: ký bởi ${AUTHOR}`)).toBe(true)
    } finally {
      for (const f of ['libnew.dll', 'libvendor.dll']) fs.rmSync(path.join(unpacked, f), { force: true })
      fs.rmSync(path.join(unpacked, 'resources', 'native'), { recursive: true, force: true })
    }
  })

  it('fuses, app.asar.unpacked, the integrity resource and app-update.yml problems fail', async () => {
    const yml = path.join(unpacked, 'resources', 'app-update.yml')
    const extra = path.join(unpacked, 'resources', 'app.asar.unpacked')
    try {
      writeUnpacked('SanoVids.exe', fakePe(integrityText(headerSha(asar)), [49, 48, 49, 49, 48, 48, 48, 49, 49]))
      fs.mkdirSync(extra)
      writeUnpacked('resources/app-update.yml', SIGNED_YML.replace(AUTHOR, 'Nguy?n Giang Minh (Jame Steven)'))
      const results = await inspectWindowsBuild({ ...build, spawnImpl: answers().spawnImpl })
      const fails = results.filter((r) => r.level === 'fail')
      expect(fails.filter((r) => r.group === 'Fuse')).toHaveLength(6)
      expect(fails.some((r) => r.group === 'app.asar' && /app\.asar\.unpacked/.test(r.text))).toBe(true)
      expect(fails.some((r) => r.group === 'Nguồn cập nhật' && /lỗi mã hoá/.test(r.text))).toBe(true)
      expect(fails.some((r) => r.group === 'Nguồn cập nhật' && /^publisherName trong app-update.yml/.test(r.text))).toBe(true)

      // stale and missing integrity resource: the app would never start
      writeUnpacked('SanoVids.exe', fakePe(integrityText('0'.repeat(64))))
      const stale = await inspectWindowsBuild({ ...build, spawnImpl: answers().spawnImpl })
      expect(stale.filter((r) => r.group === 'app.asar' && r.level === 'fail').map((r) => r.text).some((t) => /khác header app\.asar/.test(t))).toBe(true)
      writeUnpacked('SanoVids.exe', fakePe(null))
      const none = await inspectWindowsBuild({ ...build, spawnImpl: answers().spawnImpl })
      expect(none.some((r) => r.group === 'app.asar' && r.level === 'fail' && /không có tài nguyên INTEGRITY/.test(r.text))).toBe(true)
      writeUnpacked('SanoVids.exe', Buffer.from(`MZ not a PE ${SENTINEL}`))
      const garbage = await inspectWindowsBuild({ ...build, spawnImpl: answers().spawnImpl })
      expect(garbage.some((r) => r.group === 'app.asar' && r.level === 'fail' && /Không đọc được mã toàn vẹn asar/.test(r.text))).toBe(true)

      writeUnpacked('resources/app-update.yml', SIGNED_YML.replace(`publisherName:\n  - ${AUTHOR}\n`, ''))
      const noName = await inspectWindowsBuild({ ...build, spawnImpl: answers().spawnImpl })
      expect(noName.filter((r) => r.group === 'Nguồn cập nhật').map((r) => r.text)).toEqual([PUBLISHER_NAME_MISSING])
      // feed: false leaves app-update.yml to the caller (publish-release group f)
      const noFeed = await inspectWindowsBuild({ ...build, feed: false, spawnImpl: answers().spawnImpl })
      expect(noFeed.some((r) => r.group === 'Nguồn cập nhật')).toBe(false)
    } finally {
      writeUnpacked('SanoVids.exe', fakePe(integrityText(headerSha(asar))))
      fs.rmSync(extra, { recursive: true, force: true })
      writeUnpacked('resources/app-update.yml', SIGNED_YML)
    }
  })

  it('a win-unpacked rebuilt after the installers and a missing shipped file fail', async () => {
    const exe = path.join(unpacked, 'SanoVids.exe')
    try {
      const later = new Date(fs.statSync(build.setupPath).mtimeMs + 60_000)
      fs.utimesSync(exe, later, later)
      const results = await inspectWindowsBuild({
        ...build,
        expect: { ...build.expect, shippedFiles: [...build.expect.shippedFiles, { name: 'THIRD-PARTY-NOTICES.txt', source: path.join(dir, 'LICENSE.repo.txt') }] },
        spawnImpl: answers().spawnImpl,
      })
      const fails = results.filter((r) => r.level === 'fail')
      expect(fails.filter((r) => r.group === 'Bản build').map((r) => r.text)).toHaveLength(2)
      expect(fails.some((r) => r.group === 'Giấy phép' && /^Thiếu THIRD-PARTY-NOTICES\.txt/.test(r.text))).toBe(true)
    } finally {
      fs.utimesSync(exe, OLD, OLD)
    }
  })

  it('a listed DLL missing from the build fails (the self-check of every installed app would say unknown)', async () => {
    for (const name of ['vulkan-1.dll', 'dxil.dll']) {
      const p = path.join(unpacked, name)
      fs.renameSync(p, `${p}.away`)
      try {
        const results = await inspectWindowsBuild({ ...build, spawnImpl: answers().spawnImpl })
        const fails = results.filter((r) => r.level === 'fail').map((r) => r.text)
        expect(fails).toHaveLength(1)
        expect(fails[0]).toMatch(new RegExp(`^Không có ${name.replace('.', '\\.')} trong bản build .*electron/hardening-rules\\.cjs`))
      } finally {
        fs.renameSync(`${p}.away`, p)
      }
    }
  })

  it('with productName + version, the Setup must be what installed apps accept as the update', async () => {
    const setupVi = (fields) => (name, kind) =>
      kind === 'vi' && name === 'SanoVids-Setup-0.5.0.exe'
        ? `SVVER${asciiJson({ v: 1, companyName: AUTHOR, legalCopyright: COPYRIGHT_BUILD, productName: 'SanoVids', productVersion: '0.5.0', ...fields, error: null })}SVVER`
        : null
    const big = 25 * 1024 * 1024
    const setup = build.setupPath
    const keep = fs.readFileSync(setup)
    try {
      // installer-sized and still newer than win-unpacked
      fs.writeFileSync(setup, Buffer.alloc(big, 0x4d))
      const expectId = { ...build.expect, productName: 'SanoVids', version: '0.5.0' }
      const good = await inspectWindowsBuild({ ...build, expect: expectId, spawnImpl: answers(setupVi({})).spawnImpl })
      expect(good.filter((r) => r.level === 'fail')).toEqual([])
      expect(good.some((r) => r.level === 'ok' && /ProductVersion 0\.5\.0/.test(r.text))).toBe(true)
      const wrong = await inspectWindowsBuild({ ...build, expect: expectId, spawnImpl: answers(setupVi({ productName: 'Other', productVersion: '0.4.9' })).spawnImpl })
      const fails = wrong.filter((r) => r.level === 'fail').map((r) => r.text)
      expect(fails).toHaveLength(2)
      expect(fails.every((t) => t.startsWith('SanoVids-Setup-0.5.0.exe: Product') && t.includes('từ chối'))).toBe(true)
      // too small to be an installer
      fs.writeFileSync(setup, keep)
      const small = await inspectWindowsBuild({ ...build, expect: expectId, spawnImpl: answers(setupVi({})).spawnImpl })
      expect(small.filter((r) => r.level === 'fail').map((r) => r.text)).toEqual([expect.stringMatching(/^SanoVids-Setup-0\.5\.0\.exe: chỉ \d+ byte/)])
      // without productName / version the check is skipped (E2E harnesses, older callers)
      const skipped = await inspectWindowsBuild({ ...build, spawnImpl: answers(setupVi({ productVersion: '9.9.9' })).spawnImpl })
      expect(skipped.filter((r) => r.level === 'fail')).toEqual([])
    } finally {
      fs.writeFileSync(setup, keep)
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

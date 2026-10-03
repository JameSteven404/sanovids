// Inspects a built Windows release (impure: reads files, spawns Windows PowerShell). Used by scripts/publish-release.mjs
// (check group j "Chữ ký số") and reusable by the signing E2E harness.
//   - Authenticode: Setup, Portable, the app exe and resources/elevate.exe signed by a pinned certificate WITH an RFC 3161
//     timestamp; Electron's four unsigned DLLs (win.signExts) signed by a pin; Microsoft's d3dcompiler_47.dll / dxil.dll
//     still carrying Microsoft's own valid signature (never re-signed).
//   - VersionInfo (CompanyName / LegalCopyright) of the exe, Setup and Portable.
//   - Fuse wire of the exe (@electron/fuses, the copy electron-builder uses), no resources/app.asar.unpacked.
//   - resources/app-update.yml: public feed + publisherName, byte-exact UTF-8.
// PowerShell runs exactly like electron/signature.cjs: powershell.exe by absolute path, shell:false, hidden, a literal
// one-line -Command (no -EncodedCommand, no -ExecutionPolicy Bypass), the file path only via an environment variable,
// stdout read up to 64 KB between markers, ASCII-escaped JSON; stderr never decides anything. Pure decisions live in
// scripts/releaseLib.mjs; the builders / parsers below are covered by scripts/__tests__/buildInspect.test.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { checkAppUpdateYml, checkFuseWire, checkSignatureVerdict, checkVersionInfo } from './releaseLib.mjs'

const require = createRequire(import.meta.url)
const ELECTRON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron')

/** Electron DLLs that ship unsigned and are signed by name (package.json build.win.signExts). */
export const SIGNED_DLLS = Object.freeze(['ffmpeg.dll', 'vk_swiftshader.dll', 'vulkan-1.dll', 'dxcompiler.dll'])
/** DLLs Microsoft signs: their signature must stay Microsoft's (valid, Status 0) and never become ours. */
export const MICROSOFT_DLLS = Object.freeze(['d3dcompiler_47.dll', 'dxil.dll'])
export const PS_TIMEOUT_MS = 60_000
const STDOUT_MAX = 64 * 1024
const THUMBPRINT = /^[0-9A-F]{40}$/

// ───────────────────────────── PowerShell (builders / parsers: pure) ─────────────────────────────

export const VERSION_INFO_ENV = 'SANOVIDS_VI_PATH'
const VI_MARKER = 'SVVER'
const SIG_MARKER = 'SVSIG'

/**
 * One line, no double quote / newline / backtick (Node quotes the -Command argument as one "…" token). The path
 * arrives only via $env:SANOVIDS_VI_PATH. Output: SVVER{json}SVVER, every char above 126 written as \uXXXX.
 */
export const VERSION_INFO_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  '$r=[ordered]@{v=1;companyName=$null;legalCopyright=$null;productName=$null;fileDescription=$null;fileVersion=$null;productVersion=$null;originalFilename=$null;error=$null}',
  "try { $p=$env:SANOVIDS_VI_PATH; if([string]::IsNullOrEmpty($p)){throw 'no-path'}; $i=[System.Diagnostics.FileVersionInfo]::GetVersionInfo($p); " +
    '$r.companyName=$i.CompanyName; $r.legalCopyright=$i.LegalCopyright; $r.productName=$i.ProductName; $r.fileDescription=$i.FileDescription; ' +
    // no ';' between the try block and its catch: PowerShell rejects "try { } ; catch { }"
    '$r.fileVersion=$i.FileVersion; $r.productVersion=$i.ProductVersion; $r.originalFilename=$i.OriginalFilename } catch { $r.error=$_.Exception.GetType().FullName }',
  '$j=$r|ConvertTo-Json -Compress',
  '$sb=New-Object System.Text.StringBuilder',
  "foreach($x in $j.ToCharArray()){ if([int]$x -gt 126){[void]$sb.AppendFormat('\\u{0:x4}',[int]$x)} else {[void]$sb.Append($x)} }",
  `[Console]::Out.Write('${VI_MARKER}'+$sb.ToString()+'${VI_MARKER}')`,
].join('; ')

/** powershell.exe arguments for one VersionInfo read. */
export function versionInfoArgs() {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', VERSION_INFO_SCRIPT]
}

/** Copy of baseEnv without PSModulePath (any case: a poisoned module path must not load anything) + name=file. */
export function scriptEnv(baseEnv, name, file) {
  const env = {}
  for (const [k, v] of Object.entries(baseEnv ?? {})) {
    if (k.toUpperCase() === 'PSMODULEPATH' || k.toUpperCase() === String(name).toUpperCase()) continue
    if (v != null) env[k] = String(v)
  }
  env[name] = String(file)
  return env
}

/** JSON object between the first and the last `marker` of stdout, or null. */
export function parseMarked(stdout, marker) {
  const s = typeof stdout === 'string' ? stdout : ''
  const a = s.indexOf(marker)
  const b = s.lastIndexOf(marker)
  if (a < 0 || b <= a) return null
  try {
    const obj = JSON.parse(s.slice(a + marker.length, b))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

const VI_FIELDS = ['companyName', 'legalCopyright', 'productName', 'fileDescription', 'fileVersion', 'productVersion', 'originalFilename']

/** stdout of VERSION_INFO_SCRIPT → { companyName, legalCopyright, productName, … } (string | null each), or null. */
export function parseVersionInfoOutput(stdout) {
  const obj = parseMarked(stdout, VI_MARKER)
  if (!obj || obj.v !== 1 || obj.error != null) return null
  return Object.fromEntries(VI_FIELDS.map((k) => [k, typeof obj[k] === 'string' ? obj[k] : null]))
}

/** stdout of electron/updater-rules.cjs SIGNATURE_SCRIPT → the raw object (status, thumbprint, signer…), or null. */
export function parseRawSignature(stdout) {
  const obj = parseMarked(stdout, SIG_MARKER)
  if (!obj || obj.v !== 1) return null
  return obj
}

/**
 * A Microsoft-signed DLL Electron ships: Get-AuthenticodeSignature Status 0 (Valid) and a signer that is NOT one of our
 * pins (signing it again would replace Microsoft's signature). → { level: 'ok' | 'fail', text }.
 */
export function judgeMicrosoftSigned(name, raw, pins) {
  const ours = new Set((Array.isArray(pins) ? pins : []).map((p) => String(p).replace(/\s+/g, '').toUpperCase()))
  if (!raw || raw.error != null || !Number.isInteger(raw.status)) return { level: 'fail', text: `${name}: không đọc được chữ ký số.` }
  const thumb = typeof raw.thumbprint === 'string' ? raw.thumbprint.toUpperCase() : ''
  if (thumb && ours.has(thumb)) {
    return { level: 'fail', text: `${name} bị ký lại bằng chứng chỉ của tác giả: phải giữ chữ ký Microsoft (đừng thêm file này vào win.signExts).` }
  }
  if (raw.status !== 0) return { level: 'fail', text: `${name}: chữ ký Microsoft không còn hợp lệ (Status ${raw.status}).` }
  if (!THUMBPRINT.test(thumb)) return { level: 'fail', text: `${name}: không có chứng chỉ người ký.` }
  return { level: 'ok', text: `${name}: chữ ký gốc của ${raw.signer || 'Microsoft'} còn nguyên` }
}

export function defaultPowershellPath(env = process.env) {
  return `${env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * Runs powershell.exe once. Never rejects: → { stdout, code, error } (error = 'timeout' | spawn error code | null).
 * stdout is kept up to 64 KB; stderr is drained and ignored. On timeout only this child is killed.
 */
export function runPowerShell({ args, env, timeoutMs = PS_TIMEOUT_MS, spawnImpl = spawn, powershellPath = defaultPowershellPath() }) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    let timer = null
    let child = null
    const finish = (r) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    const stdout = () => Buffer.concat(chunks).toString('utf8')
    try {
      child = spawnImpl(powershellPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (e) {
      finish({ stdout: '', code: null, error: String(e?.code || 'spawn-failed') })
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      finish({ stdout: stdout(), code: null, error: 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (c) => {
      if (size >= STDOUT_MAX) return
      const b = Buffer.from(c)
      chunks.push(b.subarray(0, STDOUT_MAX - size))
      size += Math.min(b.length, STDOUT_MAX - size)
    })
    child.stderr?.on('data', () => {})
    child.on('error', (e) => finish({ stdout: '', code: null, error: String(e?.code || 'spawn-error') }))
    child.on('close', (code) => finish({ stdout: stdout(), code: code ?? null, error: null }))
  })
}

// ───────────────────────────── inspection ─────────────────────────────

const isFile = (p) => {
  try {
    return Boolean(p) && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Runs fn over items, at most `limit` at a time; results keep the order of items. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const short = (t) => (typeof t === 'string' && t ? `${t.slice(0, 8)}…` : '—')

/**
 * Every check of a signed Windows build. → Array<{ level: 'ok' | 'warn' | 'fail', group, text }> (Vietnamese texts).
 * expect = { pins (package.json sanovids.signers), author (CompanyName), copyright (LegalCopyright),
 * publisherName (app-update.yml) }. Options for tests / harnesses: spawnImpl, powershellPath, timeoutMs, env;
 * feed: false skips app-update.yml (publish-release checks it itself in group f with inspectAppUpdateYml).
 */
export async function inspectWindowsBuild({ setupPath, portablePath, unpackedDir, exeName, expect = {}, spawnImpl, powershellPath, timeoutMs, env = process.env, feed = true }) {
  const results = []
  const add = (level, group, text) => results.push({ level, group, text })
  const pins = Array.isArray(expect.pins) ? expect.pins : []
  const ps = { spawnImpl: spawnImpl ?? spawn, powershellPath: powershellPath ?? defaultPowershellPath(env), timeoutMs: timeoutMs ?? PS_TIMEOUT_MS }
  const exePath = unpackedDir && exeName ? path.join(unpackedDir, exeName) : null
  const resources = unpackedDir ? path.join(unpackedDir, 'resources') : null
  if (!pins.length) add('fail', 'Chữ ký số', 'Không có vân tay chứng chỉ nào để so (package.json sanovids.signers).')

  // electron/signature.cjs (+ the PowerShell script of electron/updater-rules.cjs for the raw Microsoft check).
  let signature = null
  let rules = null
  try {
    signature = require(path.join(ELECTRON_DIR, 'signature.cjs'))
    rules = require(path.join(ELECTRON_DIR, 'updater-rules.cjs'))
  } catch (e) {
    add('fail', 'Chữ ký số', `Không nạp được electron/signature.cjs / updater-rules.cjs (${e?.message ?? e}).`)
  }
  const canVerify = Boolean(signature && typeof signature.checkFileSignature === 'function')
  const canRaw = Boolean(rules && typeof rules.powershellArgs === 'function')

  // 1. Signed + timestamped by a pin.
  const mainFiles = [
    { label: setupPath ? path.basename(setupPath) : 'Setup', file: setupPath },
    { label: portablePath ? path.basename(portablePath) : 'Portable', file: portablePath },
    { label: exeName || 'app exe', file: exePath },
    { label: 'resources/elevate.exe', file: resources ? path.join(resources, 'elevate.exe') : null },
  ]
  const dlls = SIGNED_DLLS.map((name) => ({ label: name, file: unpackedDir ? path.join(unpackedDir, name) : null }))
  const msDlls = MICROSOFT_DLLS.map((name) => ({ label: name, file: unpackedDir ? path.join(unpackedDir, name) : null }))
  const verify = (file) =>
    signature.checkFileSignature(file, { pins, timeoutMs: ps.timeoutMs, powershellPath: ps.powershellPath, spawnImpl: ps.spawnImpl })

  const mainVerdicts = await mapLimit(mainFiles, 4, async (f) => (isFile(f.file) && canVerify ? verify(f.file) : null))
  mainFiles.forEach((f, i) => {
    if (!isFile(f.file)) return add('fail', 'Chữ ký số', `Thiếu ${f.label}${f.file ? ` (${f.file})` : ''}.`)
    if (!canVerify) return
    const v = mainVerdicts[i]
    const problems = checkSignatureVerdict(f.label, v)
    if (problems.length) for (const p of problems) add('fail', 'Chữ ký số', p)
    else add('ok', 'Chữ ký số', `${f.label}: ký bởi ${v.signer || '—'} (vân tay ${short(v.thumbprint)}), có dấu thời gian`)
  })

  // 2. Electron's unsigned DLLs: signed by a pin (a missing timestamp only warns: Windows does not check DLL signatures).
  const dllVerdicts = await mapLimit(dlls, 4, async (f) => (isFile(f.file) && canVerify ? verify(f.file) : null))
  dlls.forEach((f, i) => {
    if (!isFile(f.file)) return add('warn', 'Chữ ký số', `Không có ${f.label} trong bản build (Electron đổi danh sách DLL? xem win.signExts).`)
    if (!canVerify) return
    const v = dllVerdicts[i]
    if (v && v.ok === true && v.status === 'signed') {
      if (v.timestamped) add('ok', 'Chữ ký số', `${f.label}: ký bởi ${v.signer || '—'}`)
      else add('warn', 'Chữ ký số', `${f.label}: đã ký nhưng thiếu dấu thời gian.`)
    } else for (const p of checkSignatureVerdict(f.label, v)) add('fail', 'Chữ ký số', p)
  })

  // 3. Microsoft's DLLs keep Microsoft's signature.
  const msRaw = await mapLimit(msDlls, 2, async (f) => {
    if (!isFile(f.file) || !canRaw) return null
    const r = await runPowerShell({ args: rules.powershellArgs(), env: scriptEnv(env, 'SANOVIDS_SIG_PATH', f.file), ...ps })
    return parseRawSignature(r.stdout)
  })
  msDlls.forEach((f, i) => {
    if (!isFile(f.file)) return add('warn', 'Chữ ký số', `Không có ${f.label} trong bản build.`)
    if (!canRaw) return add('fail', 'Chữ ký số', `${f.label}: electron/updater-rules.cjs chưa có powershellArgs().`)
    const j = judgeMicrosoftSigned(f.label, msRaw[i], pins)
    add(j.level, 'Chữ ký số', j.text)
  })

  // 4. VersionInfo of the exe, Setup and Portable.
  const viFiles = [mainFiles[2], mainFiles[0], mainFiles[1]]
  const infos = await mapLimit(viFiles, 3, async (f) => {
    if (!isFile(f.file)) return undefined
    const r = await runPowerShell({ args: versionInfoArgs(), env: scriptEnv(env, VERSION_INFO_ENV, f.file), ...ps })
    return parseVersionInfoOutput(r.stdout)
  })
  viFiles.forEach((f, i) => {
    if (infos[i] === undefined) return add('fail', 'Thông tin file', `Thiếu ${f.label}.`)
    const problems = checkVersionInfo(f.label, infos[i], { company: expect.author, copyright: expect.copyright })
    if (problems.length) for (const p of problems) add('fail', 'Thông tin file', p)
    else add('ok', 'Thông tin file', `${f.label}: CompanyName "${infos[i].companyName}", LegalCopyright đúng`)
  })

  // 5. Fuses (the @electron/fuses copy electron-builder itself uses).
  if (!isFile(exePath)) add('fail', 'Fuse', `Thiếu ${exeName || 'file exe'} trong ${unpackedDir || 'win-unpacked'}.`)
  else {
    try {
      const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
      const { getCurrentFuseWire } = builderRequire('@electron/fuses')
      const problems = checkFuseWire(await getCurrentFuseWire(exePath))
      if (problems.length) for (const p of problems) add('fail', 'Fuse', p)
      else add('ok', 'Fuse', 'RunAsNode, NodeOptions, NodeCliInspect, FileProtocolExtraPrivileges, CookieEncryption tắt; AsarIntegrity, OnlyLoadAppFromAsar bật')
    } catch (e) {
      add('fail', 'Fuse', `Không đọc được fuse của ${exeName} (${e?.message ?? e}).`)
    }
  }

  // 6. Everything loads from the integrity-checked app.asar.
  if (!resources) add('fail', 'app.asar', 'Không biết thư mục win-unpacked.')
  else {
    if (isFile(path.join(resources, 'app.asar'))) add('ok', 'app.asar', 'Có resources/app.asar')
    else add('fail', 'app.asar', 'Thiếu resources/app.asar.')
    if (fs.existsSync(path.join(resources, 'app.asar.unpacked'))) add('fail', 'app.asar', 'Có resources/app.asar.unpacked: file trong đó không được kiểm tra toàn vẹn (bỏ asarUnpack).')
    else add('ok', 'app.asar', 'Không có app.asar.unpacked')
  }

  // 7. app-update.yml: feed + publisherName, byte-exact.
  if (feed) {
    for (const r of inspectAppUpdateYml(resources ? path.join(resources, 'app-update.yml') : null, expect.publisherName)) results.push(r)
  }
  return results
}

/**
 * resources/app-update.yml of a build: releaseLib.checkAppUpdateYml (public feed, publisherName required and equal)
 * plus the raw bytes holding the exact UTF-8 of publisherName (not "Nguy?n"). → results in group 'Nguồn cập nhật'.
 */
export function inspectAppUpdateYml(ymlPath, publisherName) {
  const group = 'Nguồn cập nhật'
  if (!isFile(ymlPath)) return [{ level: 'fail', group, text: 'Thiếu resources/app-update.yml.' }]
  const out = []
  const bytes = fs.readFileSync(ymlPath)
  let feed = null
  try {
    feed = loadYaml(bytes.toString('utf8'))
  } catch {
    feed = null
  }
  const problems = checkAppUpdateYml(feed, { publisherName })
  for (const p of problems) out.push({ level: 'fail', group, text: p })
  const want = typeof publisherName === 'string' ? publisherName.normalize('NFC') : ''
  // Only when the field is there at all (a missing one is already reported above).
  const present = feed && typeof feed === 'object' && feed.publisherName != null
  if (want && present && !bytes.includes(Buffer.from(want, 'utf8'))) {
    const garbled = want.replace(/[^\x20-\x7e]/g, '?')
    out.push({
      level: 'fail',
      group,
      text: bytes.includes(Buffer.from(garbled, 'utf8'))
        ? `app-update.yml ghi publisherName bị lỗi mã hoá ("${garbled}").`
        : 'app-update.yml không chứa đúng chuỗi UTF-8 của publisherName.',
    })
  }
  if (!out.length) out.push({ level: 'ok', group, text: `app-update.yml: nguồn công khai, publisherName "${want}" (UTF-8 đúng)` })
  return out
}

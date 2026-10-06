// Inspects a built Windows release (impure: reads files, spawns Windows PowerShell). Used by scripts/publish-release.mjs
// (check group j "Chữ ký số") and reusable by the signing E2E harness.
//   - Authenticode: Setup, Portable, the app exe and resources/elevate.exe signed by a pinned certificate WITH an RFC 3161
//     timestamp (and, with expect.signer, by exactly the release's signing certificate); Electron's four unsigned DLLs
//     (win.signExts) signed by a pin; Microsoft's d3dcompiler_47.dll / dxil.dll still carrying Microsoft's own valid
//     signature (never re-signed); EVERY other code file in win-unpacked (*.exe, *.dll, *.node…) either signed by a pin
//     or keeping a valid third-party signature — an Electron upgrade that ships a new unsigned DLL fails here instead of
//     shipping it unsigned (electron-builder only signs the DLLs win.signExts names).
//   - VersionInfo (CompanyName / LegalCopyright) of the exe, Setup and Portable; the Setup's ProductName / ProductVersion
//     / size as installed apps require of an update (electron/updater-rules.cjs installerIdentityProblem).
//   - Fuse wire of the exe (@electron/fuses, the copy electron-builder uses), no resources/app.asar.unpacked, and the
//     exe's INTEGRITY/ELECTRONASAR resource equal to the sha256 of the app.asar header (resedit, read only).
//   - win-unpacked not newer than the installers (it is what they carry), files shipped next to the exe
//     (LICENSE.txt, THIRD-PARTY-NOTICES.txt) byte-identical to the repo's.
//   - resources/app-update.yml: public feed + publisherName, byte-exact UTF-8.
// PowerShell runs exactly like electron/signature.cjs (its resolvePowershell + powershellChildEnv when present: the real
// Windows folder's powershell.exe, a filtered environment), shell:false, hidden, a literal
// one-line -Command (no -EncodedCommand, no -ExecutionPolicy Bypass), the file path only via an environment variable,
// stdout read up to 64 KB between markers, ASCII-escaped JSON; stderr never decides anything. Pure decisions live in
// scripts/releaseLib.mjs; the builders / parsers below are covered by scripts/__tests__/buildInspect.test.mjs.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import {
  asarHeaderBytes,
  checkAppUpdateYml,
  checkAsarIntegrity,
  checkBuildFreshness,
  checkFuseWire,
  checkInstallerIdentity,
  checkSignatureVerdict,
  checkVersionInfo,
} from './releaseLib.mjs'

const require = createRequire(import.meta.url)

/** Scan all JavaScript, including lazy chunks; a harness chunk must never ship. Fails closed on unreadable archives. */
export function inspectPerfHarness(asarPath) {
  try {
    const asar = require('@electron/asar')
    const matches = asar.listPackage(asarPath).filter((file) => /\.[cm]?js$/i.test(file)
      && asar.extractFile(asarPath, file.replace(/^[\\/]+/, '')).includes('sanovids-perf-harness'))
    return matches.length ? [`Bộ đo hiệu năng lọt vào app.asar: ${matches.join(', ')}`] : []
  } catch (error) {
    return [`Không kiểm được bộ đo trong app.asar: ${error.message}`]
  }
}
const ELECTRON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron')
/** The app's own lists (electron/hardening-rules.cjs: pure, no requires): the release gate and the self-check agree. */
const hardening = require(path.join(ELECTRON_DIR, 'hardening-rules.cjs'))

/** Electron DLLs that ship unsigned and are signed by name (package.json build.win.signExts). */
export const SIGNED_DLLS = hardening.SIGNED_DLLS
/** DLLs Microsoft signs: their signature must stay Microsoft's (valid, Status 0) and never become ours. */
export const MICROSOFT_DLLS = hardening.MICROSOFT_DLLS
/** Below this size a signed file is not an installer of the app (= electron/updater-rules.cjs INSTALLER_MIN_BYTES). */
const INSTALLER_MIN_BYTES_FALLBACK = 20 * 1024 * 1024
/** Windows code files (PE images) the gate looks for anywhere in win-unpacked. */
export const CODE_FILE = /\.(?:exe|dll|node|sys|ocx|cpl|scr)$/i
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

/** Variable prefixes that make a .NET process load a profiler DLL or change runtime behaviour (like electron/signature.cjs). */
const CLR_ENV_PREFIXES = ['COR_', 'COMPLUS_', 'DOTNET_', 'CORECLR_']

/**
 * Copy of baseEnv without PSModulePath and the CLR injection knobs (any case: a poisoned module path or a profiler DLL
 * must not decide what the check prints) + name=file.
 */
export function scriptEnv(baseEnv, name, file) {
  const env = {}
  for (const [k, v] of Object.entries(baseEnv ?? {})) {
    const key = k.toUpperCase()
    if (key === 'PSMODULEPATH' || key === String(name).toUpperCase() || CLR_ENV_PREFIXES.some((p) => key.startsWith(p))) continue
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

/** Signer simple name of the Microsoft-signed DLLs Electron ships (same rule as the app's self-check). */
export const MICROSOFT_SIGNER = hardening.MICROSOFT_SIGNER

/**
 * A vendor-signed DLL Electron ships: Get-AuthenticodeSignature Status 0 (Valid) and a signer that is NOT one of our
 * pins (signing it again would replace the vendor's signature); with `signer`, exactly that signer name (Microsoft's
 * DLLs). → { level: 'ok' | 'fail', text }.
 */
export function judgeMicrosoftSigned(name, raw, pins, { signer = null } = {}) {
  const ours = new Set((Array.isArray(pins) ? pins : []).map((p) => String(p).replace(/\s+/g, '').toUpperCase()))
  if (!raw || raw.error != null || !Number.isInteger(raw.status)) return { level: 'fail', text: `${name}: không đọc được chữ ký số.` }
  const thumb = typeof raw.thumbprint === 'string' ? raw.thumbprint.toUpperCase() : ''
  if (thumb && ours.has(thumb)) {
    return { level: 'fail', text: `${name} bị ký lại bằng chứng chỉ của tác giả: phải giữ chữ ký Microsoft (đừng thêm file này vào win.signExts).` }
  }
  if (raw.status !== 0) return { level: 'fail', text: `${name}: chữ ký Microsoft không còn hợp lệ (Status ${raw.status}).` }
  if (!THUMBPRINT.test(thumb)) return { level: 'fail', text: `${name}: không có chứng chỉ người ký.` }
  if (signer && raw.signer !== signer) return { level: 'fail', text: `${name}: ký bởi "${raw.signer ?? '—'}", không phải ${signer}.` }
  return { level: 'ok', text: `${name}: chữ ký gốc của ${raw.signer || 'Microsoft'} còn nguyên` }
}

/**
 * A code file of win-unpacked that no other check names (`judgeSignature` = electron/updater-rules.cjs's; parsed =
 * its parseSignatureOutput result). Signed by a pin (by `signer` when given) → ok; a valid signature of someone else
 * (Status 0, not one of our pins: a vendor-signed file Electron ships) → ok; anything else fails, naming the fix
 * (electron-builder signs only the DLLs package.json build.win.signExts lists). → { level, text }.
 */
export function judgeOtherCodeFile(rel, parsed, pins, { signer = null, judgeSignature } = {}) {
  if (!parsed || typeof judgeSignature !== 'function') return { level: 'fail', text: `${rel}: không đọc được chữ ký số (PowerShell lỗi hoặc quá lâu).` }
  const ours = new Set((Array.isArray(pins) ? pins : []).map((p) => String(p).replace(/\s+/g, '').toUpperCase()))
  const v = judgeSignature(parsed, pins)
  if (v && v.ok === true && v.status === 'signed') {
    const problems = checkSignatureVerdict(rel, v, { signer, timestamp: false })
    return problems.length ? { level: 'fail', text: problems[0] } : { level: 'ok', text: `${rel}: ký bởi ${v.signer || '—'}` }
  }
  if (v && (v.status === 'tampered' || (typeof v.thumbprint === 'string' && ours.has(v.thumbprint.toUpperCase())))) {
    return { level: 'fail', text: checkSignatureVerdict(rel, v)[0] }
  }
  const vendor = judgeMicrosoftSigned(rel, parsed, pins)
  if (vendor.level === 'ok') return { level: 'ok', text: `${rel}: chữ ký gốc của ${parsed.signer || 'nhà phát hành'} còn nguyên` }
  const name = rel.split('/').pop()
  return {
    level: 'fail',
    text: `${rel}: không được ký bởi tác giả, cũng không mang chữ ký hợp lệ của hãng khác. Thêm "${name}" vào package.json build.win.signExts rồi build lại.`,
  }
}

/** Every code file (CODE_FILE) under `dir`, as sorted forward-slash relative paths. Symbolic links are not followed. */
export function listCodeFiles(dir) {
  const out = []
  const walk = (abs, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(abs, e.name), r)
      else if (e.isFile() && CODE_FILE.test(e.name)) out.push(r)
    }
  }
  if (dir) walk(dir, '')
  return out.sort()
}

/** Text of every INTEGRITY / ELECTRONASAR resource of a PE file (resedit, read only; a signed file is fine). */
export function readExeIntegrityResources(exePath) {
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
  const { NtExecutable, NtExecutableResource } = builderRequire('resedit')
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  return NtExecutableResource.from(exe)
    .entries.filter((e) => String(e.type) === 'INTEGRITY' && String(e.id) === 'ELECTRONASAR')
    .map((e) => Buffer.from(e.bin).toString('utf8'))
}

/** Hex sha256 of an asar archive's raw JSON header (what electron-builder embeds in the exe). Reads the header only. */
export function asarHeaderSha256(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const prefix = Buffer.alloc(16)
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error('asar: file too short')
    const total = asarHeaderBytes(prefix)
    const buf = Buffer.alloc(total)
    if (fs.readSync(fd, buf, 0, total, 0) !== total) throw new Error('asar: header truncated')
    return createHash('sha256').update(buf.subarray(16, total)).digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Files electron-builder copies next to the exe (package.json build.extraFiles): each must exist in win-unpacked and be
 * byte-identical to its repo source. files = [{ name, source }]. → results in group 'Giấy phép'.
 */
export function inspectShippedFiles(unpackedDir, files) {
  const group = 'Giấy phép'
  return (Array.isArray(files) ? files : []).map(({ name, source }) => {
    const shipped = unpackedDir ? path.join(unpackedDir, name) : null
    if (!isFile(source)) return { level: 'fail', group, text: `Thiếu file nguồn ${source} trong repo.` }
    if (!isFile(shipped)) return { level: 'fail', group, text: `Thiếu ${name} cạnh file exe (package.json build.extraFiles phải chép ${path.basename(source)} thành ${name}).` }
    if (!fs.readFileSync(shipped).equals(fs.readFileSync(source))) return { level: 'fail', group, text: `${name} trong bản build khác ${path.basename(source)} của repo: build lại.` }
    return { level: 'ok', group, text: `${name} có trong thư mục cài, giống hệt bản trong repo` }
  })
}

/**
 * Fallback only (electron/signature.cjs resolvePowershell decides whenever it loads): SystemRoot when it reads
 * <drive>:\Windows, else C:\Windows — never a folder an inherited variable points anywhere else.
 */
export function defaultPowershellPath(env = process.env) {
  const root = String(env?.SystemRoot || env?.SYSTEMROOT || '').replace(/\\+$/, '')
  return `${/^[A-Za-z]:\\Windows$/i.test(root) ? root : 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
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
 * publisherName (app-update.yml), signer? (SIGNER_THUMBPRINT: the one pinned certificate that must have signed every
 * file of this build), shippedFiles? ([{ name, source }] copied next to the exe), productName? + version? (the Setup's
 * VersionInfo must name them, as installed apps require of an update) }. Options for tests / harnesses:
 * spawnImpl, powershellPath, timeoutMs, env; feed: false skips app-update.yml (publish-release checks it itself in
 * group f with inspectAppUpdateYml).
 */
export async function inspectWindowsBuild({ setupPath, portablePath, unpackedDir, exeName, expect = {}, spawnImpl, powershellPath, timeoutMs, env = process.env, feed = true }) {
  const results = []
  const add = (level, group, text) => results.push({ level, group, text })
  const pins = Array.isArray(expect.pins) ? expect.pins : []
  const signer = typeof expect.signer === 'string' && expect.signer ? expect.signer : null
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
  // The same powershell.exe (the real Windows folder, never just whatever SystemRoot says) and the same filtered child
  // environment as the app's verifier, for this module's own PowerShell runs too.
  const resolved = signature && typeof signature.resolvePowershell === 'function' ? signature.resolvePowershell(env) : null
  const childBase = signature && typeof signature.powershellChildEnv === 'function' ? signature.powershellChildEnv(env, resolved?.root) : env
  const ps = { spawnImpl: spawnImpl ?? spawn, powershellPath: powershellPath ?? resolved?.exe ?? defaultPowershellPath(env), timeoutMs: timeoutMs ?? PS_TIMEOUT_MS }

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
    signature.checkFileSignature(file, { pins, timeoutMs: ps.timeoutMs, powershellPath: ps.powershellPath, spawnImpl: ps.spawnImpl, env })

  const mainVerdicts = await mapLimit(mainFiles, 4, async (f) => (isFile(f.file) && canVerify ? verify(f.file) : null))
  mainFiles.forEach((f, i) => {
    if (!isFile(f.file)) return add('fail', 'Chữ ký số', `Thiếu ${f.label}${f.file ? ` (${f.file})` : ''}.`)
    if (!canVerify) return
    const v = mainVerdicts[i]
    const problems = checkSignatureVerdict(f.label, v, { signer })
    if (problems.length) for (const p of problems) add('fail', 'Chữ ký số', p)
    else add('ok', 'Chữ ký số', `${f.label}: ký bởi ${v.signer || '—'} (vân tay ${short(v.thumbprint)}), có dấu thời gian`)
  })

  // 2. Electron's unsigned DLLs: signed by a pin (a missing timestamp only warns: Windows does not check DLL signatures).
  const dllVerdicts = await mapLimit(dlls, 4, async (f) => (isFile(f.file) && canVerify ? verify(f.file) : null))
  dlls.forEach((f, i) => {
    // The app's self-check needs every listed DLL: one missing = Giới thiệu says "unknown" on every machine.
    if (!isFile(f.file)) {
      return add('fail', 'Chữ ký số', `Không có ${f.label} trong bản build (Electron đổi danh sách DLL? sửa win.signExts và SIGNED_DLLS trong electron/hardening-rules.cjs).`)
    }
    if (!canVerify) return
    const v = dllVerdicts[i]
    const problems = checkSignatureVerdict(f.label, v, { signer, timestamp: false })
    if (problems.length) for (const p of problems) add('fail', 'Chữ ký số', p)
    else if (v.timestamped) add('ok', 'Chữ ký số', `${f.label}: ký bởi ${v.signer || '—'}`)
    else add('warn', 'Chữ ký số', `${f.label}: đã ký nhưng thiếu dấu thời gian.`)
  })

  // 3. Microsoft's DLLs keep Microsoft's signature.
  const msRaw = await mapLimit(msDlls, 2, async (f) => {
    if (!isFile(f.file) || !canRaw) return null
    const r = await runPowerShell({ args: rules.powershellArgs(), env: scriptEnv(childBase, 'SANOVIDS_SIG_PATH', f.file), ...ps })
    return parseRawSignature(r.stdout)
  })
  msDlls.forEach((f, i) => {
    if (!isFile(f.file)) return add('fail', 'Chữ ký số', `Không có ${f.label} trong bản build (sửa MICROSOFT_DLLS trong electron/hardening-rules.cjs).`)
    if (!canRaw) return add('fail', 'Chữ ký số', `${f.label}: electron/updater-rules.cjs chưa có powershellArgs().`)
    const j = judgeMicrosoftSigned(f.label, msRaw[i], pins, { signer: MICROSOFT_SIGNER })
    add(j.level, 'Chữ ký số', j.text)
  })

  // 3b. Every other code file anywhere in win-unpacked: an Electron upgrade can add one that win.signExts does not name
  // (electron-builder then ships it unsigned and says nothing).
  const named = new Set([exeName, 'resources/elevate.exe', ...SIGNED_DLLS, ...MICROSOFT_DLLS].filter(Boolean).map((n) => n.toLowerCase()))
  const others = listCodeFiles(unpackedDir).filter((rel) => !named.has(rel.toLowerCase()))
  const otherParsed = await mapLimit(others, 4, async (rel) => {
    if (!canRaw) return null
    const r = await runPowerShell({ args: rules.powershellArgs(), env: scriptEnv(childBase, 'SANOVIDS_SIG_PATH', path.join(unpackedDir, ...rel.split('/'))), ...ps })
    return rules.parseSignatureOutput(r.stdout)
  })
  others.forEach((rel, i) => {
    const j = judgeOtherCodeFile(rel, otherParsed[i], pins, { signer, judgeSignature: rules?.judgeSignature })
    add(j.level, 'Chữ ký số', j.text)
  })

  // 4. VersionInfo of the exe, Setup and Portable.
  const viFiles = [mainFiles[2], mainFiles[0], mainFiles[1]]
  const infos = await mapLimit(viFiles, 3, async (f) => {
    if (!isFile(f.file)) return undefined
    const r = await runPowerShell({ args: versionInfoArgs(), env: scriptEnv(childBase, VERSION_INFO_ENV, f.file), ...ps })
    return parseVersionInfoOutput(r.stdout)
  })
  viFiles.forEach((f, i) => {
    if (infos[i] === undefined) return add('fail', 'Thông tin file', `Thiếu ${f.label}.`)
    const problems = checkVersionInfo(f.label, infos[i], { company: expect.author, copyright: expect.copyright })
    if (problems.length) for (const p of problems) add('fail', 'Thông tin file', p)
    else add('ok', 'Thông tin file', `${f.label}: CompanyName "${infos[i].companyName}", LegalCopyright đúng`)
  })
  // 4b. The Setup is what installed apps download as the update: they accept it only when its (signed) VersionInfo
  // names this app and this version and it is installer-sized (electron/updater-rules.cjs installerIdentityProblem).
  if (expect.productName && expect.version && infos[1] !== undefined) {
    const problems = checkInstallerIdentity(mainFiles[0].label, infos[1], {
      productName: expect.productName,
      version: expect.version,
      size: isFile(setupPath) ? fs.statSync(setupPath).size : -1,
      minBytes: Number.isInteger(rules?.INSTALLER_MIN_BYTES) ? rules.INSTALLER_MIN_BYTES : INSTALLER_MIN_BYTES_FALLBACK,
    })
    if (problems.length) for (const p of problems) add('fail', 'Thông tin file', p)
    else add('ok', 'Thông tin file', `${mainFiles[0].label}: ProductName "${expect.productName}", ProductVersion ${expect.version} (app đã cài nhận được bản cập nhật này)`)
  }

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

  // 6. Everything loads from the integrity-checked app.asar, and the exe carries the right integrity hash (a stale or
  // missing one = the app exits at every start, on every machine, and cannot update itself out of it).
  const asarPath = resources ? path.join(resources, 'app.asar') : null
  if (!resources) add('fail', 'app.asar', 'Không biết thư mục win-unpacked.')
  else {
    if (isFile(asarPath)) {
      add('ok', 'app.asar', 'Có resources/app.asar')
      const perfProblems = inspectPerfHarness(asarPath)
      if (perfProblems.length) for (const problem of perfProblems) add('fail', 'Bộ đo hiệu năng', problem)
      else add('ok', 'Bộ đo hiệu năng', 'Không có bộ đo trong app.asar')
    }
    else add('fail', 'app.asar', 'Thiếu resources/app.asar.')
    if (fs.existsSync(path.join(resources, 'app.asar.unpacked'))) add('fail', 'app.asar', 'Có resources/app.asar.unpacked: file trong đó không được kiểm tra toàn vẹn (bỏ asarUnpack).')
    else add('ok', 'app.asar', 'Không có app.asar.unpacked')
  }
  if (isFile(exePath) && isFile(asarPath)) {
    try {
      const problems = checkAsarIntegrity(readExeIntegrityResources(exePath), asarHeaderSha256(asarPath))
      if (problems.length) for (const p of problems) add('fail', 'app.asar', p)
      else add('ok', 'app.asar', `${exeName}: mã toàn vẹn (INTEGRITY/ELECTRONASAR) khớp header app.asar`)
    } catch (e) {
      add('fail', 'app.asar', `Không đọc được mã toàn vẹn asar trong ${exeName} (${e?.message ?? e}).`)
    }
  }

  // 6b. win-unpacked is what the installers carry (electron-builder writes the installers after it).
  const mtime = (p) => (isFile(p) ? fs.statSync(p).mtimeMs : NaN)
  const installers = [mainFiles[0], mainFiles[1]].filter((f) => isFile(f.file)).map((f) => ({ label: f.label, mtimeMs: mtime(f.file) }))
  const unpackedFiles = [
    { label: exeName || 'file exe', mtimeMs: mtime(exePath) },
    { label: 'resources/app.asar', mtimeMs: mtime(asarPath) },
  ]
  if (installers.length && unpackedFiles.some((u) => Number.isFinite(u.mtimeMs))) {
    const problems = checkBuildFreshness({ unpacked: unpackedFiles, installers })
    if (problems.length) for (const p of problems) add('fail', 'Bản build', p)
    else add('ok', 'Bản build', 'win-unpacked có trước Setup / Portable (đúng là nội dung của bộ cài)')
  }

  // 6c. Files shipped next to the exe (licences).
  for (const r of inspectShippedFiles(unpackedDir, expect.shippedFiles)) results.push(r)

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

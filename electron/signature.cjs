// SanoVids — Authenticode check of files against the author's pinned certificate thumbprints.
//
// Used by electron/updater.cjs (every downloaded update, before it may install), by electron/main.cjs (the app's
// self-check of process.execPath and the DLLs next to it, shown in Cài đặt → Giới thiệu) and by scripts/*.mjs (release
// gate, via createRequire). It never requires 'electron': only node built-ins and the pure rules in ./updater-rules.cjs
// (SIGNATURE_SCRIPT, parseSignatureOutput, judgeSignature — the decision table lives and is tested there).
//
// How: Windows PowerShell 5.1 runs Get-AuthenticodeSignature + an X509Chain build (no revocation check, unknown root
// allowed) on the file, whose path travels only in env SANOVIDS_SIG_PATH (checkFilesSignature: one PowerShell for a few
// files, their paths in env SANOVIDS_SIG_PATHS). No shell, no -EncodedCommand, no execution policy change. stdout
// carries marker-wrapped ASCII JSON; stderr is only logged and never decides anything. Any failure (no PowerShell,
// timeout, garbage) is a verdict 'unknown' — never a rejection, never a pass.
//
// The inherited environment never picks or steers the verifier: powershell.exe comes from the real Windows folder
// (SystemRoot only when it looks like <drive>:\Windows and the file really is there, else C:\Windows), and the child
// gets an allowlisted environment (no COR_* / COMPlus_* / DOTNET_* profiler or runtime overrides, no PSModulePath, no
// PATH entry outside Windows).
'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const rules = require('./updater-rules.cjs')

const SIGNATURE_TIMEOUT_MS = 60_000
const STDOUT_MAX = 64 * 1024
const STDERR_LOG_MAX = 500
/** At most this many files in one checkFilesSignature call (the self-check uses 7). */
const BATCH_MAX = 16
const PATHS_ENV = 'SANOVIDS_SIG_PATHS'
const RECORD_MARK = 'SVSIG'
const WINDOWS_FALLBACK = 'C:\\Windows'
const POWERSHELL_REL = '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * The pinned signer thumbprints of package.json `sanovids.signers`. Default: the app's own package.json (inside
 * app.asar when packaged, protected by the asar integrity fuse). Any read / parse problem → [] (every check then fails
 * closed with 'no-pins').
 */
function readSignerPins(pkgJsonPath) {
  try {
    const file = typeof pkgJsonPath === 'string' && pkgJsonPath ? pkgJsonPath : path.join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return rules.parseSignerPins(pkg && pkg.sanovids && pkg.sanovids.signers)
  } catch {
    return []
  }
}

const UNKNOWN = Object.freeze({ ok: false, status: 'unknown', reason: 'verify-failed', timestamped: false })

/** env[name] with Windows' case-insensitive names (works for process.env and for plain objects). */
function envValue(env, name) {
  if (!env || typeof env !== 'object') return undefined
  const lower = name.toLowerCase()
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower && typeof env[key] === 'string') return env[key]
  return undefined
}

/**
 * The Windows PowerShell 5.1 to run → { root, exe }. `env.SystemRoot` is used only when it reads <drive>:\Windows AND
 * the real path of its powershell.exe is exactly that file (no junction, subst drive or network share in between);
 * otherwise C:\Windows (same test). Neither → the C:\Windows path anyway: spawning it fails and the verdict is unknown.
 */
function resolvePowershell(env, fsImpl) {
  const f = fsImpl && typeof fsImpl === 'object' ? fsImpl : fs
  const realpath = f.realpathSync && typeof f.realpathSync.native === 'function' ? f.realpathSync.native : f.realpathSync
  const fromEnv = String(envValue(env === undefined ? process.env : env, 'SystemRoot') || '').replace(/\\+$/, '')
  const roots = /^[A-Za-z]:\\Windows$/i.test(fromEnv) ? [fromEnv] : []
  if (!roots.some((r) => r.toLowerCase() === WINDOWS_FALLBACK.toLowerCase())) roots.push(WINDOWS_FALLBACK)
  for (const root of roots) {
    const exe = root + POWERSHELL_REL
    try {
      if (typeof realpath === 'function' && String(realpath(exe)).toLowerCase() === exe.toLowerCase()) return { root, exe }
    } catch {
      /* not there: next candidate */
    }
  }
  return { root: WINDOWS_FALLBACK, exe: WINDOWS_FALLBACK + POWERSHELL_REL }
}

/** Inherited variables PowerShell may use (folders, locale-free machine facts, an admin's PowerShell lockdown policy). */
const CHILD_ENV_KEEP = new Set(
  [
    'SystemDrive',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'ALLUSERSPROFILE',
    'PUBLIC',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'CommonProgramW6432',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'OS',
    'USERNAME',
    'USERDOMAIN',
    'COMPUTERNAME',
    'PATHEXT',
    // Kept on purpose: an administrator's (unsupported but real) way to force ConstrainedLanguage. Set by an attacker it
    // can only make the check fail (verdict unknown, fail closed) — never pass.
    '__PSLockdownPolicy',
  ].map((k) => k.toLowerCase()),
)

/**
 * The base environment of the PowerShell child (before rules.powershellEnv adds the path): only CHILD_ENV_KEEP names
 * from `baseEnv`, plus SystemRoot / windir = `root` and a PATH of Windows folders only. Everything else is dropped:
 * COR_ENABLE_PROFILING / COR_PROFILER (a profiler DLL inside the verifier), COMPlus_* / DOTNET_* runtime overrides,
 * PSModulePath, PSExecutionPolicyPreference, and PATH entries a DLL could be planted in.
 */
function powershellChildEnv(baseEnv, root) {
  const src = baseEnv && typeof baseEnv === 'object' ? baseEnv : {}
  const r = typeof root === 'string' && root ? root : WINDOWS_FALLBACK
  const out = {}
  for (const key of Object.keys(src)) if (CHILD_ENV_KEEP.has(key.toLowerCase()) && typeof src[key] === 'string') out[key] = src[key]
  out.SystemRoot = r
  out.windir = r
  out.Path = [`${r}\\System32`, r, `${r}\\System32\\Wbem`, `${r}\\System32\\WindowsPowerShell\\v1.0\\`].join(';')
  return out
}

/**
 * One PowerShell for several files: SIGNATURE_SCRIPT (unchanged) runs once per path of env SANOVIDS_SIG_PATHS ('|'
 * separated: a character Windows paths never contain) and each record ends with a line feed. The JSON never holds a raw
 * line feed (ConvertTo-Json escapes control characters), so record i is line i. No '"', newline or backtick, like the
 * single-file script.
 */
function batchSignatureScript() {
  return `foreach($q in $env:${PATHS_ENV}.Split([char]124)){ $env:SANOVIDS_SIG_PATH=$q; ${rules.SIGNATURE_SCRIPT}; [Console]::Out.Write([char]10) }`
}

/** One log line, never multi-line, never throwing. */
function safeLog(log, line) {
  if (typeof log !== 'function') return
  try {
    log(String(line).replace(/[\r\n]+/g, ' '))
  } catch {
    /* logging never breaks the check */
  }
}

/** The per-file verdict line (same format for single and batch checks). */
function logVerdict(log, verdict, parsed, name) {
  const p = parsed || {}
  const thumb = typeof p.thumbprint === 'string' && p.thumbprint ? p.thumbprint.slice(0, 8) : '-'
  safeLog(log, `signature ${verdict.reason} status=${Number.isInteger(p.status) ? p.status : '-'} hresult=${p.hresult || '-'} thumb=${thumb} file=${name}`)
}

const errLabel = (e) => (e && e.code) || (e && e.message) || e

/**
 * Runs powershell.exe once. NEVER rejects: → { stdout: string | null, cause, stderr }. stdout (at most 64 KB) is null
 * when the process could not run or timed out (then only this child is killed); cause is 'exit <code>' otherwise.
 */
function runPowershell({ exe, args, env, timeoutMs, spawnImpl }) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let child = null
    const out = []
    let outBytes = 0
    let errText = ''
    const done = (stdout, cause) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ stdout, cause, stderr: errText.trim().slice(0, STDERR_LOG_MAX) })
    }
    try {
      child = spawnImpl(exe, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (e) {
      done(null, `spawn failed (${errLabel(e)})`)
      return
    }
    if (!child || typeof child.on !== 'function') {
      done(null, 'spawn returned no process')
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      done(null, `timeout after ${timeoutMs} ms`)
    }, timeoutMs)
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        if (outBytes >= STDOUT_MAX) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
        const part = buf.subarray(0, STDOUT_MAX - outBytes)
        out.push(part)
        outBytes += part.length
      })
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        if (errText.length < STDERR_LOG_MAX) errText += String(chunk)
      })
    }
    child.on('error', (e) => done(null, `powershell error (${errLabel(e)})`))
    // The marker JSON is ASCII (the script \u-escapes every other char); UTF-8 decoding keeps it exact either way.
    child.on('close', (code) => done(Buffer.concat(out).toString('utf8'), `exit ${code}`))
  })
}

/** Shared options → { log, pins, timeoutMs, spawnImpl, baseEnv, exe, root }. */
function runOptions(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const baseEnv = o.env && typeof o.env === 'object' ? o.env : process.env
  const ps = resolvePowershell(baseEnv)
  return {
    log: o.log,
    pins: rules.parseSignerPins(o.pins),
    timeoutMs: typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : SIGNATURE_TIMEOUT_MS,
    spawnImpl: typeof o.spawnImpl === 'function' ? o.spawnImpl : childProcess.spawn,
    baseEnv,
    exe: typeof o.powershellPath === 'string' && o.powershellPath ? o.powershellPath : ps.exe,
    root: ps.root,
  }
}

/**
 * Checks `file` against `opts.pins`. NEVER rejects: resolves a SignatureVerdict
 *   { ok, status: 'signed'|'unsigned'|'other-signer'|'tampered'|'unknown',
 *     reason: 'ok'|'not-signed'|'hash-mismatch'|'other-signer'|'bad-chain'|'verify-failed'|'no-pins'|'policy',
 *     thumbprint?, signer?, timestamped, productVersion?, productName? }
 * ('policy' = PowerShell runs in ConstrainedLanguage on this machine; productVersion / productName = the file's signed
 * VersionInfo, present only on a signed verdict whose script could read them — see rules.judgeSignature.)
 * opts: { pins, timeoutMs = 60000, log(line), powershellPath, spawnImpl, env } (the last three for tests; env = the
 * inherited environment, default process.env).
 */
function checkFileSignature(file, opts) {
  const o = runOptions(opts)
  const name = typeof file === 'string' ? path.basename(file) : '?'
  const report = (verdict, parsed, cause) => {
    if (cause) safeLog(o.log, `signature check problem: ${cause} file=${name}`)
    logVerdict(o.log, verdict, parsed, name)
    return verdict
  }
  if (process.platform !== 'win32') return Promise.resolve(report({ ...UNKNOWN }, null, `not supported on ${process.platform}`))
  if (!o.pins.length) return Promise.resolve(report(rules.judgeSignature(null, o.pins), null, 'no pinned signer'))
  if (typeof file !== 'string' || file === '') return Promise.resolve(report({ ...UNKNOWN }, null, 'no file'))
  const env = rules.powershellEnv(powershellChildEnv(o.baseEnv, o.root), path.resolve(file))
  return runPowershell({ exe: o.exe, args: rules.powershellArgs(), env, timeoutMs: o.timeoutMs, spawnImpl: o.spawnImpl })
    .then((run) => {
      if (run.stderr) safeLog(o.log, `signature stderr: ${run.stderr}`)
      if (run.stdout === null) return report({ ...UNKNOWN }, null, run.cause)
      const parsed = rules.parseSignatureOutput(run.stdout)
      if (!parsed) return report({ ...UNKNOWN }, null, `no signature output (${run.cause})`)
      return report(rules.judgeSignature(parsed, o.pins), parsed, parsed.error ? `powershell reported ${parsed.error}` : '')
    })
    .catch(() => ({ ...UNKNOWN }))
}

/**
 * Checks several files with ONE PowerShell (the self-check: the exe and its DLLs). NEVER rejects: resolves, in the
 * order given, [{ file, parsed, verdict }] — parsed = the normalized raw output (rules.parseSignatureOutput, null when
 * there is none), verdict = rules.judgeSignature(parsed, pins). Any problem with the run as a whole (no PowerShell,
 * timeout, not exactly one record per file, a bad file list) → every verdict unknown. Same opts as checkFileSignature.
 */
function checkFilesSignature(files, opts) {
  const o = runOptions(opts)
  const list = Array.isArray(files) ? files.slice() : []
  const names = list.map((f) => (typeof f === 'string' ? path.basename(f) : '?'))
  const settle = (perFile, cause) => {
    if (cause) safeLog(o.log, `signature check problem: ${cause} files=${names.join(',')}`)
    return list.map((file, i) => {
      const { parsed, verdict } = perFile(i)
      logVerdict(o.log, verdict, parsed, names[i])
      return { file, parsed, verdict }
    })
  }
  const allUnknown = (cause) => settle(() => ({ parsed: null, verdict: { ...UNKNOWN } }), cause)
  if (!list.length) return Promise.resolve([])
  if (process.platform !== 'win32') return Promise.resolve(allUnknown(`not supported on ${process.platform}`))
  if (!o.pins.length) return Promise.resolve(settle(() => ({ parsed: null, verdict: rules.judgeSignature(null, o.pins) }), 'no pinned signer'))
  const badPath = (f) => typeof f !== 'string' || f === '' || /[|\u0000-\u001f]/.test(f)
  if (list.length > BATCH_MAX || list.some(badPath)) return Promise.resolve(allUnknown('bad file list'))
  const env = rules.powershellEnv(powershellChildEnv(o.baseEnv, o.root), path.resolve(list[0]))
  delete env.SANOVIDS_SIG_PATH
  env[PATHS_ENV] = list.map((f) => path.resolve(f)).join('|')
  const args = [...rules.powershellArgs().slice(0, -1), batchSignatureScript()]
  return runPowershell({ exe: o.exe, args, env, timeoutMs: o.timeoutMs, spawnImpl: o.spawnImpl })
    .then((run) => {
      if (run.stderr) safeLog(o.log, `signature stderr: ${run.stderr}`)
      if (run.stdout === null) return allUnknown(run.cause)
      // Only the script's records start a line with the marker (a stray "WARNING: …" line is skipped).
      const records = run.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.startsWith(RECORD_MARK))
      // The script may stop the whole run after its first record (e.g. PowerShell in ConstrainedLanguage reports that
      // once and exits): an error record then stands for every file. It is never a pass (judgeSignature: error → not ok).
      const first = records.length === 1 ? rules.parseSignatureOutput(records[0]) : null
      if (first && first.error != null && list.length > 1) {
        return settle(() => ({ parsed: first, verdict: rules.judgeSignature(first, o.pins) }), `powershell reported ${first.error} (${run.cause})`)
      }
      if (records.length !== list.length) return allUnknown(`${records.length} signature records for ${list.length} files (${run.cause})`)
      const parsed = records.map((r) => rules.parseSignatureOutput(r))
      return settle((i) => ({ parsed: parsed[i], verdict: parsed[i] ? rules.judgeSignature(parsed[i], o.pins) : { ...UNKNOWN } }), '')
    })
    .catch(() => list.map((file) => ({ file, parsed: null, verdict: { ...UNKNOWN } })))
}

module.exports = {
  readSignerPins,
  checkFileSignature,
  checkFilesSignature,
  resolvePowershell,
  powershellChildEnv,
  batchSignatureScript,
  SIGNATURE_TIMEOUT_MS,
}

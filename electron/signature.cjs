// SanoVids — Authenticode check of a file against the author's pinned certificate thumbprints.
//
// Used by electron/updater.cjs (every downloaded update, before it may install), by electron/main.cjs (the app's
// self-check of process.execPath, shown in Cài đặt → Giới thiệu) and by scripts/*.mjs (release gate, via createRequire).
// It never requires 'electron': only node built-ins and the pure rules in ./updater-rules.cjs (SIGNATURE_SCRIPT,
// parseSignatureOutput, judgeSignature — the decision table lives and is tested there).
//
// How: Windows PowerShell 5.1 runs Get-AuthenticodeSignature + an X509Chain build (no revocation check, unknown root
// allowed) on the file, whose path travels only in env SANOVIDS_SIG_PATH. No shell, no -EncodedCommand, no execution
// policy change. stdout carries one marker-wrapped ASCII JSON object; stderr is only logged and never decides anything.
// Any failure (no PowerShell, timeout, garbage) is a verdict 'unknown' — never a rejection, never a pass.
'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const rules = require('./updater-rules.cjs')

const SIGNATURE_TIMEOUT_MS = 60_000
const STDOUT_MAX = 64 * 1024
const STDERR_LOG_MAX = 500

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

function defaultPowershell() {
  return `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
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

/**
 * Checks `file` against `opts.pins`. NEVER rejects: resolves a SignatureVerdict
 *   { ok, status: 'signed'|'unsigned'|'other-signer'|'tampered'|'unknown',
 *     reason: 'ok'|'not-signed'|'hash-mismatch'|'other-signer'|'bad-chain'|'verify-failed'|'no-pins',
 *     thumbprint?, signer?, timestamped }
 * opts: { pins, timeoutMs = 60000, log(line), powershellPath, spawnImpl } (the last two for tests).
 */
function checkFileSignature(file, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const log = o.log
  const name = typeof file === 'string' ? path.basename(file) : '?'
  const report = (verdict, parsed, cause) => {
    const p = parsed || {}
    const thumb = typeof p.thumbprint === 'string' && p.thumbprint ? p.thumbprint.slice(0, 8) : '-'
    if (cause) safeLog(log, `signature check problem: ${cause} file=${name}`)
    safeLog(
      log,
      `signature ${verdict.reason} status=${Number.isInteger(p.status) ? p.status : '-'} hresult=${p.hresult || '-'} thumb=${thumb} file=${name}`,
    )
    return verdict
  }
  if (process.platform !== 'win32') return Promise.resolve(report({ ...UNKNOWN }, null, `not supported on ${process.platform}`))
  const pins = rules.parseSignerPins(o.pins)
  if (!pins.length) return Promise.resolve(report(rules.judgeSignature(null, pins), null, 'no pinned signer'))
  if (typeof file !== 'string' || file === '') return Promise.resolve(report({ ...UNKNOWN }, null, 'no file'))
  const timeoutMs = typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : SIGNATURE_TIMEOUT_MS
  const spawnImpl = typeof o.spawnImpl === 'function' ? o.spawnImpl : childProcess.spawn
  const exe = typeof o.powershellPath === 'string' && o.powershellPath ? o.powershellPath : defaultPowershell()

  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let child = null
    const out = []
    let outBytes = 0
    let errText = ''
    const finish = (verdict, parsed, cause) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (errText.trim()) safeLog(log, `signature stderr: ${errText.trim().slice(0, STDERR_LOG_MAX)}`)
      resolve(report(verdict, parsed, cause))
    }
    try {
      child = spawnImpl(exe, rules.powershellArgs(), {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: rules.powershellEnv(process.env, path.resolve(file)),
      })
    } catch (e) {
      finish({ ...UNKNOWN }, null, `spawn failed (${(e && e.code) || (e && e.message) || e})`)
      return
    }
    if (!child || typeof child.on !== 'function') {
      finish({ ...UNKNOWN }, null, 'spawn returned no process')
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ...UNKNOWN }, null, `timeout after ${timeoutMs} ms`)
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
    child.on('error', (e) => finish({ ...UNKNOWN }, null, `powershell error (${(e && e.code) || (e && e.message) || e})`))
    child.on('close', (code) => {
      // The marker JSON is ASCII (the script \u-escapes every other char); UTF-8 decoding keeps it exact either way.
      const parsed = rules.parseSignatureOutput(Buffer.concat(out).toString('utf8'))
      if (!parsed) return finish({ ...UNKNOWN }, null, `no signature output (exit ${code})`)
      finish(rules.judgeSignature(parsed, pins), parsed, parsed.error ? `powershell reported ${parsed.error}` : '')
    })
  })
}

module.exports = { readSignerPins, checkFileSignature, SIGNATURE_TIMEOUT_MS }

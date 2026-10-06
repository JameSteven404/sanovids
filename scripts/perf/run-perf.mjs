// Explicit developer command only. Never invoked by tests or release builds; never run from the agent sandbox.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { servePerf } from './serve.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export function parseArgs(args) {
  const options = { target: 'web', size: 'L', runs: 3, headed: false, trace: false, browser: null, baseline: null }
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '')
    if (!(key in options) || !args[i].startsWith('--')) throw new Error(`Tham số lạ: ${args[i]}`)
    if (key === 'headed' || key === 'trace') options[key] = true
    else {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Thiếu giá trị --${key}`)
      options[key] = key === 'runs' ? Number(value) : value
    }
  }
  if (!['web', 'exe'].includes(options.target) || !['M', 'L', 'XL'].includes(options.size)
    || !Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) throw new Error('Dùng --target web|exe --size M|L|XL --runs 1..10.')
  return options
}
export function perfBuildConfig(build, profile) {
  const { signtoolOptions: _sign, ...win } = build.win
  return { ...build, appId: 'com.sanovids.test.perf', productName: 'SanoVidsPerf', executableName: 'SanoVidsPerf',
    extraMetadata: { ...build.extraMetadata, productName: 'SanoVidsPerf', sanovidsTestProfileDir: profile },
    directories: { ...build.directories, output: '.perf/exe' },
    files: [{ from: '.perf/dist', to: 'dist' }, 'electron/**/*', 'package.json'],
    forceCodeSigning: false, win: { ...win, forceCodeSigning: false, signExecutable: false }, publish: null }
}
function start(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, shell: false, windowsHide: true, stdio: 'inherit' })
  child.on('error', (error) => { child.launchError = error })
  return child
}
async function execute(command, args, env) {
  const child = start(command, args, env)
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`Lệnh kết thúc với mã ${code}: ${command}`)
}
export class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.listeners = new Map()
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const request = this.pending.get(message.id)
        if (!request) return
        this.pending.delete(message.id); clearTimeout(request.timer)
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result)
      } else this.listeners.get(message.method)?.(message.params)
    })
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP đã đóng.')) }
      this.pending.clear()
    })
  }
  send(method, params = {}, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP quá thời gian: ${method}`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, 600000)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
}
async function connect(port, child) {
  for (let i = 0; i < 100; i++) {
    if (child.launchError) throw child.launchError
    if (child.exitCode !== null) throw new Error('Chương trình đã đóng trước khi CDP sẵn sàng.')
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((p) => p.type === 'page')
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
        return new CDP(socket)
      }
    } catch { /* Chromium is still starting. */ }
    await sleep(100)
  }
  throw new Error('Không kết nối được CDP.')
}
async function freePort() {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const scratch = path.join(root, '.perf')
  await mkdir(scratch, { recursive: true })
  const temporary = await mkdtemp(path.join(scratch, 'run-'))
  const profile = path.join(temporary, 'profile')
  let child, cdp, server, tracing = false
  try {
    const buildEnv = { ...process.env, SANOVIDS_PERF: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    await execute(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'perf'], buildEnv)
    const port = await freePort()
    if (options.target === 'web') {
      server = await servePerf()
      const browser = options.browser ?? [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]
        .filter(Boolean).map((p) => path.join(p, 'Microsoft/Edge/Application/msedge.exe')).find(existsSync)
      if (!browser) throw new Error('Không tìm thấy Edge; chỉ định --browser <đường dẫn>.')
      child = start(browser, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
        '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--force-device-scale-factor=1',
        ...(options.headed ? [] : ['--headless=new']), 'about:blank'])
    } else {
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      const config = path.join(temporary, 'eb.perf.cjs')
      await writeFile(config, `module.exports = ${JSON.stringify(perfBuildConfig(pkg.build, profile), null, 2)}\n`)
      await execute(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', 'dir', '--publish', 'never', '--config', config,
        '-c.directories.output=.perf/exe'], { ...buildEnv, ELECTRON_BUILDER_DISABLE_BUILD_CACHE: 'true' })
      child = start(path.join(scratch, 'exe/win-unpacked/SanoVidsPerf.exe'), [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--force-device-scale-factor=1'])
    }
    cdp = await connect(port, child)
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    const headed = options.target === 'exe' || options.headed
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__SANOVIDS_PERF_ISOLATED__=true;window.__SANOVIDS_PERF_HEADED__=${headed};window.__SANOVIDS_PERF_TARGET__=${JSON.stringify(options.target)};` })
    // Offline-only renderer: the test harness never needs a remote gateway or any external resource.
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    cdp.listeners.set('Fetch.requestPaused', (event) => {
      const url = new URL(event.request.url)
      const allowed = ['app:', 'data:', 'blob:'].includes(url.protocol) || url.origin === 'http://127.0.0.1:5191'
      void cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
    })
    if (options.target === 'web') await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5191' })
    else await cdp.send('Page.reload')
    let ready = false
    for (let i = 0; i < 200; i++) {
      if (await cdp.evaluate('Boolean(window.sanovidsPerf)')) { ready = true; break }
      await sleep(100)
    }
    if (!ready) throw new Error('Bộ đo không sẵn sàng.')
    await cdp.evaluate(`sanovidsPerf.create(${JSON.stringify(options.size)})`)
    if (options.trace) {
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing', transferMode: 'ReturnAsStream' }); tracing = true
    }
    const report = await cdp.evaluate(`sanovidsPerf.run(${options.runs})`)
    const heaps = [], urlCounts = []
    for (let i = 0; i <= 5; i++) {
      const state = await cdp.evaluate(`sanovidsPerf.memorySwitch(${i})`)
      await cdp.send('HeapProfiler.collectGarbage')
      heaps.push((await cdp.send('Runtime.getHeapUsage')).usedSize)
      urlCounts.push(state.urlCount)
    }
    report.memory = { heaps, urlCounts, passed: heaps.at(-1) - heaps[0] <= 10 * 1024 ** 2 && (options.size !== 'L' || Math.max(...heaps) <= 120 * 1024 ** 2) }
    report.host = { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, node: process.version }
    const baseline = options.baseline ? JSON.parse(await readFile(options.baseline, 'utf8')) : undefined
    const verdict = await cdp.evaluate(`(() => { const baseline = ${JSON.stringify(baseline)}; const report = sanovidsPerf.withBaselineBudgets(${JSON.stringify(report)},baseline); const code = sanovidsPerf.exitCode(report,baseline); return {code, report} })()`)
    const reportPath = path.join(scratch, `report-${options.target}-${options.size}-${Date.now()}.json`)
    await writeFile(reportPath, JSON.stringify(verdict.report, null, 2) + '\n')
    console.log(`Kết quả: ${reportPath}`)
    if (tracing) {
      const done = new Promise((resolve) => cdp.listeners.set('Tracing.tracingComplete', resolve))
      await cdp.send('Tracing.end'); tracing = false
      const { stream } = await done
      const parts = []
      for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); parts.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data)); if (chunk.eof) break }
      await cdp.send('IO.close', { handle: stream })
      await writeFile(reportPath.replace('.json', '.trace.json'), Buffer.concat(parts))
    }
    process.exitCode = verdict.code
  } finally {
    if (cdp) {
      await cdp.evaluate('window.sanovidsPerf?.cleanup()').catch((error) => console.error('Dọn dữ liệu:', error.message))
      await cdp.send('Browser.close', {}, 5000).catch(() => {})
      cdp.socket.close()
    }
    if (child && !child.launchError && child.exitCode === null) {
      await Promise.race([once(child, 'exit'), sleep(5000)])
      if (child.exitCode === null) child.kill() // Only the process created by this driver.
    }
    if (server) await new Promise((resolve) => server.close(resolve))
    // Resolve before recursive deletion, including junction aliases; never delete a caller-supplied path.
    const resolved = await realpath(temporary), allowedRoot = await realpath(scratch)
    if (!resolved.startsWith(allowedRoot + path.sep) || !path.basename(resolved).startsWith('run-')) throw new Error('Từ chối xoá ngoài thư mục thử.')
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 2 })
}

import { flushSync } from 'react-dom'
import { deleteMedia, urlCount } from '../lib/imageStore'
import { useCanvasPrefs, DEFAULT_CANVAS_PREFS } from '../lib/canvasPrefs'
import { flushAll } from '../lib/promptDrafts'
import { deleteProject, forgetDeletedProject, installProject, switchProject, useSave, flush } from '../store/persist'
import { clearHistory, useProject } from '../store/project'
import { stopEngine, useRuns } from '../store/runs'
import { useUI } from '../store/ui'
import { SIZES, synthProject, type PerfSize, type SynthSpec } from './synth'
import { synthMedia } from './synthMedia'
import { budgetFor } from './budgets'
import { compare, reportExitCode, withBaselineBudgets, stats, verdict, type PerfReport, type PerfResult } from './report'
import { frame, measure, pause, settle } from './measure'
import { PERF_MARKER, perfCanvas, type ProbeSnapshot } from './probe'
import { scenarios } from './scenarios'

const MANIFEST = 'bdp:perf:manifest'
interface Manifest { version: 1; previous: string; projects: string[]; media: string[]; size: PerfSize | 'custom'; spec: SynthSpec; hash: string }
let controller: AbortController | null = null
let busy = false
let lastReport: PerfReport | null = null
let previousReport: PerfReport | null = null
const emptyProbe = (): ProbeSnapshot => ({ counts: {}, commits: {}, durations: {} })
export function assertIsolated(): void {
  if (!__SANOVIDS_PERF__ || (location.origin !== 'http://127.0.0.1:5191' && window.__SANOVIDS_PERF_ISOLATED__ !== true)) {
    throw new Error('Bộ đo chỉ chạy tại 127.0.0.1:5191 hoặc hồ sơ thử do driver tạo.')
  }
}
function manifest(): Manifest | null {
  const raw = localStorage.getItem(MANIFEST)
  if (!raw) return null
  const value = JSON.parse(raw) as Manifest
  if (value.version !== 1 || typeof value.previous !== 'string' || !Array.isArray(value.projects) || !Array.isArray(value.media)
    || ![...value.projects, ...value.media].every((id) => typeof id === 'string' && id.startsWith('prf_'))
    || value.projects.includes(value.previous)) throw new Error('Manifest thử không hợp lệ; giữ nguyên dữ liệu để kiểm tra.')
  return value
}
async function create(size: PerfSize | SynthSpec = 'L') {
  assertIsolated()
  if (busy) throw new Error('Bộ đo đang bận.')
  if (manifest()) throw new Error('Hãy dọn dữ liệu thử trước khi tạo lại.')
  busy = true
  try {
    const spec = typeof size === 'string' ? SIZES[size] : size
    const data = synthProject(spec)
    const alternate = synthProject({ scenes: 1, takes: 1 }, 20261007)
    const bytes = new TextEncoder().encode(JSON.stringify(data))
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const record: Manifest = { version: 1, previous: useProject.getState().project.id, projects: [data.project.id, alternate.project.id],
      media: [...data.project.assets, ...alternate.project.assets].flatMap((a) => a.imageIds), size: typeof size === 'string' ? size : 'custom', spec, hash }
    // Journal first: recovery after a quota error or interruption knows every id to remove.
    localStorage.setItem(MANIFEST, JSON.stringify(record))
    await synthMedia(record.media)
    await installProject(alternate.project, alternate.runs)
    await installProject(data.project, data.runs)
    stopEngine()
    return record
  } finally { busy = false }
}
async function cleanup() {
  assertIsolated()
  if (busy) throw new Error('Hãy dừng và chờ bài đo kết thúc trước khi dọn.')
  const record = manifest()
  if (!record) return
  busy = true
  try {
    if (!useSave.getState().projects.some((p) => p.id === record.previous)) throw new Error('Không tìm thấy dự án cũ; giữ manifest để phục hồi.')
    await switchProject(record.previous)
    for (const id of record.projects) {
      if (useSave.getState().projects.some((p) => p.id === id)) await deleteProject(id)
      await forgetDeletedProject(id)
    }
    for (const id of record.media) await deleteMedia(id)
    for (const key of Object.keys(localStorage)) if (key.startsWith('bdp:perf:') && key !== MANIFEST) localStorage.removeItem(key)
    localStorage.removeItem(MANIFEST)
  } finally { busy = false }
}
function addProbe(total: ProbeSnapshot, next: ProbeSnapshot) {
  for (const kind of ['counts', 'commits'] as const) for (const [key, value] of Object.entries(next[kind])) total[kind][key] = (total[kind][key] ?? 0) + value
  for (const [key, values] of Object.entries(next.durations)) (total.durations[key] ??= []).push(...values)
}
async function run(runs = 3): Promise<PerfReport> {
  assertIsolated()
  if (busy) throw new Error('Bộ đo đang bận.')
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('Số lượt đo phải từ 1 tới 10.')
  const record = manifest()
  if (!record) throw new Error('Chưa tạo dự án thử.')
  busy = true
  controller = new AbortController()
  const signal = controller.signal
  const ui = useUI.getState(), prefs = useCanvasPrefs.getState()
  const returnId = useProject.getState().project.id
  const oldViewport = perfCanvas()?.getViewport()
  const results: PerfResult[] = []
  const stopButton = document.createElement('button')
  stopButton.className = 'btn dv-perf-stop'
  stopButton.textContent = 'Dừng đo hiệu năng'
  stopButton.onclick = () => controller?.abort(new Error('Đã dừng bài đo.'))
  document.body.append(stopButton)
  const report: PerfReport = { version: 1, marker: PERF_MARKER, at: new Date().toISOString(),
    machine: { userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
      target: window.__SANOVIDS_PERF_TARGET__ ?? 'web', headed: window.__SANOVIDS_PERF_HEADED__ ?? document.visibilityState === 'visible' },
    size: record.size, spec: record.spec, dataHash: record.hash, runs, results, complete: false }
  try {
    flushAll()
    await switchProject(record.projects[0]); stopEngine()
    flushSync(() => {
      useUI.setState({ view: 'canvas', leftOpen: true, rightOpen: true, dialog: { kind: 'none' }, edgeMode: 'selected', showMinimap: true, selectedIds: [], takeDisplay: 'all', interaction: 'hand', queueOpen: false })
      useCanvasPrefs.setState(DEFAULT_CANVAS_PREFS)
    })
    await settle('.react-flow')
    const project = useProject.getState().project, originalRuns = useRuns.getState(), baselineUI = useUI.getState()
    for (const scenario of scenarios(record.projects[0], record.projects[1])) {
      if (signal.aborted) break
      const result: PerfResult = { id: scenario.id, label: scenario.label, workMs: null, budget: budgetFor(scenario.id, record.size),
        status: 'unavailable', estimated: false, renders: emptyProbe(), maxRenders: {}, frames: null, assertions: [] }
      if (scenario.optional) { result.reason = scenario.optional; results.push(result); continue }
      const values: number[] = [], intervals: number[] = []
      let loafMax = 0, over33 = 0, frameSamples = 0
      try {
        for (let repetition = -1; repetition < runs; repetition++) {
          signal.throwIfAborted()
          await switchProject(project.id); stopEngine()
          flushSync(() => {
            useProject.setState({ project })
            useRuns.setState({ takes: originalRuns.takes, credits: originalRuns.credits, spent: originalRuns.spent })
            useUI.setState({ ...baselineUI, toasts: [] })
          })
          await settle('.react-flow')
          await perfCanvas()?.setViewport({ x: 30, y: 30, zoom: 1 })
          await frame()
          await flush()
          const measured = await measure(scenario.run, signal)
          if (repetition < 0) continue
          values.push(...measured.values)
          addProbe(result.renders, measured.renders)
          for (const [key, count] of Object.entries(measured.maxCounts)) result.maxRenders![key] = Math.max(result.maxRenders![key] ?? 0, count)
          result.estimated ||= measured.estimated
          if (measured.frames?.intervals) {
            intervals.push(...measured.frameIntervals)
            loafMax = Math.max(loafMax, measured.frames.loafMax)
            over33 += measured.frames.over33 * measured.frames.intervals.count
            frameSamples += measured.frames.intervals.count
          }
        }
        result.workMs = stats(values)
        result.status = verdict(result.workMs?.p95 ?? null, result.budget)
        result.frames = frameSamples ? { intervals: stats(intervals), over33: over33 / frameSamples, loafMax } : null
        const check = (label: string, passed: boolean) => result.assertions.push({ label, passed })
        if (['typeInspector', 'promptCommit', 'runsTick'].includes(scenario.id)) check('CanvasInner không render', !result.renders.counts.CanvasInner)
        if (scenario.id === 'select') check('Tối đa 25 dòng video cho một lựa chọn', (result.maxRenders!.TakeRow ?? 0) <= 25)
        if (scenario.id === 'runsTick') check('Không ghi runs khi chỉ đổi tiến độ', !(result.renders.durations.autosaveRuns?.length))
        if (['drag', 'drag50'].includes(scenario.id)) check('Không commit ngoài canvas khi kéo', ['Sidebar', 'Inspector', 'TopBar'].every((id) => !result.renders.commits[id]))
        if (result.frames && ['pan', 'pan04', 'panFar', 'zoom', 'drag', 'drag50', 'typeInspector'].includes(scenario.id)) {
          check('Trung vị khung hình ≤ 17 ms', (result.frames.intervals?.median ?? Infinity) <= 17)
          check('Tối đa 5% khung hình > 33 ms', result.frames.over33 <= 0.05)
          check('Không có khung dài vượt ngân sách', result.frames.loafMax <= (scenario.id === 'typeInspector' ? 50 : 100))
        }
        if (result.assertions.some((a) => !a.passed)) result.status = 'fail'
      } catch (error) {
        result.reason = error instanceof Error ? error.message : String(error)
      } finally {
        flushAll()
        await switchProject(project.id); stopEngine()
        flushSync(() => {
          useProject.setState({ project }); useRuns.setState({ takes: originalRuns.takes, credits: originalRuns.credits, spent: originalRuns.spent })
          useUI.setState({ ...baselineUI, toasts: [] })
        })
        clearHistory()
        await flush()
      }
      results.push(result)
      if (scenario.id === 'autosave' && result.status !== 'unavailable') {
        for (const id of ['autosaveProject', 'autosaveRuns']) {
          const workMs = stats(result.renders.durations[id] ?? [])
          const budget = budgetFor(id, record.size)
          results.push({ ...result, id, label: id === 'autosaveProject' ? 'Ghi project · đồng bộ' : 'Ghi runs · đồng bộ', workMs, budget, status: verdict(workMs?.p95 ?? null, budget), frames: null, assertions: [] })
        }
      }
    }
    await settle('.react-flow')
    const dom = document.querySelectorAll('*').length, budget = budgetFor('dom', record.size)
    results.push({ id: 'dom', label: 'Số phần tử DOM', workMs: stats([dom]), budget, status: verdict(dom, budget), estimated: false, renders: emptyProbe(), frames: null, assertions: [] })
    report.complete = !signal.aborted && results.every((r) => r.status !== 'unavailable' || r.reason?.startsWith('Chờ giao diện E2'))
    previousReport = lastReport
    lastReport = report
    return report
  } finally {
    try {
      flushAll()
      await switchProject(returnId)
      flushSync(() => { useUI.setState(ui); useCanvasPrefs.setState(prefs) })
      if (oldViewport) await perfCanvas()?.setViewport(oldViewport)
    } finally { stopButton.remove(); busy = false; controller = null }
  }
}
export const harness = {
  marker: PERF_MARKER, create, run, cleanup,
  stop: () => controller?.abort(new Error('Đã dừng bài đo.')),
  report: () => lastReport,
  previousReport: () => previousReport,
  compare,
  exitCode: reportExitCode,
  withBaselineBudgets,
  async memorySwitch(index: number) {
    assertIsolated()
    if (busy) throw new Error('Bộ đo đang bận.')
    const record = manifest()
    if (!record) throw new Error('Chưa tạo dự án thử.')
    await switchProject(record.projects[1]); stopEngine()
    await switchProject(record.projects[0]); stopEngine()
    await pause(300)
    return { index, urlCount: urlCount() }
  },
}
export function exposeHarness() { assertIsolated(); window.sanovidsPerf = harness }

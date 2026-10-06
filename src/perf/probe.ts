import type { ProfilerOnRenderCallback } from 'react'

export const PERF_MARKER = 'sanovids-perf-harness'
export interface ProbeSnapshot {
  counts: Record<string, number>
  commits: Record<string, number>
  durations: Record<string, number[]>
}
let snapshot: ProbeSnapshot = { counts: {}, commits: {}, durations: {} }
let version = 0
export function perfCount(name: string): void {
  if (__SANOVIDS_PERF__) { snapshot.counts[name] = (snapshot.counts[name] ?? 0) + 1; version++ }
}
export function perfMark(name: string): () => void {
  if (!__SANOVIDS_PERF__) return () => {}
  const start = performance.now()
  return () => { (snapshot.durations[name] ??= []).push(performance.now() - start) }
}
export const perfRender: ProfilerOnRenderCallback = (id, _phase, duration) => {
  if (!__SANOVIDS_PERF__) return
  snapshot.commits[id] = (snapshot.commits[id] ?? 0) + 1
  version++
  ;(snapshot.durations[`react.${id}`] ??= []).push(duration)
}
export function resetProbe(): void { snapshot = { counts: {}, commits: {}, durations: {} } }
export function readProbe(): ProbeSnapshot { return structuredClone(snapshot) }
export const readCounts = () => ({ ...snapshot.counts })
export const probeVersion = () => version

/** P2 supplies the RF instance and its forced measurement hook; no runtime import from React Flow here. */
export interface PerfCanvas {
  getViewport(): { x: number; y: number; zoom: number }
  setViewport(viewport: { x: number; y: number; zoom: number }): unknown
  measure(): void
}
let canvas: PerfCanvas | null = null
export function registerPerfCanvas(api: PerfCanvas): () => void {
  if (!__SANOVIDS_PERF__) return () => {}
  canvas = api
  return () => { if (canvas === api) canvas = null }
}
export const perfCanvas = () => canvas

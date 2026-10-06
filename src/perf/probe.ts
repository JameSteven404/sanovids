// Performance probes (stub for now). Components call perfCount('SceneNodeView') and the like. In every normal build
// __SANOVIDS_PERF__ is false (vite.config.ts `define`), so a call does nothing and the harness is never bundled; the
// perf harness (src/perf/**, `vite build --mode perf`) fills in the bodies. Only reference PERF_MARKER — or import
// other perf code — behind `if (__SANOVIDS_PERF__)`: the release checks refuse an app.asar that contains the marker.

/** Marker string of the perf harness: present in a perf build only. */
export const PERF_MARKER = 'sanovids-perf-harness'

/** Count one render / call of `name` (no-op outside a perf build). */
export function perfCount(name: string): void {
  if (!__SANOVIDS_PERF__) return
  void name
}

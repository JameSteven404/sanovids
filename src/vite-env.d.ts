/// <reference types="vite/client" />

/**
 * Build flag of the performance harness (vite.config.ts `define`): false in every normal build, so the probes in
 * src/perf/probe.ts are no-ops and the harness is tree-shaken out.
 */
declare const __SANOVIDS_PERF__: boolean

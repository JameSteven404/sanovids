/// <reference types="vite/client" />

/**
 * Build flag of the performance harness (vite.config.ts `define`): false in every normal build, so the probes in
 * src/perf/probe.ts are no-ops and the harness is tree-shaken out.
 */
declare const __SANOVIDS_PERF__: boolean

interface Window {
  /** Set by CDP before navigation, only after creating an isolated profile. */
  __SANOVIDS_PERF_ISOLATED__?: boolean
  __SANOVIDS_PERF_HEADED__?: boolean
  __SANOVIDS_PERF_TARGET__?: 'web' | 'exe'
  sanovidsPerf?: typeof import('./perf/runner').harness
  /** Set by the SANO app hosting the web build (providers/sano): turns the 'sano-gateway' provider on. */
  __SANO_GATEWAY__?: { token?: () => Promise<string | null> | string | null }
}

interface ImportMetaEnv {
  /** "1" = a web build made for SANO: the 'sano-gateway' provider is on without window.__SANO_GATEWAY__. */
  readonly VITE_SANO_GATEWAY?: string
}

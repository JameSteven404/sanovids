// Shared code-obfuscation options for the release build. One source of truth so the renderer (vite.config.ts)
// and the main process (scripts/pack-electron.mjs) stay consistent.
//
// Hard constraints (see CLAUDE.md):
//   - Renderer ships under CSP `script-src 'self'` with NO 'unsafe-eval': the output must never use eval() or the
//     Function constructor. That rules out debugProtection/selfDefending in the RENDERER (javascript-obfuscator
//     implements those with Function("debugger")). We keep them for the main process, which has no CSP.
//   - Object keys and globals are NOT renamed: IPC channel names, contextBridge API keys (window.bdpDesktop.*),
//     `require`, `module`, `exports`, `__dirname` must survive. String VALUES are always preserved by the
//     string-array transform (they are decoded back at runtime), so request bodies, the one-line SIGNATURE_SCRIPT,
//     ERROR_TEXT, etc. are byte-identical when the code runs.
//   - The canvas renderer is perf-sensitive (100+ nodes): control-flow flattening is kept light there.
import JavaScriptObfuscator from 'javascript-obfuscator'

/** CSP-safe, perf-conscious options for the bundled renderer chunks. */
export const RENDERER_OPTIONS = {
  target: 'browser',
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  transformObjectKeys: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersType: 'variable',
  splitStrings: false,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.25,
  deadCodeInjection: false,
  numbersToExpressions: false,
  // CSP: these use Function()/eval — must stay off in the renderer.
  debugProtection: false,
  selfDefending: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
}

/** Heavier options for the Electron main process (.cjs in app.asar; no CSP, so anti-debug is allowed). */
export const MAIN_OPTIONS = {
  ...RENDERER_OPTIONS,
  target: 'node',
  stringArrayThreshold: 0.9,
  controlFlowFlatteningThreshold: 0.5,
  // Main process has no CSP → the debugger trap is safe here. Low frequency to avoid overhead.
  debugProtection: true,
  debugProtectionInterval: 2000,
  // selfDefending stays OFF: main.cjs stability outweighs the marginal gain, and it can wrap code in ways that are
  // harder to reason about for the signed/updater paths.
  selfDefending: false,
  // Never silence console: electron/updater.cjs logs through it.
  disableConsoleOutput: false,
}

export function obfuscate(code, options) {
  return JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode()
}

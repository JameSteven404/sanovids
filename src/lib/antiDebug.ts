// Renderer-side anti-debug. Defense-in-depth only: the release build already blocks DevTools (F12 / Ctrl+Shift+I)
// and the inspect fuses are off, and the main process carries javascript-obfuscator's debugProtection. This adds a
// periodic `debugger` statement so that IF an inspector is ever attached, stepping through the code is painful.
//
// CSP-safe by design: a `debugger` statement is NOT eval/Function, so it runs under `script-src 'self'`. Active only
// in the obfuscated release bundle (import.meta.env.MODE === 'release'); never in dev, web, or perf builds.
export function initAntiDebug(): void {
  if (import.meta.env.MODE !== 'release') return
  const tick = () => {
    // eslint-disable-next-line no-debugger
    debugger
  }
  setInterval(tick, 2000)
}

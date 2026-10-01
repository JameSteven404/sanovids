// Runs in the sandboxed renderer before the page. Exposes a tiny, read-only bridge: window.bdpDesktop.
// The web app uses it to know it runs as the desktop build (no service worker, "installed" state).
'use strict'

const { contextBridge } = require('electron')

const arg = process.argv.find((a) => a.startsWith('--bdp-version='))

contextBridge.exposeInMainWorld('bdpDesktop', {
  version: arg ? arg.slice('--bdp-version='.length) : '',
  electron: process.versions.electron,
  platform: process.platform,
})

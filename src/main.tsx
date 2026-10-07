import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted fonts (no network needed: offline PWA, desktop .exe). Only the subsets the UI uses.
import '@fontsource/be-vietnam-pro/400.css'
import '@fontsource/be-vietnam-pro/500.css'
import '@fontsource/be-vietnam-pro/600.css'
import '@fontsource/be-vietnam-pro/700.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-ext-400.css'
import '@fontsource/jetbrains-mono/vietnamese-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-ext-500.css'
import '@fontsource/jetbrains-mono/vietnamese-500.css'
import '@xyflow/react/dist/style.css'
import './styles/base.css'
import './styles/app.css'
import { App } from './App'
import { initDevAccess } from './devAccessActions'
import { initMotion } from './lib/canvasPrefs'
import { initPwa, registerServiceWorker } from './lib/pwa'
import { initTheme } from './lib/theme'
import { initRetiredVideoNotice } from './videoRetired'
import { loadAppPlacement, macPlacementNote, placementToastsOnLaunch } from './lib/appPlacement'
import { openSettings } from './actions'
import { toast } from './store/ui'

// Appearance (Sáng / Tối / Theo hệ thống) before the first render, so nothing paints in the wrong theme; it then
// follows the OS while the choice is "Theo hệ thống". index.html painted the page background inline to avoid a
// flash before the CSS loaded: the stylesheets are in now, so drop it (it would stay on the old theme's color).
initTheme()
document.documentElement.style.removeProperty('background')
// "Hiệu ứng chuyển động" (Settings): <html data-motion>, followed by styles/app.css everywhere.
initMotion()

// Before the first render: the one-shot beforeinstallprompt event can fire very early.
initPwa()
// Development mode lock (release builds hide it): follow the main process / the browser simulation.
initDevAccess()

// Reference videos were retired (0.6.0): once per project, say what happened to its old @video data.
initRetiredVideoNotice()

// Once per launch, outside React StrictMode's repeated effects; no automatic move.
void loadAppPlacement().then(({ kind }) => {
  const text = macPlacementNote(kind)
  if (text && placementToastsOnLaunch(kind)) toast(text, { tone: 'warning', ms: 12000, action: { label: 'Xem', run: () => openSettings('app') } })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

registerServiceWorker()

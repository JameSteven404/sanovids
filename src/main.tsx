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
import { initPwa, registerServiceWorker } from './lib/pwa'
import { initTheme } from './lib/theme'

// Appearance (Sáng / Tối / Theo hệ thống) before the first render, so nothing paints in the wrong theme; it then
// follows the OS while the choice is "Theo hệ thống". index.html painted the page background inline to avoid a
// flash before the CSS loaded: the stylesheets are in now, so drop it (it would stay on the old theme's color).
initTheme()
document.documentElement.style.removeProperty('background')

// Before the first render: the one-shot beforeinstallprompt event can fire very early.
initPwa()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

registerServiceWorker()

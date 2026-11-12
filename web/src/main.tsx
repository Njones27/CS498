import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './softShadow.css'
import App from './App.tsx'
import { applyTheme, readStoredTheme } from './lib/theme'

applyTheme(readStoredTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register service worker for Progressive Web App capabilities
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Ignore registration errors in unsupported or non-secure contexts
    })
  })
}

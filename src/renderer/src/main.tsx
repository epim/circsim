import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { createRendererStore } from './store/createRendererStore'

function boot(): void {
  const rootEl = document.getElementById('root')
  if (!rootEl) return

  // Synchronous: the store is created immediately and the SimHost port attaches
  // in the background (see createRendererStore). The UI renders right away so a
  // slow/failed sim handshake never blanks the app.
  const store = createRendererStore()

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App store={store} />
    </React.StrictMode>,
  )
}

boot()

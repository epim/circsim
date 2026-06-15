import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { createRendererStore } from './store/createRendererStore'

async function boot(): Promise<void> {
  const rootEl = document.getElementById('root')
  if (!rootEl) return

  const store = await createRendererStore()

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App store={store} />
    </React.StrictMode>,
  )
}

void boot()

import React from 'react'

export default function App(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>
      <header style={{ padding: '8px 16px', background: '#1a1a2e', color: '#eee', display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong>circsim</strong>
        <span style={{ fontSize: 12, color: '#888' }}>v0.1.0</span>
      </header>
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>
        <div style={{ textAlign: 'center' }}>
          <p>Open a <code>.kicad_pcb</code> file to begin</p>
        </div>
      </main>
    </div>
  )
}

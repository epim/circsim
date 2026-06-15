import { contextBridge } from 'electron'

// Minimal typed API exposed to the renderer
// More functions will be added in Task 11 (SimHost supervision)
contextBridge.exposeInMainWorld('circsim', {
  // Placeholder: Task 11 will expand this
  version: process.env['npm_package_version'] ?? '0.0.0'
})

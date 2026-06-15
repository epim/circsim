import { resolve } from 'path'
import { defineConfig } from 'vite'

// Separate Vite config for the SimHost utility process.
// Produces out/simhost/index.js — a standalone Node bundle loaded
// by Electron Main via utilityProcess.fork('out/simhost/index.js').
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/simhost/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    outDir: 'out/simhost',
    emptyOutDir: true,
    ssr: true,
    rollupOptions: {
      external: ['electron', 'koffi'],
      output: {
        format: 'cjs'
      }
    }
  },
  resolve: {
    conditions: ['node']
  }
})

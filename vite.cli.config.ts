import { resolve } from 'path'
import { defineConfig } from 'vite'

// Vite config for the headless CLI (issue #28).
// Produces out/cli/index.js, a standalone Node bundle behind the `circsim` bin
// entry. koffi stays external: it is a native addon resolved from node_modules.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/cli/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    outDir: 'out/cli',
    emptyOutDir: true,
    ssr: true,
    rollupOptions: {
      external: ['electron', 'koffi'],
      output: {
        format: 'cjs',
        banner: '#!/usr/bin/env node'
      }
    }
  },
  resolve: {
    conditions: ['node']
  }
})

// Diagnostic: does koffi load + can it dlopen ngspice.dll under THIS Node runtime?
// Run under Electron's node:  ELECTRON_RUN_AS_NODE=1 electron scripts/diag-koffi.mjs
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
const require = createRequire(import.meta.url)
console.log('process.versions:', JSON.stringify({ node: process.versions.node, electron: process.versions.electron, modules: process.versions.modules }))
try {
  const koffi = require('koffi')
  console.log('koffi required OK, version:', koffi.version ?? '(no version field)')
  const dll = path.join(process.cwd(), 'resources', 'ngspice', 'win32-x64', 'ngspice.dll')
  console.log('loading dll:', dll)
  const lib = koffi.load(dll)
  console.log('koffi.load OK')
  const init = lib.func('ngSpice_Init', 'int', ['void*', 'void*', 'void*', 'void*', 'void*', 'void*', 'void*'])
  console.log('bound ngSpice_Init OK:', typeof init)
  console.log('RESULT: SUCCESS')
} catch (e) {
  console.log('RESULT: FAILURE')
  console.log('ERROR:', e && e.stack ? e.stack : String(e))
}

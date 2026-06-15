// SimHost — placeholder; replaced in Task 9
// This module runs as an Electron utilityProcess.
// It will load libngspice via koffi FFI and communicate
// with the renderer via a MessagePort.

console.log('simhost alive')

// Task 9 will implement:
// - koffi FFI bindings to libngspice
// - SimCommand/SimEvent protocol over MessagePort
// - Watchdog timer, command queue, sample batcher

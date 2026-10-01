/**
 * renderer/scope/sampleEmitter.ts — Task 24
 *
 * A module-level EventTarget that carries raw `samples` SimEvent batches from the
 * store's event ingestion to the Scope panel, WITHOUT routing per-batch traffic
 * through React state (which would re-render the whole tree at sample rate).
 *
 * The store (appStore.ts `ingestSamples`) dispatches a `'samples'` CustomEvent
 * here. Scope.tsx no longer subscribes: since issue #59 it reads the store-owned
 * probe rings (`getProbeRingBuffer`), which `ingestSamples` already feeds. The
 * emitter has no subscriber in the app today. Keeping it in its own tiny,
 * React-free module lets the store import it without pulling React into the
 * store core.
 *
 * CustomEvent detail shape = the `samples` SimEvent payload:
 *   { vectorNames: string[]; columns: Float64Array[]; simTime: Float64Array }
 */

export const scopeSamplesEmitter = new EventTarget()

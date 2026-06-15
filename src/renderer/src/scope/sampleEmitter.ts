/**
 * renderer/scope/sampleEmitter.ts — Task 24
 *
 * A module-level EventTarget that carries raw `samples` SimEvent batches from the
 * store's event ingestion to the Scope panel, WITHOUT routing per-batch traffic
 * through React state (which would re-render the whole tree at sample rate).
 *
 * The store (appStore.ts `ingestSamples`) dispatches a `'samples'` CustomEvent
 * here; Scope.tsx subscribes and feeds the batch into its own per-probe ring
 * buffers for the canvas draw. Keeping the emitter in its own tiny, React-free
 * module lets the store import it without pulling React into the store core.
 *
 * CustomEvent detail shape = the `samples` SimEvent payload:
 *   { vectorNames: string[]; columns: Float64Array[]; simTime: Float64Array }
 */

export const scopeSamplesEmitter = new EventTarget()

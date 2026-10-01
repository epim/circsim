/**
 * Vite's `?worker&inline` import: a Worker constructor whose script is bundled
 * into a blob URL (see store/createRendererStore.ts). Declared here, in a file
 * with no imports or exports so the wildcard is an ambient declaration, rather
 * than pulling vite/client into the web program.
 */
declare module '*?worker&inline' {
  const WorkerConstructor: {
    new (): Worker
  }
  export default WorkerConstructor
}

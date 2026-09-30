// Type declarations for the helpers exported by scripts/fetch-corpus.mjs.
export const MANIFEST_PATH: string
export function corpusDir(): string
export function readManifest(): { description: string; boards: { id: string; [key: string]: unknown }[] }
export function corpusFile(entry: { id: string }): string

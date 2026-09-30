// Type declarations for scripts/check-known-bug-markers.mjs.
export interface BugMarker {
  issue: number
  line: number
  kind: string
  text: string
}
export interface FileBugMarker extends BugMarker {
  file: string
}
export const SCAN_DIRS: string[]
export function findMarkers(text: string): BugMarker[]
export function scanMarkers(root?: string, dirs?: string[]): FileBugMarker[]
export function findStale(
  markers: FileBugMarker[],
  getState: (issue: number) => Promise<'OPEN' | 'CLOSED' | null>
): Promise<{ stale: FileBugMarker[]; unknown: number[]; states: Map<number, 'OPEN' | 'CLOSED' | null> }>
export function makeGitHubResolver(env?: NodeJS.ProcessEnv): (issue: number) => Promise<'OPEN' | 'CLOSED' | null>
export function main(env?: NodeJS.ProcessEnv): Promise<number>

export const RELEASE_EXTENSIONS: string[]

export interface Sha256Entry {
  name: string
  sha256: string
}

export function buildSha256Sums(dir: string): { text: string; entries: Sha256Entry[] }

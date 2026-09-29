export type NgspiceKind = 'dll' | 'source'

export interface NgspicePin {
  archive: string
  sha256: string
}

export function loadPin(version: string, kind: NgspiceKind, pinsPath?: string): NgspicePin
export function candidateUrls(version: string, kind: NgspiceKind): string[]
export function downloadVerified(opts: {
  urls: string[]
  destFile: string
  sha256: string
  minSize?: number
}): Promise<{ url: string; sha256: string }>
export function sha256File(filePath: string): string

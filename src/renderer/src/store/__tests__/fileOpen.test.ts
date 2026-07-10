/**
 * fileOpen.test.ts — Task 21
 *
 * Pure path-handling + open-flow glue tests (no Electron). Uses an injected
 * readFile mock to verify sibling .kicad_sch auto-detection by basename.
 */

import { describe, it, expect } from 'vitest'
import {
  splitPath,
  siblingSchematicPath,
  joinPath,
  classifyFile,
  openProjectFromPath,
} from '../../ipc/fileOpen'

describe('fileOpen — path helpers', () => {
  it('splitPath handles POSIX and Windows paths', () => {
    expect(splitPath('/home/u/board.kicad_pcb')).toEqual({
      dir: '/home/u',
      base: 'board.kicad_pcb',
      name: 'board',
      ext: '.kicad_pcb',
    })
    expect(splitPath('C:\\Users\\bear\\fixture-555.kicad_pcb')).toEqual({
      dir: 'C:\\Users\\bear',
      base: 'fixture-555.kicad_pcb',
      name: 'fixture-555',
      ext: '.kicad_pcb',
    })
  })

  it('siblingSchematicPath swaps the extension keeping the dir + separator', () => {
    expect(siblingSchematicPath('/a/b/proj.kicad_pcb')).toBe('/a/b/proj.kicad_sch')
    expect(siblingSchematicPath('C:\\x\\proj.kicad_pcb')).toBe('C:\\x\\proj.kicad_sch')
  })

  it('joinPath uses the dir separator', () => {
    expect(joinPath('/a/b', 'c.txt')).toBe('/a/b/c.txt')
    expect(joinPath('C:\\a\\b', 'c.txt')).toBe('C:\\a\\b\\c.txt')
  })

  it('classifyFile recognizes extensions', () => {
    expect(classifyFile('/x/a.kicad_pcb')).toBe('board')
    expect(classifyFile('/x/a.kicad_sch')).toBe('schematic')
    expect(classifyFile('/x/bom.csv')).toBe('bom')
    expect(classifyFile('/x/readme.md')).toBe('unknown')
  })
})

describe('fileOpen — openProjectFromPath', () => {
  it('reads board + sibling schematic when present', async () => {
    const files: Record<string, string> = {
      '/p/proj.kicad_pcb': '(kicad_pcb board)',
      '/p/proj.kicad_sch': '(kicad_sch sch)',
    }
    const readFile = async (path: string): Promise<string> => {
      if (path in files) return files[path]
      throw new Error('ENOENT')
    }
    const opened = await openProjectFromPath('/p/proj.kicad_pcb', readFile)
    expect(opened.boardFileName).toBe('proj.kicad_pcb')
    expect(opened.boardText).toBe('(kicad_pcb board)')
    expect(opened.schematicFileName).toBe('proj.kicad_sch')
    expect(opened.schematicText).toBe('(kicad_sch sch)')
  })

  it('tolerates a missing sibling schematic', async () => {
    const readFile = async (path: string): Promise<string> => {
      if (path === '/p/proj.kicad_pcb') return '(kicad_pcb board)'
      throw new Error('ENOENT')
    }
    const opened = await openProjectFromPath('/p/proj.kicad_pcb', readFile)
    expect(opened.boardText).toBe('(kicad_pcb board)')
    expect(opened.schematicText).toBeUndefined()
  })

  it('reads an optional BOM when a path is supplied', async () => {
    const readFile = async (path: string): Promise<string> => {
      if (path === '/p/proj.kicad_pcb') return '(board)'
      if (path === '/p/bom.csv') return 'Ref,Value\nR1,10k'
      throw new Error('ENOENT')
    }
    const opened = await openProjectFromPath('/p/proj.kicad_pcb', readFile, '/p/bom.csv')
    expect(opened.bomText).toContain('R1')
  })
})

// ─── F3: probe optional sidecars via fileExists — never readFile a missing one ─

describe('fileOpen — fileExists probing (F3, no ENOENT stack on board open)', () => {
  /** readFile stub that records every path it was asked for. */
  function trackingReadFile(files: Record<string, string>): {
    readFile: (path: string) => Promise<string>
    reads: string[]
  } {
    const reads: string[] = []
    return {
      reads,
      readFile: async (path: string): Promise<string> => {
        reads.push(path)
        if (path in files) return files[path]
        throw new Error(`ENOENT: ${path}`)
      },
    }
  }

  it('missing sibling schematic: readFile is NEVER called for it', async () => {
    const { readFile, reads } = trackingReadFile({ '/p/proj.kicad_pcb': '(board)' })
    const fileExists = async (path: string): Promise<boolean> => path === '/p/proj.kicad_pcb'

    const opened = await openProjectFromPath('/p/proj.kicad_pcb', readFile, undefined, fileExists)
    expect(opened.boardText).toBe('(board)')
    expect(opened.schematicText).toBeUndefined()
    // The whole point of F3: no probe-by-read on the optional sidecar.
    expect(reads).toEqual(['/p/proj.kicad_pcb'])
  })

  it('existing sibling schematic is still read and attached', async () => {
    const { readFile } = trackingReadFile({
      '/p/proj.kicad_pcb': '(board)',
      '/p/proj.kicad_sch': '(sch)',
    })
    const fileExists = async (): Promise<boolean> => true

    const opened = await openProjectFromPath('/p/proj.kicad_pcb', readFile, undefined, fileExists)
    expect(opened.schematicText).toBe('(sch)')
    expect(opened.schematicFileName).toBe('proj.kicad_sch')
  })

  it('missing optional BOM: readFile is never called for it either', async () => {
    const { readFile, reads } = trackingReadFile({ '/p/proj.kicad_pcb': '(board)' })
    const fileExists = async (path: string): Promise<boolean> => path === '/p/proj.kicad_pcb'

    const opened = await openProjectFromPath('/p/proj.kicad_pcb', readFile, '/p/bom.csv', fileExists)
    expect(opened.bomText).toBeUndefined()
    expect(reads).toEqual(['/p/proj.kicad_pcb'])
  })

  it('a missing REQUIRED board file still errors loudly, even with fileExists injected', async () => {
    const { readFile } = trackingReadFile({})
    const fileExists = async (): Promise<boolean> => false
    await expect(
      openProjectFromPath('/p/missing.kicad_pcb', readFile, undefined, fileExists),
    ).rejects.toThrow(/ENOENT/)
  })

  it('a throwing fileExists probe falls back to the read attempt (never hides a file)', async () => {
    const { readFile } = trackingReadFile({
      '/p/proj.kicad_pcb': '(board)',
      '/p/proj.kicad_sch': '(sch)',
    })
    const fileExists = async (): Promise<boolean> => {
      throw new Error('stat unavailable')
    }
    const opened = await openProjectFromPath('/p/proj.kicad_pcb', readFile, undefined, fileExists)
    expect(opened.schematicText).toBe('(sch)')
  })

  it('legacy callers without fileExists keep the probe-by-read behavior', async () => {
    const { readFile, reads } = trackingReadFile({ '/p/proj.kicad_pcb': '(board)' })
    const opened = await openProjectFromPath('/p/proj.kicad_pcb', readFile)
    expect(opened.schematicText).toBeUndefined()
    expect(reads).toContain('/p/proj.kicad_sch')
  })
})

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

/**
 * Issue #37: the readFile / fileExists IPC reads only what the user pointed at.
 * Run against both Windows and POSIX path flavors so the rule holds on every CI leg.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { ReadGrants, sanitizeOpenDialogOptions } from '../readPolicy'

const FLAVORS = [
  { name: 'win32', api: path.win32, board: 'C:\\work\\proj\\board.kicad_pcb', dir: 'C:\\work\\proj', fold: true },
  { name: 'posix', api: path.posix, board: '/home/me/proj/board.kicad_pcb', dir: '/home/me/proj', fold: false },
] as const

describe.each(FLAVORS)('ReadGrants ($name)', ({ api, board, dir, fold }) => {
  const make = (): ReadGrants => new ReadGrants(api, fold)
  const j = (...p: string[]): string => api.join(dir, ...p)

  it('refuses everything before anything is granted', () => {
    const g = make()
    expect(g.canRead(board)).toBe(false)
    expect(() => g.assertReadable(board)).toThrow(/not opened in this session/)
  })

  it('reads a granted file and the board-adjacent files beside it', () => {
    const g = make()
    expect(g.grantFile(board)).toBe(true)
    expect(g.canRead(board)).toBe(true)
    expect(g.canRead(j('board.kicad_sch'))).toBe(true)
    expect(g.canRead(j('bom.csv'))).toBe(true)
    expect(g.canRead(j('models.LIB'))).toBe(true)
  })

  it('does not read other file types in the same directory', () => {
    const g = make()
    g.grantFile(board)
    expect(g.canRead(j('id_rsa'))).toBe(false)
    expect(g.canRead(j('notes.txt'))).toBe(false)
    expect(g.canRead(j('board.kicad_pcb.circsim.json'))).toBe(false)
  })

  it('does not read other directories or subdirectories', () => {
    const g = make()
    g.grantFile(board)
    expect(g.canRead(api.join(api.dirname(dir), 'other.kicad_pcb'))).toBe(false)
    expect(g.canRead(j('sub', 'deep.kicad_sch'))).toBe(false)
  })

  it('is not fooled by dot-dot segments', () => {
    const g = make()
    g.grantFile(board)
    const escape = api.join(dir, '..', '..', 'secret.csv')
    expect(g.canRead(escape)).toBe(false)
    // A traversal that lands back inside the directory is the same file.
    expect(g.canRead(`${dir}${api.sep}sub${api.sep}..${api.sep}board.kicad_sch`)).toBe(true)
  })

  it('rejects relative paths, NUL bytes, non-strings and oversized paths', () => {
    const g = make()
    g.grantFile(board)
    expect(g.canRead('board.kicad_sch')).toBe(false)
    expect(g.canRead(`${board}\0.txt`)).toBe(false)
    expect(g.canRead(undefined)).toBe(false)
    expect(g.canRead(42)).toBe(false)
    expect(g.canRead(j('a'.repeat(5000) + '.csv'))).toBe(false)
    expect(g.grantFile('relative/board.kicad_pcb')).toBe(false)
    expect(g.grantFile(null)).toBe(false)
  })

  it('grants an arbitrary extension only for the exact file the user chose', () => {
    const g = make()
    const lib = j('parts.mod')
    g.grantFile(lib)
    expect(g.canRead(lib)).toBe(true)
    expect(g.canRead(j('other.mod'))).toBe(false)
  })
})

describe('ReadGrants case folding', () => {
  it('matches case-insensitively where the filesystem does', () => {
    const g = new ReadGrants(path.win32, true)
    g.grantFile('C:\\Work\\Proj\\Board.kicad_pcb')
    expect(g.canRead('c:\\work\\proj\\board.KICAD_SCH')).toBe(true)
  })

  it('stays case-sensitive elsewhere', () => {
    const g = new ReadGrants(path.posix, false)
    g.grantFile('/home/me/Proj/board.kicad_pcb')
    expect(g.canRead('/home/me/proj/board.kicad_sch')).toBe(false)
  })
})

describe('sanitizeOpenDialogOptions', () => {
  it('always yields a file picker', () => {
    const out = sanitizeOpenDialogOptions({ properties: ['openDirectory', 'createDirectory'], defaultPath: '/etc' })
    expect(out.properties).toEqual(['openFile'])
    expect(out).not.toHaveProperty('defaultPath')
  })

  it('keeps title, well-formed filters and multi-select', () => {
    const out = sanitizeOpenDialogOptions({
      title: 'Open KiCad board',
      filters: [{ name: 'KiCad PCB', extensions: ['kicad_pcb'] }, { name: 3 }, null],
      properties: ['openFile', 'multiSelections'],
    })
    expect(out.title).toBe('Open KiCad board')
    expect(out.filters).toEqual([{ name: 'KiCad PCB', extensions: ['kicad_pcb'] }])
    expect(out.properties).toEqual(['openFile', 'multiSelections'])
  })

  it('tolerates junk input', () => {
    expect(sanitizeOpenDialogOptions(undefined).properties).toEqual(['openFile'])
    expect(sanitizeOpenDialogOptions('x').properties).toEqual(['openFile'])
  })
})

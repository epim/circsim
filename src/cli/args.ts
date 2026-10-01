/**
 * src/cli/args.ts
 *
 * Argument parsing for the headless CLI (issue #28). Hand-rolled: the surface is
 * three commands and a dozen flags, and a dependency is not worth it.
 */

export type Command = 'audit' | 'deck' | 'op'

export interface SupplySpec {
  /** Net name as written on the command line. */
  net: string
  volts: number
}

export interface CliOptions {
  command: Command
  /** Path to the .kicad_pcb, as given. */
  board: string
  /** `--schematic`: attach the schematic. `path` is set for an explicit file, else the board's sibling. */
  schematic: { path?: string } | null
  json: boolean
  /** `--ground NET`: override the ground heuristic. */
  ground?: string
  /** `--supply NET=VOLTS`, repeatable. Empty means the GUI's default (5 V on the top suggested rail). */
  supplies: SupplySpec[]
  /** `audit --no-op`: run only the static checks, no simulation. */
  noOp: boolean
  /** `deck --out DIR`. */
  outDir?: string
  /** `deck --pass1-only`: build the family-default deck without running ngspice. */
  pass1Only: boolean
  /** `--ngspice-dir DIR` (overrides CIRCSIM_NGSPICE_DIR). */
  ngspiceDir?: string
  /** `--models-dir DIR` (overrides CIRCSIM_MODELS_DIR). */
  modelsDir?: string
  /** Echo ngspice log lines to stderr. */
  verbose: boolean
}

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; options: CliOptions }

const COMMANDS: readonly Command[] = ['audit', 'deck', 'op']

/** Flags that take a value, by the command that accepts them (`*` = all commands). */
const VALUE_FLAGS: Record<string, Command[] | '*'> = {
  '--ground': '*',
  '--supply': '*',
  '--ngspice-dir': '*',
  '--models-dir': '*',
  '--out': ['deck'],
}

const BOOL_FLAGS: Record<string, Command[] | '*'> = {
  '--json': ['audit', 'op', 'deck'],
  '--verbose': '*',
  '--no-op': ['audit'],
  '--pass1-only': ['deck'],
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { kind: 'error', message: 'missing command (audit, deck, op); try --help' }
  const first = argv[0]
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' }
  if (first === '--version' || first === '-v') return { kind: 'version' }
  if (!(COMMANDS as readonly string[]).includes(first)) {
    return { kind: 'error', message: `unknown command "${first}" (expected audit, deck or op)` }
  }
  const command = first as Command

  const opts: CliOptions = {
    command,
    board: '',
    schematic: null,
    json: false,
    supplies: [],
    noOp: false,
    pass1Only: false,
    verbose: false,
  }
  const positionals: string[] = []

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }

    const eq = arg.indexOf('=')
    const flag = eq >= 0 ? arg.slice(0, eq) : arg
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined

    if (flag === '--schematic') {
      // Optional value: `--schematic` alone means the sibling file; `--schematic=PATH`
      // or `--schematic PATH.kicad_sch` names one.
      if (inlineValue !== undefined) {
        if (inlineValue === '') return { kind: 'error', message: '--schematic= needs a path' }
        opts.schematic = { path: inlineValue }
      } else if (i + 1 < argv.length && argv[i + 1].toLowerCase().endsWith('.kicad_sch')) {
        opts.schematic = { path: argv[++i] }
      } else {
        opts.schematic = {}
      }
      continue
    }

    if (flag in BOOL_FLAGS) {
      if (!allowed(BOOL_FLAGS[flag], command)) {
        return { kind: 'error', message: `${flag} does not apply to "${command}"` }
      }
      if (inlineValue !== undefined) return { kind: 'error', message: `${flag} does not take a value` }
      if (flag === '--json') opts.json = true
      else if (flag === '--verbose') opts.verbose = true
      else if (flag === '--no-op') opts.noOp = true
      else if (flag === '--pass1-only') opts.pass1Only = true
      continue
    }

    if (flag in VALUE_FLAGS) {
      if (!allowed(VALUE_FLAGS[flag], command)) {
        return { kind: 'error', message: `${flag} does not apply to "${command}"` }
      }
      let value = inlineValue
      if (value === undefined) {
        if (i + 1 >= argv.length) return { kind: 'error', message: `${flag} needs a value` }
        value = argv[++i]
      }
      if (value === '') return { kind: 'error', message: `${flag} needs a non-empty value` }
      if (flag === '--ground') opts.ground = value
      else if (flag === '--out') opts.outDir = value
      else if (flag === '--ngspice-dir') opts.ngspiceDir = value
      else if (flag === '--models-dir') opts.modelsDir = value
      else if (flag === '--supply') {
        const spec = parseSupply(value)
        if (typeof spec === 'string') return { kind: 'error', message: spec }
        opts.supplies.push(spec)
      }
      continue
    }

    return { kind: 'error', message: `unknown option "${flag}"` }
  }

  if (positionals.length === 0) return { kind: 'error', message: `"${command}" needs a board file (.kicad_pcb)` }
  if (positionals.length > 1) {
    return { kind: 'error', message: `"${command}" takes one board file; got ${positionals.length} arguments` }
  }
  opts.board = positionals[0]
  if (opts.noOp && opts.supplies.length > 0) {
    return { kind: 'error', message: '--supply has no effect with --no-op' }
  }
  return { kind: 'run', options: opts }
}

function allowed(list: Command[] | '*', command: Command): boolean {
  return list === '*' || list.includes(command)
}

/** Parse `NET=VOLTS`. The net name may contain `=` only before the last one. */
function parseSupply(text: string): SupplySpec | string {
  const at = text.lastIndexOf('=')
  if (at <= 0 || at === text.length - 1) return `--supply expects NET=VOLTS, got "${text}"`
  const net = text.slice(0, at)
  const volts = Number(text.slice(at + 1))
  if (!Number.isFinite(volts) || volts === 0) return `--supply voltage must be a nonzero number, got "${text.slice(at + 1)}"`
  return { net, volts }
}

export const HELP_TEXT = `circsim: headless validation bench for routed KiCad boards

Usage:
  circsim audit <board.kicad_pcb> [options]   Board Critic audit; exit 1 on error-severity findings
  circsim deck  <board.kicad_pcb> [options]   Write the pass-1 and pass-2 SPICE decks
  circsim op    <board.kicad_pcb> [options]   Solve the operating point; print net voltages

Options:
  --schematic[=PATH]     Read Sim.* fields and pin names from the sibling .kicad_sch (or PATH)
  --json                 Machine-readable output (audit, op, deck)
  --ground NET           Ground net (default: the GND/VSS/AGND name heuristic)
  --supply NET=VOLTS     Attach a DC supply; repeatable (default: 5 V on the top suggested rail)
  --no-op                audit: static checks only, no simulation
  --out DIR              deck: output directory (default: current directory)
  --pass1-only           deck: build the family-default deck without running ngspice
  --ngspice-dir DIR      Base dir holding <platform>/ngspice (env: CIRCSIM_NGSPICE_DIR)
  --models-dir DIR       Model library dir holding index.json (env: CIRCSIM_MODELS_DIR)
  --verbose              Echo ngspice log lines to stderr
  -h, --help             Show this help
  -v, --version          Show the version

Exit codes:
  0  success (audit: no error-severity findings)
  1  audit found error-severity findings
  2  usage error or unreadable/unparseable input
  3  simulation failed or could not run (audit: results are static-only)
`

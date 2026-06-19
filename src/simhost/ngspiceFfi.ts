/**
 * src/simhost/ngspiceFfi.ts
 *
 * The koffi / libngspice adapter — primary implementation of SpiceEngine
 * (Spec §7.1, §7.2, §7.4). Verified against ngspice 46 `sharedspice.h` and
 * probed live against resources/ngspice/win32-x64/ngspice.dll.
 *
 * Hard rules encoded here:
 *  - .cm bootstrap BEFORE init: generate a spinit with ABSOLUTE codemodel paths
 *    and set process.env.SPICE_SCRIPTS *before* loading the DLL (Spec §7.2).
 *    Relative spinit paths resolve against the Electron executable in packaged
 *    builds and silently fail.
 *  - Blocking commands (op/tran/run/loadCircuit) use koffi's .async() form so a
 *    sync FFI call never freezes the event loop / watchdog (Spec §7.4 gotcha 4).
 *  - Callbacks NEVER call back into ngspice; they only push EngineEvents onto a
 *    listener list which the orchestrator (index.ts) drains from JS-thread
 *    frames (Spec §7.4 gotcha 2).
 */

import koffi from 'koffi'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {
  EngineEvent,
  EngineEventListener,
  SpiceEngine
} from './engine'

// ─── platform / path resolution ──────────────────────────────────────────────

interface NgspicePaths {
  /** Absolute path to the shared library (ngspice.dll / libngspice.{dylib,so}). */
  libPath: string
  /** Absolute path to the directory holding the *.cm code-model files. */
  cmDir: string
  /** Ordered list of code-model basenames to load (without .cm). */
  codeModels: string[]
}

const CODE_MODELS = ['spice2poly', 'analog', 'digital', 'xtradev', 'xtraevt']

function platformLibName(): string {
  switch (process.platform) {
    case 'win32':
      return 'ngspice.dll'
    case 'darwin':
      return 'libngspice.dylib'
    default:
      return 'libngspice.so'
  }
}

function platformDirName(): string {
  switch (process.platform) {
    case 'win32':
      return 'win32-x64'
    case 'darwin':
      return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
    default:
      return 'linux-x64'
  }
}

/**
 * Locate the bundled ngspice resources. Honors two layouts:
 *  - DEV (and tests): <repoRoot>/resources/ngspice/<platform>/
 *  - PACKAGED: process.resourcesPath/ngspice/<platform>/  (documented branch;
 *    Electron sets process.resourcesPath only inside a packaged app).
 *
 * `overrideBaseDir` lets tests point at an explicit resources dir.
 */
export function resolveNgspicePaths(overrideBaseDir?: string): NgspicePaths {
  const platDir = platformDirName()
  const candidates: string[] = []

  if (overrideBaseDir) {
    candidates.push(path.join(overrideBaseDir, platDir))
  }

  // Packaged layout: resourcesPath is only meaningful in a packaged Electron app.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'ngspice', platDir))
  }

  // Dev / repo layout. This module compiles to out/simhost/index.js (packaged)
  // OR runs from src under vitest; walk up to find a "resources/ngspice" dir.
  candidates.push(path.join(repoRootFrom(__dirnameSafe()), 'resources', 'ngspice', platDir))

  for (const dir of candidates) {
    const libPath = path.join(dir, platformLibName())
    if (fs.existsSync(libPath)) {
      return {
        libPath,
        cmDir: path.join(dir, 'lib', 'ngspice'),
        codeModels: CODE_MODELS
      }
    }
  }

  // Fall through: return the best dev candidate so the error message is useful.
  const fallback = path.join(repoRootFrom(__dirnameSafe()), 'resources', 'ngspice', platDir)
  return {
    libPath: path.join(fallback, platformLibName()),
    cmDir: path.join(fallback, 'lib', 'ngspice'),
    codeModels: CODE_MODELS
  }
}

/** Returns true if a usable ngspice library exists for this platform. */
export function ngspiceResourcesAvailable(overrideBaseDir?: string): boolean {
  const { libPath, cmDir } = resolveNgspicePaths(overrideBaseDir)
  return fs.existsSync(libPath) && fs.existsSync(cmDir)
}

function __dirnameSafe(): string {
  // CJS bundle (out/simhost/index.js) and vitest both provide __dirname.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof __dirname !== 'undefined') return __dirname
  return process.cwd()
}

/** Walk up from a start dir until a package.json with name "circsim" is found. */
function repoRootFrom(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json')
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, 'utf8'))
        if (json?.name === 'circsim') return dir
      } catch {
        /* ignore parse errors, keep walking */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

/**
 * Generate a spinit with absolute `codemodel <abs>/<file>.cm` lines and point
 * SPICE_SCRIPTS at its directory. MUST be called before the DLL is loaded /
 * ngSpice_Init runs (Spec §7.2). Returns the spinit directory.
 */
export function bootstrapCodeModels(paths: NgspicePaths): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circsim-spinit-'))
  const cmDirPosix = paths.cmDir.split(path.sep).join('/')
  const lines = paths.codeModels.map((name) => `codemodel ${cmDirPosix}/${name}.cm`)
  fs.writeFileSync(path.join(dir, 'spinit'), lines.join('\n') + '\n', 'utf8')
  process.env.SPICE_SCRIPTS = dir
  return dir
}

// ─── koffi type/struct registration (module-level, once) ─────────────────────

// sharedspice.h `vector_info` — verified field layout via live probe.
//   typedef struct vector_info {
//     char        *v_name;
//     int          v_type;
//     short        v_flags;
//     double      *v_realdata;
//     ngcomplex_t *v_compdata;   // pointer; treated opaque (we only read real data)
//     int          v_length;
//   } vector_info, *pvector_info;
let typesRegistered = false
function registerTypes(): void {
  if (typesRegistered) return
  koffi.struct('vector_info', {
    v_name: 'char*',
    v_type: 'int',
    v_flags: 'short',
    v_realdata: 'double*',
    v_compdata: 'void*',
    v_length: 'int'
  })
  koffi.pointer('pvector_info', koffi.resolve('vector_info'))

  // sharedspice.h transient-streaming structs (verified field layout against
  // ngspice 46 via live FFI probe — see scripts/probe-senddata.mjs):
  //   typedef struct vecvalues {
  //     char* name; double creal; double cimag; bool is_scale; bool is_complex;
  //   } vecvalues, *pvecvalues;
  //   typedef struct vecvaluesall {
  //     int veccount; int vecindex; pvecvalues* vecsa;
  //   } vecvaluesall, *pvecvaluesall;
  koffi.struct('vecvalues', {
    name: 'char*',
    creal: 'double',
    cimag: 'double',
    is_scale: 'bool',
    is_complex: 'bool'
  })
  koffi.pointer('pvecvalues', koffi.resolve('vecvalues'))
  koffi.struct('vecvaluesall', {
    veccount: 'int',
    vecindex: 'int',
    vecsa: 'pvecvalues*'
  })
  koffi.pointer('pvecvaluesall', koffi.resolve('vecvaluesall'))

  //   typedef struct vecinfo {
  //     int number; char* vecname; bool is_real; void* pdvec; void* pdvecscale;
  //   } vecinfo, *pvecinfo;
  //   typedef struct vecinfoall {
  //     char* name; char* title; char* date; char* type; int veccount; pvecinfo* vecs;
  //   } vecinfoall, *pvecinfoall;
  koffi.struct('vecinfo', {
    number: 'int',
    vecname: 'char*',
    is_real: 'bool',
    pdvec: 'void*',
    pdvecscale: 'void*'
  })
  koffi.pointer('pvecinfo', koffi.resolve('vecinfo'))
  koffi.struct('vecinfoall', {
    name: 'char*',
    title: 'char*',
    date: 'char*',
    type: 'char*',
    veccount: 'int',
    vecs: 'pvecinfo*'
  })
  koffi.pointer('pvecinfoall', koffi.resolve('vecinfoall'))

  // Callback prototypes (sharedspice.h). SendData/SendInitData carry the structs
  // above; the FFI callbacks decode them into plain JS rows / name lists for the
  // orchestrator (Task 10 transient streaming).
  koffi.proto('int CsSendChar(char* output, int libId, void* user)')
  koffi.proto('int CsSendStat(char* status, int libId, void* user)')
  koffi.proto('int CsControlledExit(int exitStatus, bool immediate, bool quitOnExit, int libId, void* user)')
  koffi.proto('int CsSendData(pvecvaluesall data, int vecCount, int libId, void* user)')
  koffi.proto('int CsSendInitData(pvecinfoall data, int libId, void* user)')
  koffi.proto('int CsBGThreadRunning(bool notRunning, int libId, void* user)')
  typesRegistered = true
}

const POINTER_SIZE = koffi.sizeof('void*')

/**
 * Minimal shape of koffi.decode used by the SendData row decoder (injectable).
 * Loose by design: koffi.decode is heavily overloaded; the decoder below only ever
 * calls decode(ptr, offset, 'type') and decode(ptr, 'type'), so a permissive
 * callable lets both the real koffi.decode and a test fake satisfy it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DecodeFn = (ptr: any, offsetOrType: any, type?: any) => any

/**
 * Decode one `vecvaluesall` timepoint into a `{ name → value }` row, RESILIENT
 * PER ENTRY (Spec §7.4 transient streaming; silent-data-loss guard).
 *
 * Each vector entry is decoded inside its OWN try/catch. This matters because a
 * single exotic/unreadable entry (e.g. a device-internal current vector from
 * `.save @d1[i]`) can throw mid-decode. If one failure aborted the whole loop we
 * would discard the ENTIRE timepoint — node voltages and working currents
 * included — i.e. total, silent data loss even though ngspice computed the row
 * correctly. Instead, a failing entry is simply skipped (its key absent → the
 * downstream SampleBatcher maps it to NaN by name lookup, preserving column
 * order), and the remaining vectors still stream. The happy path (no throws) is
 * unchanged: every entry's `name → creal` lands in the row exactly as before.
 *
 * Extracted as a pure function (decoder injected) so the per-entry resilience is
 * unit-testable without a live libngspice — see ngspiceFfi.senddata.test.ts.
 */
export function decodeVecvaluesallRow(
  veccount: number,
  vecsa: unknown,
  decode: DecodeFn
): { row: Record<string, number>; scaleName: string } {
  const row: Record<string, number> = {}
  let scaleName = 'time'
  for (let i = 0; i < veccount; i++) {
    try {
      const vvPtr = decode(vecsa, i * POINTER_SIZE, 'pvecvalues')
      if (!vvPtr) continue
      const vv = decode(vvPtr, 'vecvalues') as {
        name: string
        creal: number
        is_scale: boolean
      }
      const name = String(vv.name)
      row[name] = vv.creal
      if (vv.is_scale) scaleName = name
    } catch {
      /* one bad vector entry must not drop the whole timepoint row */
    }
  }
  return { row, scaleName }
}

// ─── adapter implementation ──────────────────────────────────────────────────

export interface NgspiceFfiOptions {
  /** Override resources base dir (tests). Defaults to dev/packaged resolution. */
  resourcesBaseDir?: string
}

export class NgspiceFfiEngine implements SpiceEngine {
  private lib: koffi.IKoffiLib | null = null
  private listeners: EngineEventListener[] = []
  private initialized = false
  private _version = ''
  private readonly opts: NgspiceFfiOptions
  private paths: NgspicePaths | null = null

  // Bound FFI functions (populated in init()).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private fn: Record<string, any> = {}

  // Keep registered callbacks alive for the life of the engine (GC anchors).
  private registeredCallbacks: koffi.IKoffiRegisteredCallback[] = []

  constructor(opts: NgspiceFfiOptions = {}) {
    this.opts = opts
  }

  get version(): string {
    return this._version
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  private emit(ev: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev)
      } catch {
        /* a listener throwing must not break the FFI callback frame */
      }
    }
  }

  init(): void {
    if (this.initialized) return

    const paths = resolveNgspicePaths(this.opts.resourcesBaseDir)
    this.paths = paths
    if (!fs.existsSync(paths.libPath)) {
      throw new Error(
        `ngspice library not found at ${paths.libPath}. Run "npm run fetch:ngspice" (or build-ngspice.sh).`
      )
    }

    // (1) .cm bootstrap MUST happen before the DLL is loaded (Spec §7.2). This
    // is the packaging-critical path: in a packaged Electron app, a runtime
    // spinit with ABSOLUTE codemodel paths + SPICE_SCRIPTS is what lets ngspice
    // find the .cm files. We ALSO issue explicit `codemodel` commands after init
    // (see loadCodeModels) because some runtimes (e.g. the vitest worker on
    // Windows) do not propagate process.env mutations to ngspice's native
    // getenv("SPICE_SCRIPTS") — the explicit commands make .cm loading
    // environment-independent.
    bootstrapCodeModels(paths)

    registerTypes()

    // (2) Load the library and bind functions.
    this.lib = koffi.load(paths.libPath)
    const lib = this.lib

    this.fn.ngSpice_Init = lib.func(
      'int ngSpice_Init(CsSendChar* a, CsSendStat* b, CsControlledExit* c, CsSendData* d, CsSendInitData* e, CsBGThreadRunning* f, void* user)'
    )
    this.fn.ngSpice_Command = lib.func('int ngSpice_Command(char* command)')
    this.fn.ngSpice_Circ = lib.func('int ngSpice_Circ(char** circarray)')
    this.fn.ngSpice_CurPlot = lib.func('char* ngSpice_CurPlot()')
    this.fn.ngSpice_AllVecs = lib.func('char** ngSpice_AllVecs(char* plotname)')
    this.fn.ngGet_Vec_Info = lib.func('pvector_info ngGet_Vec_Info(char* vecname)')
    this.fn.ngSpice_running = lib.func('bool ngSpice_running()')

    // (3) Register callbacks. They ONLY enqueue (via emit) — never call back into
    // ngspice (Spec §7.4 gotcha 2).
    const cbSendChar = koffi.register((output: string) => {
      this.emit({ type: 'char', text: String(output ?? '') })
      // Classify into a log event with a coarse level for the UI.
      const text = String(output ?? '')
      const level: 'info' | 'warn' | 'error' = /error/i.test(text)
        ? 'error'
        : /warning|warn/i.test(text)
          ? 'warn'
          : 'info'
      this.emit({ type: 'log', level, text })
      return 0
    }, koffi.pointer('CsSendChar'))

    const cbSendStat = koffi.register((status: string) => {
      this.emit({ type: 'stat', text: String(status ?? '') })
      return 0
    }, koffi.pointer('CsSendStat'))

    const cbControlledExit = koffi.register(
      (exitStatus: number, immediate: boolean, quitOnExit: boolean) => {
        this.emit({
          type: 'controlledExit',
          status: exitStatus,
          immediate: !!immediate,
          quitOnExit: !!quitOnExit
        })
        return exitStatus
      },
      koffi.pointer('CsControlledExit')
    )

    // SendData fires once per accepted timepoint with all saved vector values.
    // Decode the vecvaluesall struct into a plain row and emit a 'data' event.
    // This runs on ngspice's background thread frame — keep it cheap and never
    // call back into ngspice (Spec §7.4 gotcha 2). The orchestrator's
    // sampleBatcher does the buffering/flush.
    const cbSendData = koffi.register((dataPtr: unknown) => {
      try {
        if (!dataPtr) return 0
        const all = koffi.decode(dataPtr, 'vecvaluesall') as {
          veccount: number
          vecsa: unknown
        }
        const { row, scaleName } = decodeVecvaluesallRow(all.veccount, all.vecsa, koffi.decode)
        this.emit({ type: 'data', row, scaleName })
      } catch {
        /* a decode hiccup must not crash the FFI callback frame */
      }
      return 0
    }, koffi.pointer('CsSendData'))

    // SendInitData fires once when a run starts, carrying the vector list.
    const cbSendInitData = koffi.register((infoPtr: unknown) => {
      try {
        if (!infoPtr) return 0
        const all = koffi.decode(infoPtr, 'vecinfoall') as {
          name: string
          type: string
          veccount: number
          vecs: unknown
        }
        const names: string[] = []
        const n = all.veccount
        for (let i = 0; i < n; i++) {
          const viPtr = koffi.decode(all.vecs, i * POINTER_SIZE, 'pvecinfo')
          if (!viPtr) continue
          const vi = koffi.decode(viPtr, 'vecinfo') as { vecname: string }
          names.push(String(vi.vecname))
        }
        this.emit({
          type: 'initData',
          plot: String(all.name ?? ''),
          analysisType: String(all.type ?? ''),
          names
        })
      } catch {
        /* ignore decode errors in the FFI callback frame */
      }
      return 0
    }, koffi.pointer('CsSendInitData'))
    const cbBGRunning = koffi.register((notRunning: boolean) => {
      this.emit({ type: 'bgRunning', running: !notRunning })
      return 0
    }, koffi.pointer('CsBGThreadRunning'))

    this.registeredCallbacks.push(
      cbSendChar,
      cbSendStat,
      cbControlledExit,
      cbSendData,
      cbSendInitData,
      cbBGRunning
    )

    const rc: number = this.fn.ngSpice_Init(
      cbSendChar,
      cbSendStat,
      cbControlledExit,
      cbSendData,
      cbSendInitData,
      cbBGRunning,
      null
    )
    if (rc !== 0) {
      throw new Error(`ngSpice_Init returned non-zero status ${rc}`)
    }

    this._version = '46' // ngspice version pinned in package.json config.circsim.ngspiceVersion
    this.initialized = true

    // (4) Explicitly load the XSPICE code models. Belt-and-suspenders alongside
    // the spinit/SPICE_SCRIPTS bootstrap — guarantees adc_bridge/dac_bridge/
    // d_* are available regardless of whether ngspice's getenv saw SPICE_SCRIPTS.
    this.loadCodeModels()
  }

  /**
   * Issue `codemodel <abs>.cm` for each bundled model via ngSpice_Command. Safe
   * to call after init (no-op if already loaded). Absolute, forward-slash paths.
   */
  private loadCodeModels(): void {
    if (!this.paths) return
    const cmDirPosix = this.paths.cmDir.split(path.sep).join('/')
    for (const name of this.paths.codeModels) {
      const cmPath = `${cmDirPosix}/${name}.cm`
      if (!fs.existsSync(path.join(this.paths.cmDir, `${name}.cm`))) continue
      this.fn.ngSpice_Command(`codemodel ${cmPath}`)
    }
  }

  loadCircuit(deckLines: string[]): void {
    this.ensureInit()
    // ngSpice_Circ wants a NULL-terminated char** array.
    const arr = [...deckLines, null]
    const rc: number = this.fn.ngSpice_Circ(arr)
    if (rc !== 0) {
      this.emit({ type: 'log', level: 'error', text: `ngSpice_Circ returned ${rc}` })
    }
  }

  command(cmd: string, blocking: boolean): Promise<void> {
    this.ensureInit()
    if (!blocking) {
      // bg_* and other non-blocking commands return immediately; sync is fine.
      this.fn.ngSpice_Command(cmd)
      return Promise.resolve()
    }
    // Blocking command (op/tran/run/...) → koffi async form so the JS event loop
    // and the watchdog timer keep running while ngspice computes (Spec §7.4 #4).
    return new Promise<void>((resolve, reject) => {
      this.fn.ngSpice_Command.async(cmd, (err: unknown) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
        else resolve()
      })
    })
  }

  currentPlot(): string {
    this.ensureInit()
    return String(this.fn.ngSpice_CurPlot() ?? '')
  }

  allVectors(plot: string): string[] {
    this.ensureInit()
    const vecs = this.fn.ngSpice_AllVecs(plot)
    if (!vecs) return []
    const names: string[] = []
    // null-terminated char** — read each slot at byte offset i*sizeof(ptr).
    for (let i = 0; i < 4096; i++) {
      const slot = koffi.decode(vecs, i * POINTER_SIZE, 'char*')
      if (slot === null || slot === undefined) break
      names.push(String(slot))
    }
    return names
  }

  vectorData(name: string): Float64Array | undefined {
    this.ensureInit()
    const ptr = this.fn.ngGet_Vec_Info(name)
    if (!ptr) return undefined
    const vi = koffi.decode(ptr, 'vector_info') as {
      v_realdata: unknown
      v_length: number
    }
    if (!vi.v_realdata || vi.v_length <= 0) return undefined
    const arr = koffi.decode(vi.v_realdata, koffi.array('double', vi.v_length)) as number[]
    return Float64Array.from(arr)
  }

  isRunning(): boolean {
    this.ensureInit()
    return !!this.fn.ngSpice_running()
  }

  dispose(): void {
    for (const cb of this.registeredCallbacks) {
      try {
        koffi.unregister(cb)
      } catch {
        /* best effort */
      }
    }
    this.registeredCallbacks = []
    // koffi has no explicit unload requirement; drop references.
    this.lib = null
    this.initialized = false
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('NgspiceFfiEngine.init() must be called before use')
    }
  }
}

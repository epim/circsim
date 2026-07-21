/**
 * viewport/scene.ts
 *
 * Task 16 — Imperative scene manager.
 * Task 19 — Wired picking controller.
 *
 * THIS IS THE ONLY FILE that owns live THREE.Scene / WebGLRenderer /
 * OrbitControls objects. It is intentionally React-free: it communicates
 * outward via callbacks, not React props or hooks.
 *
 * Features:
 *   - Scene setup: ambient + directional lights
 *   - OrbitControls (rotate / pan / zoom)
 *   - Ortho top-down toggle
 *   - Flip-to-back shortcut (rotates 180° around Y)
 *   - On-demand / dirty render loop (render only when dirty — battery matters)
 *   - Picking: hover / click via PickingController (Task 19)
 *
 * Spec §10.2, §10.3
 *
 * NOTE: scene.ts is validated by the build, not headless unit tests.
 *       OrbitControls/render loop require a DOM canvas.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { BoardModel } from '../../../core/kicad/types'
import { buildSubstrate, kicadToWorld } from './boardGeometry'
import { buildCopper, buildViaInstances, makeCopperMaterial } from './copperGeometry'
import { buildComponentBoxes } from './componentGeometry'
import { buildSilkscreenEntries, createSilkscreenTexts } from './silkscreen'
import { createPicker, type PickCallback } from './picking'
import { createOverlayController, type OverlayController, type OverlayMode, type LegendData } from './overlay'
import { createMarkerController, type MarkerController, type AnnotationLabel, type ProbeMarker, type ProbeMarkerOpts } from './markers'
import { createLedGlowController, isLed, ledColorFor, ledIntensity, type LedGlowController } from './ledGlow'
import { createCriticOverlayController, MARKER_Z_LIFT, type CriticOverlayController } from './criticOverlay'
import type { Finding } from '../../../core/critic/types'
import { projectAnchorSet, type Pt } from '../bench/leadGeometry'

// ─── E2E LED-glow hook (First Light, L5) ─────────────────────────────────────────

/**
 * Shape published on `window.__circsimLedGlow` after every LED-current update so
 * an E2E (Playwright) can assert an LED is lit — and DIMMED when the supply
 * voltage drops. `byRef` maps part ref → glow intensity (0..1, the same
 * perceptual curve the glow controller drives the emissive channel with); `max`
 * is the brightest LED's intensity (0 when all are dark).
 */
export interface LedGlowSnapshot {
  byRef: Record<string, number>
  max: number
}

/**
 * Compute per-ref glow intensities + the max, then publish them on
 * `window.__circsimLedGlow` (and mirror `max` onto a `data-led-glow-max`
 * attribute on <html> so a test can read either). Best-effort + side-effect-only:
 * a no-op when there is no `window`/`document` (headless unit tests).
 */
function publishLedGlow(currentsByRef: Map<string, number>): void {
  if (typeof window === 'undefined') return
  const byRef: Record<string, number> = {}
  let max = 0
  for (const [ref, current] of currentsByRef) {
    const intensity = ledIntensity(current)
    byRef[ref] = intensity
    if (intensity > max) max = intensity
  }
  const snapshot: LedGlowSnapshot = { byRef, max }
  ;(window as unknown as { __circsimLedGlow?: LedGlowSnapshot }).__circsimLedGlow = snapshot
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-led-glow-max', max.toFixed(4))
  }
}

// ─── types ────────────────────────────────────────────────────────────────────

export interface SceneCallbacks {
  /** Called whenever a render frame completes (useful for FPS counters etc.) */
  onRender?: () => void
  /**
   * Called when a pick event fires (hover/click on copper or component).
   * The store subscribes to this; scene.ts stays React-free.
   */
  onPickEvent?: PickCallback
}

export interface SceneManager {
  /** Mount the scene into a canvas element. Must be called before anything else. */
  mount(canvas: HTMLCanvasElement, callbacks?: SceneCallbacks): void
  /** Unmount / dispose all resources. */
  dispose(): void
  /** Notify the scene that the canvas size changed — call on ResizeObserver. */
  resize(width: number, height: number): void
  /** Load a board and display the substrate. */
  loadBoard(board: BoardModel): void
  /** Toggle between perspective and orthographic (top-down) camera. */
  toggleOrthoTop(): void
  /** Flip the view to show the B-side (rotate 180° around Y). */
  flipToBack(): void
  /** Mark the scene as dirty so the next animation frame re-renders. */
  invalidate(): void
  /** Programmatically clear hover state (e.g. before board reload or on mouse leave). */
  clearHover(): void

  // ── Task 20: Overlay modes ─────────────────────────────────────────────────

  /**
   * Switch the copper overlay mode.
   * 'realistic'  — standard copper color
   * 'voltage'    — per-net color lerp blue→red
   * 'highlight'  — picking highlight only (realistic colors)
   */
  setOverlay(mode: OverlayMode): void

  /** Current overlay mode. */
  getOverlayMode(): OverlayMode

  /**
   * Apply per-net voltage tinting (only has visual effect in 'voltage' mode).
   * Call after a runOp result or live transient samples.
   */
  applyNetVoltages(voltages: Map<number, number>, minVolts: number, maxVolts: number): void

  /**
   * Return legend data for UI display, or null when not in voltage mode.
   */
  getVoltageLegend(): LegendData | null

  // ── Task 20: Probe markers ─────────────────────────────────────────────────

  /** Add a probe flag / instrument badge sprite. Returns the marker id. */
  addProbeMarker(opts: ProbeMarkerOpts): string

  /** Remove a probe marker by id. */
  removeProbeMarker(id: string): void

  /** Remove all probe markers. */
  clearProbeMarkers(): void

  /** Return all registered probe markers. */
  getProbeMarkers(): ProbeMarker[]

  /**
   * Display net voltage labels from an op result.
   * Declutters automatically: labels < 24 px apart at current zoom are hidden.
   *
   * @param voltages      Map<netId, volts> from opResult.values
   * @param netPositions  Map<netId, worldPos> — scene.ts computes this from copper geometry
   */
  showOpAnnotations(voltages: Map<number, number>, netPositions?: Map<number, THREE.Vector3>): void

  /** Remove all op annotation labels. */
  clearOpAnnotations(): void

  /** Return visible annotation labels after declutter (for UI rendering). */
  getVisibleAnnotations(): AnnotationLabel[]

  // ── Task 22: Drop-target hit-test ─────────────────────────────────────────

  /**
   * Return the netId of the copper mesh under the given canvas pixel position,
   * or null if nothing is hit. Nets-only convenience; the bench lead drop path
   * uses pickAttachTargetAt (nets AND component boxes) instead. Currently
   * unreferenced — retained as a public nets-only helper.
   *
   * @param xPx     X position in canvas CSS pixels (from left)
   * @param yPx     Y position in canvas CSS pixels (from top)
   * @param width   Canvas CSS width
   * @param height  Canvas CSS height
   */
  pickNetAt(xPx: number, yPx: number, width: number, height: number): number | null

  /**
   * Bench leads: generalized pixel-space hit-test. Scans ALL hits along the
   * ray (nearest → farthest) via the picker's raycastTargets — not just the
   * single nearest hit — so a net-accepting jack (e.g. a voltage probe) can
   * still find copper that is occluded by a nearer component placeholder box
   * (the common case: a pad sitting directly under its own component body).
   * Carries whichever of netId/ref were found — BOTH keys when both a net and
   * a component are along the ray; resolveDrop (bench/leads.ts) then picks
   * whichever key matches the dragged jack's `accepts`. Miss → null.
   * pickNetAt remains for callers that only accept nets.
   */
  pickAttachTargetAt(xPx: number, yPx: number, width: number, height: number):
    { netId?: number; ref?: string } | null

  /**
   * Bench leads: project net + component anchor world positions to canvas px
   * using the active camera. Unknown ids/refs are silently skipped.
   */
  projectAnchors(netIds: number[], refs: string[]):
    { nets: Map<number, Pt>; refs: Map<string, Pt> }

  /**
   * Bench leads: highlight the candidate attach target during a lead drag via
   * the picker's external-highlight path (same as critic focus). null clears.
   */
  highlightAttachTarget(target: { netId?: number; ref?: string } | null): void

  // ── LED operating-point glow ───────────────────────────────────────────────

  /**
   * Set an LED component's emissive glow. `intensity` is 0..1 (e.g. from
   * ledIntensity(current)); `color` is an optional THREE hex to retint. No-op for
   * a ref that isn't a registered LED. Additive over the voltage overlay.
   */
  updateComponentEmissive(ref: string, intensity: number, color?: number): void

  /**
   * Drive every LED's glow from op-point device currents (ref → amps). LEDs with
   * ~0 current (or absent from the map) stay dark.
   */
  applyLedCurrents(currentsByRef: Map<string, number>): void

  // ── Board Critic overlay (read-only) ────────────────────────────────────────

  /**
   * Place READ-ONLY critic markers at the located findings (one small sphere per
   * finding with a `location`, colored by severity). Replaces any prior markers;
   * pass [] (or call clearCriticFindings) to clear. The critic never edits the
   * board — this only adds markers on a dedicated overlay group.
   */
  setCriticFindings(findings: Finding[]): void

  /** Remove all critic markers (report changed / board closed). */
  clearCriticFindings(): void

  /**
   * Fly the camera + OrbitControls target to a finding's location and highlight
   * the involved net/part. Reuses the SAME emissive-highlight path the picker uses
   * for hover (per-net emissive boost) so the critic stays read-only and visually
   * consistent. No-op when the finding has no location AND no net/ref to highlight.
   */
  focusFinding(finding: Finding): void
}

// ─── FR4 material ─────────────────────────────────────────────────────────────

const FR4_COLOR = 0x1a6b2a  // dark green

// ─── implementation ───────────────────────────────────────────────────────────

/**
 * Create and return a SceneManager instance.
 * Call .mount(canvas) to initialize.
 */
export function createSceneManager(): SceneManager {
  // Internal state — only this closure touches these objects
  let renderer: THREE.WebGLRenderer | null = null
  let scene: THREE.Scene | null = null
  let perspCamera: THREE.PerspectiveCamera | null = null
  let orthoCamera: THREE.OrthographicCamera | null = null
  let controls: OrbitControls | null = null
  let animFrameId: number | null = null
  let dirty = true
  let useOrtho = false
  let isFlipped = false
  let callbacks: SceneCallbacks = {}

  // Scene objects (can be replaced on board reload)
  let substrateGroup: THREE.Group | null = null
  let copperGroup: THREE.Group | null = null
  let componentGroup: THREE.Group | null = null
  let silkscreenGroup: THREE.Group | null = null

  // ── Task 20: Overlay + markers ──────────────────────────────────────────────
  // Net materials map: netId → MeshStandardMaterial (built in loadBoard, reused here)
  let netMaterialsMap = new Map<number, THREE.MeshStandardMaterial>()
  let overlayController: OverlayController = createOverlayController(netMaterialsMap)
  const markerController: MarkerController = createMarkerController()

  // ── LED operating-point glow (additive over the voltage overlay) ─────────────
  // Rebuilt per board load (anchored to the component group). null before mount.
  let ledGlowController: LedGlowController | null = null

  // ── Board Critic overlay (read-only markers + camera fly-to) ──────────────────
  // One controller for the app lifetime; its group is re-centered per board load.
  const criticOverlay: CriticOverlayController = createCriticOverlayController()
  // Board-centering offset (−cx,−cy) + thickness captured in loadBoard, reused to
  // position the critic group and compute marker/camera world targets.
  let boardCenter = { x: 0, y: 0 }
  let boardThicknessMm = 0

  // Net positions for op annotations: netId → world position (centroid of copper)
  // Populated in loadBoard from pad positions.
  let netPositionsMap = new Map<number, THREE.Vector3>()

  // Component anchor positions for bench lead clamps: ref → world position
  // (box position + board-centering offset). Populated in loadBoard.
  let componentAnchorByRef = new Map<string, THREE.Vector3>()

  // ── Picking controller (Task 19) ────────────────────────────────────────────
  const picker = createPicker(
    event => callbacks.onPickEvent?.(event),
    () => { dirty = true }
  )

  // Pointer event handlers (attached in mount, removed in dispose)
  let _canvas: HTMLCanvasElement | null = null

  function _onPointerMove(e: PointerEvent): void {
    if (!_canvas) return
    const cam = getActiveCamera()
    const rect = _canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width)  * 2 - 1
    const y = ((e.clientY - rect.top)  / rect.height) * -2 + 1
    picker.onPointerMove({ x, y }, cam)
  }

  function _onClick(e: MouseEvent): void {
    if (!_canvas) return
    const cam = getActiveCamera()
    const rect = _canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width)  * 2 - 1
    const y = ((e.clientY - rect.top)  / rect.height) * -2 + 1
    picker.onClick({ x, y }, cam)
  }

  function _onPointerLeave(): void {
    picker.clearHover()
  }

  function getActiveCamera(): THREE.Camera {
    return useOrtho ? orthoCamera! : perspCamera!
  }

  function markDirty(): void {
    dirty = true
  }

  // ── camera fly-to tween (critic focusFinding) ────────────────────────────────
  // When active, each frame eases the active camera position + controls target
  // toward the goal. Self-clears once close enough. Kept light: lerp factor per
  // frame, no external tween lib.
  let camTween: { camGoal: THREE.Vector3; targetGoal: THREE.Vector3 } | null = null

  function stepCamTween(): void {
    if (!camTween || !controls) return
    const cam = getActiveCamera() as THREE.PerspectiveCamera | THREE.OrthographicCamera
    const EASE = 0.18
    cam.position.lerp(camTween.camGoal, EASE)
    controls.target.lerp(camTween.targetGoal, EASE)
    const posDone = cam.position.distanceToSquared(camTween.camGoal) < 1e-3
    const tgtDone = controls.target.distanceToSquared(camTween.targetGoal) < 1e-3
    if (posDone && tgtDone) {
      cam.position.copy(camTween.camGoal)
      controls.target.copy(camTween.targetGoal)
      camTween = null
    } else {
      dirty = true // keep animating
    }
  }

  function renderLoop(): void {
    animFrameId = requestAnimationFrame(renderLoop)
    if (camTween) stepCamTween()
    if (!dirty || !renderer || !scene) return
    dirty = false
    controls?.update()
    renderer.render(scene, getActiveCamera())
    callbacks.onRender?.()
  }

  function syncOrthoSize(width: number, height: number): void {
    if (!orthoCamera) return
    const aspect = width / height
    const frustumHalf = 60 // mm visible in the smallest dimension
    orthoCamera.left = -frustumHalf * aspect
    orthoCamera.right = frustumHalf * aspect
    orthoCamera.top = frustumHalf
    orthoCamera.bottom = -frustumHalf
    orthoCamera.updateProjectionMatrix()
  }

  return {
    mount(canvas: HTMLCanvasElement, cb: SceneCallbacks = {}): void {
      callbacks = cb
      _canvas = canvas

      // --- Renderer ---
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
      renderer.setPixelRatio(window.devicePixelRatio)
      renderer.setSize(canvas.clientWidth, canvas.clientHeight)
      renderer.outputColorSpace = THREE.SRGBColorSpace

      // --- Scene ---
      scene = new THREE.Scene()
      scene.background = new THREE.Color(0x1a1a2e)  // dark blue-grey

      // --- Lights ---
      const ambient = new THREE.AmbientLight(0xffffff, 0.6)
      scene.add(ambient)

      const sun = new THREE.DirectionalLight(0xffffff, 1.2)
      sun.position.set(50, 80, 60)
      scene.add(sun)

      // --- Cameras ---
      const aspect = canvas.clientWidth / canvas.clientHeight
      perspCamera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10000)
      perspCamera.position.set(0, -80, 80)
      perspCamera.lookAt(0, 0, 0)

      orthoCamera = new THREE.OrthographicCamera(-60, 60, 60, -60, 0.1, 10000)
      orthoCamera.position.set(0, 0, 200)
      orthoCamera.lookAt(0, 0, 0)
      syncOrthoSize(canvas.clientWidth, canvas.clientHeight)

      // --- OrbitControls ---
      controls = new OrbitControls(perspCamera, canvas)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.addEventListener('change', markDirty)

      // --- Picking event listeners ---
      canvas.addEventListener('pointermove', _onPointerMove)
      canvas.addEventListener('click', _onClick)
      canvas.addEventListener('pointerleave', _onPointerLeave)

      // --- Start render loop ---
      dirty = true
      renderLoop()
    },

    dispose(): void {
      if (animFrameId !== null) cancelAnimationFrame(animFrameId)
      animFrameId = null
      controls?.dispose()
      // Remove picking event listeners
      if (_canvas) {
        _canvas.removeEventListener('pointermove', _onPointerMove)
        _canvas.removeEventListener('click', _onClick)
        _canvas.removeEventListener('pointerleave', _onPointerLeave)
        _canvas = null
      }
      picker.clear()
      criticOverlay.dispose()
      camTween = null
      renderer?.dispose()
      renderer = null
      scene = null
      perspCamera = null
      orthoCamera = null
      controls = null
    },

    resize(width: number, height: number): void {
      if (!renderer || !perspCamera) return
      renderer.setSize(width, height)
      perspCamera.aspect = width / height
      perspCamera.updateProjectionMatrix()
      syncOrthoSize(width, height)
      dirty = true
    },

    loadBoard(board: BoardModel): void {
      if (!scene) return

      // Clear picking registrations before rebuilding geometry
      picker.clear()

      // Remove previous substrate
      if (substrateGroup) {
        scene.remove(substrateGroup)
        substrateGroup.traverse(obj => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose()
            if (obj.material instanceof THREE.Material) obj.material.dispose()
          }
        })
      }

      // Remove previous copper
      if (copperGroup) {
        scene.remove(copperGroup)
        copperGroup.traverse(obj => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
            obj.geometry.dispose()
            if (obj.material instanceof THREE.Material) obj.material.dispose()
          }
        })
      }

      // Remove previous components
      if (componentGroup) {
        scene.remove(componentGroup)
        componentGroup.traverse(obj => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose()
            if (obj.material instanceof THREE.Material) obj.material.dispose()
          }
        })
      }

      // Remove previous silkscreen
      if (silkscreenGroup) {
        scene.remove(silkscreenGroup)
      }

      substrateGroup = new THREE.Group()

      const substGeo = buildSubstrate(board.outline, board.boardThicknessMm)
      const substMat = new THREE.MeshStandardMaterial({
        color: FR4_COLOR,
        roughness: 0.8,
        metalness: 0.0,
      })
      const substMesh = new THREE.Mesh(substGeo, substMat)

      // Center the board around the origin
      substGeo.computeBoundingBox()
      const bb = substGeo.boundingBox!
      const cx = (bb.min.x + bb.max.x) / 2
      const cy = (bb.min.y + bb.max.y) / 2
      substMesh.position.set(-cx, -cy, 0)

      substrateGroup.add(substMesh)
      scene.add(substrateGroup)

      // ── Copper geometry ──
      copperGroup = new THREE.Group()
      // Copper sits on top of the substrate (Z = boardThickness)
      const copperZ = board.boardThicknessMm
      copperGroup.position.set(-cx, -cy, copperZ)

      // Rebuild net materials + overlay controller for the new board
      // (dispose old materials first to free GPU memory)
      for (const mat of netMaterialsMap.values()) mat.dispose()
      netMaterialsMap = new Map<number, THREE.MeshStandardMaterial>()
      overlayController = createOverlayController(netMaterialsMap)

      // Compute net positions (world-space position of first pad per net)
      // Used for op annotation label placement.
      netPositionsMap = new Map<number, THREE.Vector3>()
      for (const fp of board.footprints) {
        for (const pad of fp.pads) {
          if (pad.netId === undefined || pad.netId === 0) continue
          if (!netPositionsMap.has(pad.netId)) {
            const world = kicadToWorld(fp.at.x + pad.at.x, fp.at.y + pad.at.y)
            // Apply the same board-centering offset used for the copper group
            netPositionsMap.set(pad.netId, new THREE.Vector3(world.x - cx, world.y - cy, copperZ))
          }
        }
      }

      const copperMap = buildCopper(board)
      for (const [netId, entry] of copperMap) {
        // One shared material per net (both F and B sides share so tinting is consistent)
        const mat = makeCopperMaterial()
        netMaterialsMap.set(netId, mat)

        if (entry.F) {
          const mesh = new THREE.Mesh(entry.F, mat)
          copperGroup.add(mesh)
          picker.registerCopperMesh(mesh, netId)
        }
        if (entry.B) {
          // B-side copper is flipped below the board
          const mesh = new THREE.Mesh(entry.B, mat)
          mesh.position.z = -copperZ  // offset to the back face
          copperGroup.add(mesh)
          picker.registerCopperMesh(mesh, netId)
        }
      }

      // Vias
      if (board.vias.length > 0) {
        const viaResult = buildViaInstances(board)
        // Offset vias to board center
        viaResult.mesh.position.set(-cx, -cy, 0)
        scene.add(viaResult.mesh)
        picker.registerViaInstance(viaResult.mesh, viaResult.netIds)
      }

      scene.add(copperGroup)

      // ── Component placeholder boxes ──
      componentGroup = new THREE.Group()
      componentGroup.position.set(-cx, -cy, 0)

      // Fresh LED-glow controller for this board, anchored to the component group.
      ledGlowController?.dispose()
      ledGlowController = createLedGlowController(componentGroup)

      // ref → footprint, for LED classification / color capture.
      const fpByRef = new Map(board.footprints.map(fp => [fp.ref, fp]))

      componentAnchorByRef = new Map<string, THREE.Vector3>()

      const boxEntries = buildComponentBoxes(board.footprints, board.boardThicknessMm)
      for (const entry of boxEntries) {
        const mat = new THREE.MeshStandardMaterial({
          color: entry.color,
          roughness: 0.7,
          metalness: 0.1,
          transparent: true,
          opacity: 0.85,
        })
        const mesh = new THREE.Mesh(entry.geo, mat)
        mesh.position.set(entry.worldX, entry.worldY, entry.worldZ)
        mesh.userData = { ref: entry.ref, className: entry.className }
        componentGroup.add(mesh)
        picker.registerComponentBox(mesh, entry.ref)

        // World-space anchor for bench lead clamps: the box position plus the
        // group's board-centering offset (same convention as netPositionsMap).
        componentAnchorByRef.set(
          entry.ref,
          new THREE.Vector3(entry.worldX - cx, entry.worldY - cy, entry.worldZ),
        )

        // LEDs get an emissive channel + halo so they can light at their OP current.
        const fp = fpByRef.get(entry.ref)
        if (fp && isLed({ ref: fp.ref, value: fp.value, libId: fp.libId, properties: fp.properties })) {
          // Flag the mesh so the picker's external-highlight (critic focus) leaves
          // this LED-owned material alone — it shares its emissive with the glow.
          mesh.userData.isLed = true
          ledGlowController.registerLed(entry.ref, mesh, ledColorFor({
            ref: fp.ref, value: fp.value, libId: fp.libId, properties: fp.properties,
          }))
        }
      }
      scene.add(componentGroup)

      // ── Board Critic overlay group ──
      // Share the board-centering offset so finding markers (placed from
      // kicadToWorld) line up with the copper/components. Clear stale markers; the
      // CURRENT report's markers (already pushed via setCriticFindings BEFORE this
      // loadBoard ran — see openBoardFromText) are re-applied at the END of this
      // method so they survive the geometry rebuild.
      boardCenter = { x: cx, y: cy }
      boardThicknessMm = board.boardThicknessMm
      criticOverlay.clear()
      criticOverlay.group.position.set(-cx, -cy, 0)
      if (criticOverlay.group.parent !== scene) scene.add(criticOverlay.group)

      // ── Silkscreen (troika Text — async, non-blocking) ──
      const silkEntries = buildSilkscreenEntries(board.silkscreen, board.boardThicknessMm)
      if (silkEntries.length > 0) {
        // Create a new group synchronously; texts are added asynchronously.
        silkscreenGroup = new THREE.Group()
        silkscreenGroup.position.set(-cx, -cy, 0)
        scene.add(silkscreenGroup)

        createSilkscreenTexts(silkEntries).then(textObjs => {
          if (!silkscreenGroup || !scene) return
          for (const obj of textObjs) {
            silkscreenGroup.add(obj)
          }
          dirty = true
        }).catch(() => {
          // Silkscreen text loading is best-effort; log but don't crash
        })
      }

      // Fit perspective camera to board
      if (perspCamera) {
        const diagMm = Math.sqrt(
          (bb.max.x - bb.min.x) ** 2 + (bb.max.y - bb.min.y) ** 2
        )
        perspCamera.position.set(0, -diagMm * 0.7, diagMm * 0.9)
        perspCamera.lookAt(0, 0, board.boardThicknessMm / 2)
        controls?.target.set(0, 0, board.boardThicknessMm / 2)
        controls?.update()
      }

      // Re-apply the current report's critic markers AFTER the clear above, so the
      // findings the store pushed before loadBoard ran (board open) are not wiped
      // out and actually show on the board (HIGH fix).
      criticOverlay.reapplyLast(boardThicknessMm)

      dirty = true
    },

    toggleOrthoTop(): void {
      useOrtho = !useOrtho
      if (useOrtho && renderer) {
        const sz = renderer.getSize(new THREE.Vector2())
        syncOrthoSize(sz.x, sz.y)
      }
      // Keep controls targeting the same point
      if (controls) {
        const target = controls.target.clone()
        if (useOrtho && orthoCamera) {
          orthoCamera.position.set(target.x, target.y, 200)
          orthoCamera.lookAt(target)
        } else if (!useOrtho && perspCamera) {
          perspCamera.lookAt(target)
        }
      }
      dirty = true
    },

    flipToBack(): void {
      isFlipped = !isFlipped
      if (substrateGroup) {
        substrateGroup.rotation.y = isFlipped ? Math.PI : 0
      }
      dirty = true
    },

    invalidate(): void {
      dirty = true
    },

    clearHover(): void {
      picker.clearHover()
    },

    // ── Task 20: Overlay modes ─────────────────────────────────────────────────

    setOverlay(mode: OverlayMode): void {
      overlayController.setOverlay(mode)
      dirty = true
    },

    getOverlayMode(): OverlayMode {
      return overlayController.getMode()
    },

    applyNetVoltages(voltages: Map<number, number>, minVolts: number, maxVolts: number): void {
      overlayController.applyNetVoltages(voltages, minVolts, maxVolts)
      dirty = true
    },

    getVoltageLegend(): LegendData | null {
      return overlayController.getLegend()
    },

    // ── Task 20: Probe markers ─────────────────────────────────────────────────

    addProbeMarker(opts: ProbeMarkerOpts): string {
      return markerController.addProbeMarker(opts)
    },

    removeProbeMarker(id: string): void {
      markerController.removeProbeMarker(id)
    },

    clearProbeMarkers(): void {
      markerController.clearProbeMarkers()
    },

    getProbeMarkers(): ProbeMarker[] {
      return markerController.getProbeMarkers()
    },

    showOpAnnotations(
      voltages: Map<number, number>,
      netPositions?: Map<number, THREE.Vector3>
    ): void {
      // Use provided positions, or fall back to auto-computed pad positions
      const positions = netPositions ?? netPositionsMap
      markerController.showOpAnnotations(voltages, positions)
      dirty = true
    },

    clearOpAnnotations(): void {
      markerController.clearOpAnnotations()
    },

    getVisibleAnnotations(): AnnotationLabel[] {
      const cam = getActiveCamera()
      // If renderer is available, use its pixel size; otherwise fall back to 800×600
      const size = renderer ? renderer.getSize(new THREE.Vector2()) : new THREE.Vector2(800, 600)
      return markerController.getVisibleAnnotations(cam, size.x, size.y)
    },

    // ── Task 22: instrument drop hit-test ──────────────────────────────────────
    pickNetAt(xPx: number, yPx: number, width: number, height: number): number | null {
      const cam = getActiveCamera()
      // Convert canvas pixel → NDC
      const ndcX = (xPx / width)  *  2 - 1
      const ndcY = (yPx / height) * -2 + 1
      // Re-use the picker's raycasting logic which already knows the mesh→netId map
      const hit = picker.raycastFirst({ x: ndcX, y: ndcY }, cam)
      if (!hit) return null
      return hit.netId ?? null
    },

    // ── Bench leads: generalized attach-target hit-test + anchor projection ────
    pickAttachTargetAt(xPx, yPx, width, height) {
      const cam = getActiveCamera()
      const ndcX = (xPx / width) * 2 - 1
      const ndcY = (yPx / height) * -2 + 1
      const hit = picker.raycastTargets({ x: ndcX, y: ndcY }, cam)
      if (!hit) return null
      const result: { netId?: number; ref?: string } = {}
      if (hit.netId !== undefined) result.netId = hit.netId
      if (hit.ref !== undefined) result.ref = hit.ref
      return result
    },

    projectAnchors(netIds, refs) {
      const cam = getActiveCamera()
      const size = renderer ? renderer.getSize(new THREE.Vector2()) : new THREE.Vector2(800, 600)
      const nets = new Map<number, THREE.Vector3>()
      for (const id of netIds) {
        const pos = netPositionsMap.get(id)
        if (pos) nets.set(id, pos)
      }
      const refMap = new Map<string, THREE.Vector3>()
      for (const ref of refs) {
        const pos = componentAnchorByRef.get(ref)
        if (pos) refMap.set(ref, pos)
      }
      return projectAnchorSet(nets, refMap, cam, size.x, size.y)
    },

    highlightAttachTarget(target) {
      picker.setExternalHighlight(target?.netId ?? null, target?.ref ? [target.ref] : [])
      dirty = true
    },

    // ── LED operating-point glow ────────────────────────────────────────────────
    updateComponentEmissive(ref: string, intensity: number, color?: number): void {
      ledGlowController?.updateComponentEmissive(ref, intensity, color)
      dirty = true
    },

    applyLedCurrents(currentsByRef: Map<string, number>): void {
      ledGlowController?.applyCurrents(currentsByRef)
      // E2E testability hook (First Light, L5): publish the per-ref glow + the max
      // emissive intensity (0..1 via the same ledIntensity curve the controller
      // uses) so a Playwright test can assert the LED is lit — and dimmed when the
      // supply voltage drops. Best-effort; no-op outside a DOM/window.
      publishLedGlow(currentsByRef)
      dirty = true
    },

    // ── Board Critic overlay ───────────────────────────────────────────────────
    setCriticFindings(findings: Finding[]): void {
      criticOverlay.setFindings(findings, boardThicknessMm)
      dirty = true
    },

    clearCriticFindings(): void {
      // setFindings([]) wipes the markers AND forgets them, so a subsequent board
      // reload's reapplyLast doesn't resurrect a cleared report.
      criticOverlay.setFindings([], boardThicknessMm)
      // Drop any critic highlight too.
      picker.setExternalHighlight(null, [])
      dirty = true
    },

    focusFinding(finding: Finding): void {
      // Highlight the involved net/part via the picker's emissive path (read-only,
      // identical to hover). netId → copper/vias; refs → component boxes.
      picker.setExternalHighlight(finding.netId ?? null, finding.refs)

      // Ease the camera to the finding location (BOARD-mm → world, then apply the
      // board-centering offset the overlay/copper groups use).
      if (finding.location && controls) {
        const w = kicadToWorld(finding.location.x, finding.location.y)
        const target = new THREE.Vector3(
          w.x - boardCenter.x,
          w.y - boardCenter.y,
          // Center on the marker plane (where the sphere sits), not the board mid.
          boardThicknessMm + MARKER_Z_LIFT,
        )
        // Keep the current viewing distance/direction; just recenter on the point.
        const cam = getActiveCamera()
        const offset = cam.position.clone().sub(controls.target)
        camTween = { camGoal: target.clone().add(offset), targetGoal: target }
      }
      dirty = true
    },
  }
}

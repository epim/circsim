/**
 * viewport/scene.ts
 *
 * Task 16 — Imperative scene manager.
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
 *
 * Spec §10.3
 *
 * NOTE: scene.ts is validated by the build, not headless unit tests.
 *       OrbitControls/render loop require a DOM canvas.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { BoardModel } from '../../../core/kicad/types'
import { buildSubstrate } from './boardGeometry'

// ─── types ────────────────────────────────────────────────────────────────────

export interface SceneCallbacks {
  /** Called whenever a render frame completes (useful for FPS counters etc.) */
  onRender?: () => void
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

  function getActiveCamera(): THREE.Camera {
    return useOrtho ? orthoCamera! : perspCamera!
  }

  function markDirty(): void {
    dirty = true
  }

  function renderLoop(): void {
    animFrameId = requestAnimationFrame(renderLoop)
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

      // --- Start render loop ---
      dirty = true
      renderLoop()
    },

    dispose(): void {
      if (animFrameId !== null) cancelAnimationFrame(animFrameId)
      animFrameId = null
      controls?.dispose()
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
  }
}

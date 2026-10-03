import * as THREE from 'three'
import type { BoardModel } from '../../../core/kicad/types'
import { buildPadGeometry } from './copperGeometry'
import { voltageRampRgb } from '../ui/voltageRamp'

export type PadVoltages = Record<string, Record<string, number>>
export type VoltageRange = { min: number; max: number }

export function padVoltageRange(values: PadVoltages): VoltageRange | null {
  let min = Infinity
  let max = -Infinity
  for (const pads of Object.values(values)) for (const v of Object.values(pads)) {
    if (!Number.isFinite(v)) continue
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  return min === Infinity ? null : { min, max }
}

/** Two flat meshes, one per side, with independently colored pad vertices. */
export function createPadVoltageOverlay(board: BoardModel) {
  const group = new THREE.Group()
  group.name = 'physical-pad-voltages'
  group.visible = false
  const spans: { ref: string; pad: string; start: number; count: number; colors: THREE.BufferAttribute }[] = []
  const colorsByPad = new Map<string, THREE.Color>()
  let requestedVisible = false
  let hasValues = false

  for (const side of ['F', 'B'] as const) {
    const parts: { ref: string; pad: string; positions: Float32Array }[] = []
    for (const fp of board.footprints) for (const pad of fp.pads) {
      if (!pad.netId || !pad.layers.some(layer => layer === `${side}.Cu` || layer === `${side}_Cu`)) continue
      const geo = buildPadGeometry(pad, fp.at.x, fp.at.y, fp.at.rotDeg)
      if (!geo) continue
      const flat = geo.index ? geo.toNonIndexed() : geo
      parts.push({ ref: fp.ref, pad: pad.number, positions: new Float32Array(flat.getAttribute('position').array) })
      if (flat !== geo) flat.dispose()
      geo.dispose()
    }
    const count = parts.reduce((n, p) => n + p.positions.length / 3, 0)
    if (!count) continue
    const positions = new Float32Array(count * 3)
    const colors = new THREE.BufferAttribute(new Float32Array(count * 4), 4)
    let start = 0
    for (const part of parts) {
      positions.set(part.positions, start * 3)
      const size = part.positions.length / 3
      spans.push({ ref: part.ref, pad: part.pad, start, count: size, colors })
      start += size
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', colors)
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.z = side === 'F' ? board.boardThicknessMm : 0
    group.add(mesh)
  }

  return {
    group,
    setVoltages(values: PadVoltages | null, range: VoltageRange | null): void {
      colorsByPad.clear()
      hasValues = values !== null
      for (const span of spans) {
        const v = values?.[span.ref]?.[span.pad]
        const known = range !== null && v !== undefined && Number.isFinite(v)
        const color = new THREE.Color(0x666666)
        if (known) {
          const t = Math.max(0, Math.min(1, (v - range.min) / (range.max - range.min || 1)))
          const [r, g, b] = voltageRampRgb(t)
          color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
          colorsByPad.set(`${span.ref}\0${span.pad}`, color)
        }
        for (let i = span.start; i < span.start + span.count; i++) {
          span.colors.setXYZW(i, color.r, color.g, color.b, values ? 1 : 0)
        }
        span.colors.needsUpdate = true
      }
      group.visible = requestedVisible && hasValues
    },
    setVisible(visible: boolean): void {
      requestedVisible = visible
      group.visible = visible && hasValues
    },
    colorFor(ref: string, pad: string): THREE.Color | null {
      return colorsByPad.get(`${ref}\0${pad}`)?.clone() ?? null
    },
    dispose(): void {
      for (const child of group.children) {
        const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
        mesh.geometry.dispose()
        mesh.material.dispose()
      }
      group.removeFromParent()
      group.clear()
    },
  }
}

export type PadVoltageOverlay = ReturnType<typeof createPadVoltageOverlay>

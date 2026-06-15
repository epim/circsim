#!/usr/bin/env node
/**
 * scripts/gen-stress-fixture.mjs
 *
 * Task 17 — stress fixture generator.
 *
 * Emits a synthetic .kicad_pcb with ~5000 track segments for manual perf testing.
 * Does NOT run in CI — invoke manually:
 *
 *   node scripts/gen-stress-fixture.mjs > fixtures/fixture-stress.kicad_pcb
 *
 * The generated board:
 *   - 200×200 mm outline
 *   - 5000 random track segments on F.Cu and B.Cu across 10 nets
 *   - 100 vias on random nets
 *   - No footprints (we're testing rendering perf, not parsing)
 *
 * After generating, run `npm run dev` and open the file to check 60fps orbit.
 */

const BOARD_W = 200
const BOARD_H = 200
const NUM_SEGS = 5000
const NUM_NETS = 10
const NUM_VIAS = 100
const TRACK_WIDTH = 0.25
const VIA_SIZE = 0.8
const VIA_DRILL = 0.4

function rnd(min, max) {
  return min + Math.random() * (max - min)
}

function rndInt(min, max) {
  return Math.floor(rnd(min, max + 1))
}

const lines = []

lines.push(`(kicad_pcb (version 20221018) (generator pcbnew)`)
lines.push(`  (general (thickness 1.6))`)
lines.push(`  (layers`)
lines.push(`    (0 "F.Cu" signal)`)
lines.push(`    (31 "B.Cu" signal)`)
lines.push(`    (44 "Edge.Cuts" user)`)
lines.push(`  )`)
lines.push(`  (net 0 "")`)

for (let n = 1; n <= NUM_NETS; n++) {
  lines.push(`  (net ${n} "NET${n}")`)
}

// Board outline (simple rectangle)
lines.push(`  (gr_line (start 0 0) (end ${BOARD_W} 0) (layer "Edge.Cuts") (width 0.1))`)
lines.push(`  (gr_line (start ${BOARD_W} 0) (end ${BOARD_W} ${BOARD_H}) (layer "Edge.Cuts") (width 0.1))`)
lines.push(`  (gr_line (start ${BOARD_W} ${BOARD_H}) (end 0 ${BOARD_H}) (layer "Edge.Cuts") (width 0.1))`)
lines.push(`  (gr_line (start 0 ${BOARD_H}) (end 0 0) (layer "Edge.Cuts") (width 0.1))`)

// Generate track segments
const layers = ['F.Cu', 'B.Cu']
let segCount = 0

// First half: short random segments (more realistic)
for (let i = 0; i < NUM_SEGS * 0.7; i++) {
  const x0 = rnd(5, BOARD_W - 5).toFixed(4)
  const y0 = rnd(5, BOARD_H - 5).toFixed(4)
  const angle = rnd(0, 2 * Math.PI)
  const len = rnd(1, 20)
  const x1 = (parseFloat(x0) + Math.cos(angle) * len).toFixed(4)
  const y1 = (parseFloat(y0) + Math.sin(angle) * len).toFixed(4)
  const netId = rndInt(1, NUM_NETS)
  const layer = layers[rndInt(0, 1)]
  lines.push(`  (segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width ${TRACK_WIDTH}) (layer "${layer}") (net ${netId}))`)
  segCount++
}

// Second batch: longer diagonal runs (stress longer geometry)
for (let i = segCount; i < NUM_SEGS; i++) {
  const x0 = rnd(5, BOARD_W - 30).toFixed(4)
  const y0 = rnd(5, BOARD_H - 30).toFixed(4)
  const x1 = (parseFloat(x0) + rnd(5, 25)).toFixed(4)
  const y1 = (parseFloat(y0) + rnd(5, 25)).toFixed(4)
  const netId = rndInt(1, NUM_NETS)
  const layer = layers[rndInt(0, 1)]
  lines.push(`  (segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width ${TRACK_WIDTH}) (layer "${layer}") (net ${netId}))`)
}

// Vias
for (let i = 0; i < NUM_VIAS; i++) {
  const x = rnd(5, BOARD_W - 5).toFixed(4)
  const y = rnd(5, BOARD_H - 5).toFixed(4)
  const netId = rndInt(1, NUM_NETS)
  lines.push(`  (via (at ${x} ${y}) (size ${VIA_SIZE}) (drill ${VIA_DRILL}) (layers "F.Cu" "B.Cu") (net ${netId}))`)
}

lines.push(`)`)

process.stdout.write(lines.join('\n') + '\n')

// Summary to stderr so it doesn't pollute the fixture file
const segTotal = NUM_SEGS
process.stderr.write(`Generated stress fixture: ${segTotal} segments, ${NUM_VIAS} vias, ${NUM_NETS} nets\n`)
process.stderr.write(`Board: ${BOARD_W}×${BOARD_H} mm\n`)
process.stderr.write(`Usage: node scripts/gen-stress-fixture.mjs > fixtures/fixture-stress.kicad_pcb\n`)

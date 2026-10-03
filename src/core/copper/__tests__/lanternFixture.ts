/** Many distributed loads, a narrow supply pour and a broad via-stitched return. */
export function lanternBoard(): string {
  const parts: string[] = []
  for (let i = 0; i < 48; i++) {
    const x = 10 + (i % 6) * 8
    const y = 12 + Math.floor(i / 6) * 10
    if (y > 24 && y < 40 && (x < 24 || x > 36)) continue
    parts.push(`(footprint "R" (layer "F.Cu") (at ${x} ${y})
      (fp_text reference "R${i + 1}" (at 0 0) (layer "F.SilkS"))
      (fp_text value "1k" (at 0 0) (layer "F.Fab"))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net 2 "GND")))
      (segment (start ${x + 2} ${y}) (end ${x + 3} ${y}) (width 0.25) (layer "F.Cu") (net 2))
      (via (at ${x + 3} ${y}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2))`)
  }
  return `(kicad_pcb (version 20221018) (generator pcbnew) (general (thickness 1.6))
    (net 0 "") (net 1 "VCC") (net 2 "GND")
    (footprint "Connector" (layer "F.Cu") (at 10 8)
      (fp_text reference "J1" (at 0 0) (layer "F.SilkS"))
      (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.4) (layers "*.Cu") (net 1 "VCC"))
      (pad "2" thru_hole circle (at 2 0) (size 1 1) (drill 0.4) (layers "*.Cu") (net 2 "GND")))
    ${parts.join('\n')}
    (zone (net 1) (net_name "VCC") (layer "F.Cu") (polygon (pts
      (xy 8 6) (xy 52 6) (xy 52 24) (xy 36 24) (xy 36 40) (xy 52 40)
      (xy 52 86) (xy 8 86) (xy 8 40) (xy 24 40) (xy 24 24) (xy 8 24))))
    (zone (net 2) (net_name "GND") (layer "B.Cu") (polygon (pts (xy 6 4) (xy 56 4) (xy 56 90) (xy 6 90))))
    (gr_rect (start 4 2) (end 58 92) (layer "Edge.Cuts") (width 0.1)))`
}


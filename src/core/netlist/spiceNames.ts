/**
 * core/netlist/spiceNames.ts
 *
 * Deterministic SPICE node name sanitization algorithm from spec §8.3.
 *
 * Algorithm:
 *   1. Lowercase the KiCad net name
 *   2. Replace every character outside [a-z0-9_] with _
 *   3. Collapse runs of _ into a single _
 *
 * Collision handling (stateful — done in extract.ts, not here):
 *   On collision append _2, _3, …
 *
 * The designated ground net maps to "0" — handled in extract(), not here.
 *
 * Examples (spec §8.3):
 *   VIN               → vin
 *   +5V               → _5v
 *   Net-(R1-Pad1)     → net_r1_pad1_
 *   GND (ground net)  → "0"  (via extract, not this function)
 */

/**
 * Pure, stateless sanitization. Does NOT handle collisions (see buildSpiceNames).
 * Does NOT apply ground-net → "0" mapping (that's extract()'s job).
 */
export function sanitizeSpiceNode(name: string): string {
  if (name === '') return ''
  // Step 1: lowercase
  let s = name.toLowerCase()
  // Step 2: replace every char outside [a-z0-9_] with _
  s = s.replace(/[^a-z0-9_]/g, '_')
  // Step 3: collapse runs of _ into single _
  s = s.replace(/_+/g, '_')
  return s
}

/**
 * Build a complete {netId → spiceNode} mapping for all nets, handling:
 *  - Ground net designation (maps to "0")
 *  - Collision resolution (_2, _3, …)
 *
 * @param netById  The board's netById map
 * @param groundNetId  Optional; the net that should map to SPICE node "0"
 */
export function buildSpiceNames(
  netById: Map<number, { id: number; name: string }>,
  groundNetId?: number,
): Map<number, string> {
  const result = new Map<number, string>()
  // Track which sanitized names are already used (including "0")
  const used = new Map<string, number>() // sanitized → count of uses

  // Process ground net first so it always gets "0"
  if (groundNetId !== undefined && netById.has(groundNetId)) {
    result.set(groundNetId, '0')
    used.set('0', 1)
  }

  // Process remaining nets in ascending netId order for determinism
  const sortedNets = Array.from(netById.values()).sort((a, b) => a.id - b.id)

  for (const net of sortedNets) {
    if (result.has(net.id)) continue // already assigned (ground)

    const base = sanitizeSpiceNode(net.name)

    if (!used.has(base)) {
      result.set(net.id, base)
      used.set(base, 1)
    } else {
      // Collision — find next available suffix
      const count = used.get(base)! + 1
      used.set(base, count)
      const candidate = `${base}_${count}`
      result.set(net.id, candidate)
    }
  }

  return result
}

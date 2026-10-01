---
title: Gallery
description: circsim on real boards. Screenshots of the bundled samples, a short recording, and what circsim reads out of KiCad-written boards from KiCad 6 through 10.
---

<script setup>
import { data as rows } from './gallery.data.ts'
const fmt = (v) => (v === null || v === undefined ? '-' : v)
const withMetrics = rows.filter((r) => r.metrics)
const kicadMajors = [...new Set(rows.map((r) => r.kicadMajor))].sort((a, b) => a - b)
</script>

# Gallery

## From open to energized to a Critic finding

![A short recording of circsim: the start screen, the bundled 555 sample opening on the 3D board, the Energize button being pressed with a supply lead clipped to the copper, and the read-only Board Critic listing clearance and decoupling findings on the right.](/img/demo-open-energize-critic.gif)

The recording is the bundled 555 blinker sample: open the board, energize it, and read the Board Critic. The amber banner in the later frames is circsim being honest that the operating point needed a numerical fallback, so the voltages should be double-checked. See [Read the warnings and fidelity banner](/guides/warnings).

## Screenshots

![First Light energized: the LED glowing red on the 3D board, a supply lead running to the copper, the PSU panel on the bench showing 5 V, and the Board Critic with two informational notes on the right.](/img/hero-first-light.png)

**First Light**, the two-part tutorial board. The LED glows when the simulated current through it is high enough to light it. Walk through it in the [First Light tutorial](/start/first-light).

![The bundled 555 sample energized: the Board Critic on the right shows three errors, including two clearance violations between the THRES and VCC tracks and a missing decoupling capacitor on the 555's power pin.](/img/hero-sample-critic.png)

**The 555 sample**, a seven-part blinker with a schematic attached. The Critic flags findings on the copper without touching the file. See [Run the Board Critic audit](/guides/run-critic).

More captures are in the guides: the [bench and leads](/guides/bench-and-leads), the [first-run screen](/start/first-run), and the [energize guide](/guides/energize).

## What circsim reads from real boards

The two boards above are circsim's own. To check that circsim handles boards it did not author, the test suite runs it against {{ rows.length }} KiCad-written boards from the KiCad source repository's demo directory, pinned at fixed release tags so each KiCad file-format generation ({{ kicadMajors.join(', ') }}) is covered by files that generation wrote. Every file is verified against a pinned sha256 before it is used.

This page does not show pictures of those boards. They are fetch-only test inputs, and the circsim repository never holds or redistributes third-party board files. Each row links to the board at its pinned tag in the upstream repository, so you can open the same file in KiCad or in circsim yourself. The figures come from the corpus baseline (`test/corpus/baseline.json`), which `npm run test:corpus` compares against on every run, and this table is generated from that file when the docs are built.

<table>
  <thead>
    <tr>
      <th>Board</th>
      <th>KiCad</th>
      <th>Parts</th>
      <th>Nets</th>
      <th>Tracks</th>
      <th>Vias</th>
      <th>Zones</th>
      <th>Stubbed</th>
      <th>Floating islands</th>
      <th>Board license</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="r in rows" :key="r.id">
      <td><a :href="r.sourceUrl" target="_blank" rel="noreferrer">{{ r.id }}</a></td>
      <td>{{ r.kicadMajor }}</td>
      <template v-if="r.metrics">
        <td>{{ fmt(r.metrics.footprints) }}</td>
        <td>{{ fmt(r.metrics.nets) }}</td>
        <td>{{ fmt(r.metrics.tracks) }}</td>
        <td>{{ fmt(r.metrics.vias) }}</td>
        <td>{{ fmt(r.metrics.zones) }}</td>
        <td>{{ fmt(r.metrics.stubbedPct) }}%</td>
        <td>{{ fmt(r.metrics.islands) }}</td>
      </template>
      <td v-else colspan="7">circsim cannot open this file yet (issue {{ r.knownFailingIssue }})</td>
      <td>{{ r.license }}</td>
    </tr>
  </tbody>
</table>

How to read the columns:

- **Parts, Nets, Tracks, Vias, Zones** are counts circsim extracted from the copper of the `.kicad_pcb` file. Net connectivity is checked against KiCad's own export for every board, so the pad-to-net grouping behind these counts is the same one KiCad reports.
- **Stubbed** is the share of parts that no [model tier](/concepts/models) could resolve, so circsim fell back to a stub. A high number means much of the board is parts circsim has no model for, such as large ICs, and the simulation is correspondingly shallow. See [Fidelity](/concepts/fidelity).
- **Floating islands** counts groups of nets with no DC path to ground. circsim adds a bleed resistor to each so the solver can converge.
- **Board license** is what the upstream demo directory declares. `none-declared` means the directory carries no LICENSE file.

{{ withMetrics.length }} of {{ rows.length }} boards open today. The rest are tracked as known failures in the corpus manifest, with the issue number shown in the row.

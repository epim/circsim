---
layout: home

hero:
  name: circsim
  text: The validation bench for routed boards
  tagline: Load the PCB you already routed, power it up, and probe it in 3D — an interactive SPICE bench that catches mistakes before you pay for fabrication.
  actions:
    - theme: brand
      text: Get started
      link: /start/install
    - theme: alt
      text: Tutorial — First Light
      link: /start/first-light
    - theme: alt
      text: What can it tell me?
      link: /concepts/fidelity

features:
  - title: Starts from your board, not a schematic
    details: Every other hobbyist simulator wants a schematic. circsim opens the routed .kicad_pcb you got back from Quilter or KiCad, rebuilds the circuit from the copper, and renders it in 3D.
  - title: A real bench, on your desk
    details: Clip a supply, a function generator, a potentiometer, and probes onto the board. Turn a knob and watch the LED respond live — the breadboard feeling, on a board you can't breadboard.
  - title: Honest about what it knows
    details: circsim tells you exactly which parts are modeled, which are stubbed, and where the physics stops. A validator you can't trust is worse than none — so it never hides the gaps.
  - title: A read-only board critic
    details: Before you send it off, circsim audits the board it did NOT design — floating nets, thin power paths, decoupling too far from the pin — and never touches your files.
---

## Why circsim exists

You described a circuit to an LLM, let [Quilter](https://quilter.ai) route the board, and got back a finished `.kicad_pcb`. Now what? Every simulator on the market — LTspice, Falstad, EveryCircuit, Wokwi, KiCad's own ngspice — wants you to *draw a schematic first*. None of them accept a routed board.

circsim does. It reads the net connectivity straight out of the board file, matches each part to a SPICE model, and gives you a bench to poke at it: apply power, read every net's voltage on the copper, drag a scope probe onto an output, and dial a knob while the waveform moves. When something is wrong — a rail sagging to 0.3 V, an op-amp stuck at the rail — you see it *on the physical board you're about to fabricate*.

It is fully offline, it is MIT-licensed, and it **never modifies your design files.**

<div style="margin-top: 2rem; padding: 1rem 1.25rem; border-left: 3px solid var(--vp-c-brand-1); background: var(--vp-c-bg-soft); border-radius: 6px;">

**New here?** Start with [installing circsim](/start/install), then do the [First Light tutorial](/start/first-light) — a one-LED dimmer that takes five minutes and shows the whole flow end to end.

</div>

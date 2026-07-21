# Your first five minutes

You've [installed circsim](./install). Let's get a board on the bench and power it up — no board file of your own required.

## Open something

When circsim starts with nothing loaded, the viewport offers three ways in:

- **Open sample project** — a 555 blinker. This is the full simulation flow in one click: a real astable oscillator you can energize and scope.
- **Open First Light demo** — a one-LED dimmer, the smallest possible start. If you've only ever breadboarded, [start here](./first-light).
- **Open…** — pick your own `.kicad_pcb`. You can also just **drag a board file onto the window**.

Click **Open sample project**. The 3D board appears, the parts list on the left fills in, and circsim quietly rebuilds the circuit from the copper.

## The lay of the land

circsim is one screen, three columns, dark by design:

- **Left** — the **Parts** list (every component, color-dotted by whether it has a model) and, below it, the **Model Doctor** (only appears when a part needs attention).
- **Center** — the **3D board**, the **bench shelf** underneath it, and the **scope + logs** dock along the bottom.
- **Right** — **Ground & Power** (where you designate the ground and supply nets) and the **Board Critic** (the read-only pre-fab audit).

Across the top is the **simulation toolbar**: `⚡ Energize`, `Power On`, `Run`, a **Pace** control (`0.1×` / `1×` / `max`), and an **Overlay** switch (`Realistic` / `Voltage` / `Highlight`).

## Light it up

Press **`⚡ Energize`**.

Energize is the one-click "make it work" button. Behind the scenes it designates a ground net, clips a 5 V supply onto the board's power rail if you haven't attached one, and runs a **DC operating-point** solve — the steady-state voltage everywhere. Then:

- Every net gets a floating **voltage label** on the board.
- The copper **tints by voltage** (the overlay auto-switches to `Voltage` — blue is low, red is high).
- Any **LED lights up** at a brightness that tracks its actual current.

That "rail at 4.98 V, output at 2.49 V" readout is the reassurance moment: your board is doing something, and you can see *where*.

::: tip Energize vs. Power On
**Energize** rigs up ground and a supply for you and solves — great for a board you just opened. **Power On** never rigs anything; it stays disabled until *you've* set a ground and attached a source. Use Energize to get going fast, Power On once you're driving the bench yourself.
:::

## Make it move

A DC operating point is a single frozen instant. To watch the 555 actually oscillate, press **`Run`**. circsim streams a live **transient** simulation. But you won't see a waveform until something is watching a net — so:

1. Click a net on the board (say, the 555's output), then click **`⌖ Probe this net`** in the bench header. A voltage probe clips on.
2. The **scope** in the bottom dock starts drawing that net's waveform in real time.
3. Adjust **Time/div** on the scope until the square wave is nicely framed.

Press **`Pause`** to freeze and scrub; **`Run`** again to resume.

## Where to go next

- **[Tutorial: First Light](./first-light)** — the full guided walkthrough on the simplest possible board: energize an LED, then dial a potentiometer and watch it dim.
- **[Use the bench & draw leads](../guides/bench-and-leads)** — add supplies, generators, and probes and wire them onto the board.
- **[What can circsim tell you?](../concepts/fidelity)** — read this before you trust any number. It's the honest account of the tool's limits.

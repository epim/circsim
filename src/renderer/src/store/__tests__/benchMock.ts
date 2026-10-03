import { createMockSimClient } from '../../ipc/simClient'

/** Existing bench tests script ideal replies; answer only the extra critic op. */
export function createBenchMockSimClient() {
  const mock = createMockSimClient()
  const send = mock.send.bind(mock)
  let physicalDeck: string[] | null = null
  mock.send = command => {
    send(command)
    if (command.type === 'loadCircuit') {
      physicalDeck = command.deckLines.some(line => /^vpad_/i.test(line)) ? command.deckLines : null
    }
    if (command.type === 'runOp' && physicalDeck) {
      const values: Record<string, number> = {}
      for (const line of physicalDeck) {
        if (!/^[rv]/i.test(line)) continue
        const [device, ...nodes] = line.split(/\s+/)
        for (const node of nodes.slice(0, 2)) values[node.toLowerCase()] = 0
        if (/^vpad_/i.test(device)) values[`i(${device.toLowerCase()})`] = 0
      }
      queueMicrotask(() => mock.emit({ type: 'opResult', values }))
    }
  }
  return mock
}

export function benchOpCount(mock: ReturnType<typeof createBenchMockSimClient>): number {
  let physical = false
  let count = 0
  for (const command of mock.sent) {
    if (command.type === 'loadCircuit') physical = command.deckLines.some(line => /^vpad_/i.test(line))
    if (command.type === 'runOp' && !physical) count++
  }
  return count
}

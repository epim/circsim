import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateAppStoreOptions } from '../appStore'
import { createRendererStore } from '../createRendererStore'

const mocks = vi.hoisted(() => ({
  createStore: vi.fn(), createClient: vi.fn(), replay: vi.fn(), noteCrash: vi.fn(),
}))
vi.mock('../appStore', () => ({ createAppStore: mocks.createStore }))
vi.mock('../../ipc/simClient', () => ({ createPortSimClient: mocks.createClient }))
vi.mock('../../boardOpen/runner', () => ({ createInlineRunner: () => ({}) }))
vi.mock('../../boardOpen/workerRunner', () => ({ createWorkerOpenRunner: () => ({}) }))
vi.mock('../../boardOpen/boardOpen.worker?worker&inline', () => ({ default: class {} }))
vi.mock('../sidecarSync', () => ({ attachSidecarSync: () => ({ flush: async () => {} }) }))

function setup() {
  let message!: (event: { data: string; ports: object[] }) => void
  let crash!: (event: { willRespawn: boolean; exitCode: number; reason: 'crashed' }) => void
  let ready!: () => void
  const client = { attachPort: vi.fn(), waitFor: vi.fn(() => new Promise<void>(resolve => { ready = resolve })) }
  mocks.createClient.mockReturnValue(client)
  mocks.createStore.mockReturnValue({ getState: () => ({
    replayAfterCrash: mocks.replay, noteCrash: mocks.noteCrash, setModelLibrary: vi.fn(),
  }) })
  vi.stubGlobal('window', {
    addEventListener: (name: string, listener: typeof message) => { if (name === 'message') message = listener },
    circsim: {
      restartSimhost: vi.fn(async () => {}),
      onSimhostCrashed: (listener: typeof crash) => { crash = listener },
      getModelLibrary: async () => ({ entries: [], texts: {} }),
    },
  })
  createRendererStore()
  const options = mocks.createStore.mock.calls[0][0] as CreateAppStoreOptions
  const port = () => message({ data: 'circsim:simhost-port', ports: [{}] })
  port()
  return { client, options, port, crash, ready: () => ready() }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('planned restart port handling', () => {
  it('awaits readiness and suppresses duplicate replay only during the planned reset', async () => {
    const { client, options, port, ready } = setup()
    const pending = options.restartSimhost!()
    port()
    expect(client.attachPort).toHaveBeenCalledTimes(2)
    expect(mocks.replay).not.toHaveBeenCalled()
    ready()
    await pending
    port()
    expect(mocks.replay).toHaveBeenCalledOnce()
  })

  it('replays the crash-respawn port if the planned child dies before ready', async () => {
    const { options, port, ready, crash } = setup()
    const pending = options.restartSimhost!()
    crash({ willRespawn: true, exitCode: 1, reason: 'crashed' })
    port()
    expect(mocks.noteCrash).toHaveBeenCalledWith(true, { exitCode: 1, reason: 'crashed' })
    expect(mocks.replay).toHaveBeenCalledOnce()
    ready()
    await pending
  })
})

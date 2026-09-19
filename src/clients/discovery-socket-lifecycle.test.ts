import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockHttpClient } from '../net/mock-http-client.js'
import { MockUdpSocket } from '../net/mock-udp-socket.js'
import { StunClient } from './stun-client.js'
import { UpnpClient } from './upnp-client.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function makeHarness(protocol: 'stun' | 'upnp') {
  const socket = new MockUdpSocket()
  const factory = vi.fn(() => socket)
  const close = vi.spyOn(socket, 'close')
  const send = vi.spyOn(socket, 'send')
  const offMessage = vi.spyOn(socket, 'offMessage')
  const stun = new StunClient({ udpFactory: factory })
  const upnp = new UpnpClient({
    udpFactory: factory,
    http: createMockHttpClient().client,
  })
  return {
    socket,
    factory,
    close,
    send,
    offMessage,
    run: (signal?: AbortSignal) =>
      protocol === 'stun'
        ? stun.detectNatType({
            servers: ['192.168.1.1:3478'],
            timeoutMs: 10,
            ...(signal ? { signal } : {}),
          })
        : upnp.discover({ timeoutMs: 10 }),
  }
}

describe('discovery socket cleanup', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  for (const protocol of ['stun', 'upnp'] as const) {
    it(`${protocol} does not send after a timed-out bind completes`, async () => {
      const harness = makeHarness(protocol)
      const binding = deferred()
      vi.spyOn(harness.socket, 'bind').mockReturnValueOnce(binding.promise)
      const result = harness.run()
      await vi.advanceTimersByTimeAsync(10)
      expect((await result).ok).toBe(false)
      binding.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.send).not.toHaveBeenCalled()
      expect(harness.close).toHaveBeenCalledOnce()
      expect(harness.offMessage).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })

    it(`${protocol} settles even when close throws synchronously`, async () => {
      const harness = makeHarness(protocol)
      harness.close.mockImplementationOnce(() => {
        throw new Error('close failed')
      })
      const result = harness.run()
      await vi.advanceTimersByTimeAsync(10)
      expect((await result).ok).toBe(false)
      expect(harness.offMessage).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })
  }

  it('STUN removes abort listeners after timeout', async () => {
    const harness = makeHarness('stun')
    const controller = new AbortController()
    const result = harness.run(controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10)
    await result
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    controller.abort()
    expect(harness.close).toHaveBeenCalledOnce()
  })

  it('STUN abort during bind closes once and does not query fallback servers', async () => {
    const harness = makeHarness('stun')
    const binding = deferred()
    vi.spyOn(harness.socket, 'bind').mockReturnValueOnce(binding.promise)
    const controller = new AbortController()
    const client = new StunClient({ udpFactory: harness.factory })
    const result = client.detectNatType({
      servers: ['192.168.1.1:3478', '192.168.1.2:3478'],
      timeoutMs: 10,
      signal: controller.signal,
    })
    controller.abort()
    expect((await result).ok).toBe(false)
    binding.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.factory).toHaveBeenCalledOnce()
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.close).toHaveBeenCalledOnce()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('STUN skips socket creation for an already aborted request', async () => {
    const harness = makeHarness('stun')
    expect((await harness.run(AbortSignal.abort())).ok).toBe(false)
    expect(harness.factory).not.toHaveBeenCalled()
  })

  it('UPnP does not send another search after timeout during the first send', async () => {
    const harness = makeHarness('upnp')
    const sending = deferred()
    harness.send.mockReturnValueOnce(sending.promise)
    const result = harness.run()
    await vi.advanceTimersByTimeAsync(10)
    expect((await result).ok).toBe(false)
    sending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.send).toHaveBeenCalledOnce()
    expect(harness.close).toHaveBeenCalledOnce()
  })
})

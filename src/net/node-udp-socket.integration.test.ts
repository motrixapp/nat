import dgram from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeUdpSocket } from './udp-socket.js'

describe('NodeUdpSocket native lifecycle', () => {
  afterEach(() => vi.restoreAllMocks())

  it('cancels a native bind without waiting for its callback', async () => {
    const socket = new NodeUdpSocket({ type: 'udp4' })
    const binding = expect(socket.bind(0, '127.0.0.1')).rejects.toThrow(
      'socket closed'
    )
    await socket.close()
    await binding
    expect(socket.address()).toBeNull()
  })

  it('closes native bound and unbound sockets idempotently', async () => {
    for (const bind of [false, true]) {
      const socket = new NodeUdpSocket({ type: 'udp4' })
      if (bind) await socket.bind(0, '127.0.0.1')
      await Promise.all([socket.close(), socket.close()])
      await socket.close()
    }
  })

  it('completes close when an implicit bind fails with queued sends', async () => {
    let failBind = () => {}
    const native = dgram.createSocket({
      type: 'udp4',
      lookup: (_hostname, _options, callback) => {
        failBind = () => callback(new Error('bind lookup failed'), '', 4)
      },
    })
    vi.spyOn(dgram, 'createSocket').mockReturnValueOnce(native)
    const socket = new NodeUdpSocket({ type: 'udp4' })
    const sending = expect(
      socket.send(Buffer.from('x'), 5351, '127.0.0.1')
    ).rejects.toThrow('socket closed')
    const closing = socket.close()
    failBind()
    await sending
    await closing
  })
})

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createSocketMock } = vi.hoisted(() => ({
  createSocketMock: vi.fn(),
}))

vi.mock('node:dgram', () => ({
  default: { createSocket: createSocketMock },
}))

import { NodeUdpSocket } from './udp-socket.js'

class FakeSocket extends EventEmitter {
  bind = vi.fn(
    (_port: number, _address: string | undefined, callback: () => void) =>
      callback()
  )
  addMembership = vi.fn()
  setMulticastInterface = vi.fn()
  setMulticastTTL = vi.fn()
  send = vi.fn(
    (
      _msg: Buffer,
      _port: number,
      _address: string,
      callback: (error: Error | null) => void
    ) => callback(null)
  )
  close = vi.fn((callback: () => void) => callback())
  address = vi.fn(() => ({
    port: 12345,
    address: '127.0.0.1',
    family: 'IPv4',
  }))
}

function createSubject(options: { reuseAddr?: boolean } = {}) {
  const socket = new FakeSocket()
  createSocketMock.mockReturnValueOnce(socket)
  const subject = new NodeUdpSocket({ type: 'udp4', ...options })
  return { socket, subject }
}

describe('NodeUdpSocket', () => {
  beforeEach(() => {
    createSocketMock.mockReset()
  })

  it('creates a reusable udp4 socket by default and binds on an ephemeral port', async () => {
    const { socket, subject } = createSubject()

    await subject.bind()

    expect(createSocketMock).toHaveBeenCalledWith({
      type: 'udp4',
      reuseAddr: true,
    })
    expect(socket.bind).toHaveBeenCalledWith(0, undefined, expect.any(Function))
  })

  it('rejects bind when the native socket emits an error', async () => {
    const { socket, subject } = createSubject({ reuseAddr: false })
    socket.bind.mockImplementationOnce(() => {
      queueMicrotask(() => socket.emit('error', new Error('address in use')))
    })

    await expect(subject.bind(5351, '0.0.0.0')).rejects.toThrow(
      'address in use'
    )
    expect(createSocketMock).toHaveBeenCalledWith({
      type: 'udp4',
      reuseAddr: false,
    })
  })

  it('forwards multicast configuration and sends datagrams', async () => {
    const { socket, subject } = createSubject()
    const payload = Buffer.from('hello')

    subject.addMembership('239.255.255.250', '192.168.1.10')
    subject.setMulticastInterface('192.168.1.10')
    subject.setMulticastTTL(4)
    await subject.send(payload, 1900, '239.255.255.250')

    expect(socket.addMembership).toHaveBeenCalledWith(
      '239.255.255.250',
      '192.168.1.10'
    )
    expect(socket.setMulticastInterface).toHaveBeenCalledWith('192.168.1.10')
    expect(socket.setMulticastTTL).toHaveBeenCalledWith(4)
    expect(socket.send).toHaveBeenCalledWith(
      payload,
      1900,
      '239.255.255.250',
      expect.any(Function)
    )
  })

  it('rejects a failed native send', async () => {
    const { socket, subject } = createSubject()
    socket.send.mockImplementationOnce(
      (
        _msg: Buffer,
        _port: number,
        _address: string,
        callback: (error: Error | null) => void
      ) => callback(new Error('network down'))
    )

    await expect(
      subject.send(Buffer.from('x'), 5351, '192.168.1.1')
    ).rejects.toThrow('network down')
  })

  it('fans native messages out to registered listeners', () => {
    const { socket, subject } = createSubject()
    const first = vi.fn()
    const removed = vi.fn()
    subject.onMessage(first)
    subject.onMessage(removed)
    subject.offMessage(removed)

    const message = Buffer.from('response')
    const rinfo = { address: '192.168.1.1', port: 5351, size: message.length }
    socket.emit('message', message, rinfo)

    expect(first).toHaveBeenCalledWith(message, rinfo)
    expect(removed).not.toHaveBeenCalled()
  })

  it('reports native address state and tolerates an unbound socket', () => {
    const { socket, subject } = createSubject()
    expect(subject.address()).toEqual({
      port: 12345,
      address: '127.0.0.1',
    })

    socket.address.mockImplementationOnce(() => {
      throw new Error('not bound')
    })
    expect(subject.address()).toBeNull()
  })

  it('closes once and rejects later mutations', async () => {
    const { socket, subject } = createSubject()

    await subject.close()
    await subject.close()

    expect(socket.close).toHaveBeenCalledOnce()
    expect(subject.address()).toBeNull()
    await expect(subject.bind()).rejects.toThrow('socket closed')
    await expect(
      subject.send(Buffer.from('x'), 1, '127.0.0.1')
    ).rejects.toThrow('socket closed')
    expect(() => subject.addMembership('239.0.0.1')).toThrow('socket closed')
    expect(() => subject.setMulticastInterface('192.168.1.10')).toThrow(
      'socket closed'
    )
    expect(() => subject.setMulticastTTL(1)).toThrow('socket closed')
  })

  it('contains errors after bind and rejects in-flight sends', async () => {
    const { socket, subject } = createSubject()
    await subject.bind()
    socket.send.mockImplementationOnce(() => {})
    const sent = subject.send(Buffer.from('x'), 5351, '192.168.1.1')
    const failed = expect(sent).rejects.toThrow('network changed')
    expect(() =>
      socket.emit('error', new Error('network changed'))
    ).not.toThrow()
    await failed
    await subject.close()
  })

  it('settles a pending bind on close even if its callback never arrives', async () => {
    const { socket, subject } = createSubject()
    socket.bind.mockImplementationOnce(() => {})
    const bound = expect(subject.bind()).rejects.toThrow('socket closed')
    await subject.close()
    await bound
  })

  it('shares completion between concurrent closes', async () => {
    const { socket, subject } = createSubject()
    let finishClose = () => {}
    socket.close.mockImplementationOnce((callback) => {
      finishClose = callback
    })
    const first = subject.close()
    const second = subject.close()
    expect(first).toBe(second)
    finishClose()
    await Promise.all([first, second])
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('tolerates an already-closed native socket', async () => {
    const { socket, subject } = createSubject()
    socket.close.mockImplementationOnce(() => {
      throw Object.assign(new Error('Not running'), {
        code: 'ERR_SOCKET_DGRAM_NOT_RUNNING',
      })
    })
    await expect(subject.close()).resolves.toBeUndefined()
    await expect(subject.close()).resolves.toBeUndefined()
  })

  it('contains late native errors and messages after close', async () => {
    const { socket, subject } = createSubject()
    const listener = vi.fn()
    subject.onMessage(listener)
    await subject.close()
    expect(() => socket.emit('error', new Error('late error'))).not.toThrow()
    socket.emit('message', Buffer.from('late'), {
      address: '192.168.1.1',
      port: 5351,
      size: 4,
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('allows retry after a synchronous bind failure without keeping stale callbacks', async () => {
    const { socket, subject } = createSubject()
    socket.bind.mockImplementationOnce(() => {
      throw new Error('bind failed')
    })
    await expect(subject.bind()).rejects.toThrow('bind failed')
    await expect(subject.bind()).resolves.toBeUndefined()
    expect(() => socket.emit('error', new Error('idle error'))).not.toThrow()
    await expect(
      subject.send(Buffer.from('x'), 5351, '192.168.1.1')
    ).resolves.toBeUndefined()
    await subject.close()
  })

  it('rejects pending sends on close and ignores their late callbacks', async () => {
    const { socket, subject } = createSubject()
    let callback = (_error: Error | null) => {}
    socket.send.mockImplementationOnce((_msg, _port, _address, cb) => {
      callback = cb
    })
    const sent = expect(
      subject.send(Buffer.from('x'), 5351, '192.168.1.1')
    ).rejects.toThrow('socket closed')
    await subject.close()
    await sent
    expect(() => callback(new Error('late error'))).not.toThrow()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('propagates unexpected native close failures', async () => {
    const { socket, subject } = createSubject()
    socket.close.mockImplementationOnce(() => {
      throw new Error('close failed')
    })
    await expect(subject.close()).rejects.toThrow('close failed')
    await expect(subject.close()).rejects.toThrow('close failed')
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('settles pending work when the native socket closes independently', async () => {
    const { socket, subject } = createSubject()
    socket.send.mockImplementationOnce(() => {})
    const sent = expect(
      subject.send(Buffer.from('x'), 5351, '192.168.1.1')
    ).rejects.toThrow('socket closed')
    socket.emit('close')
    await sent
    await subject.close()
    expect(socket.close).not.toHaveBeenCalled()
    expect(subject.address()).toBeNull()
  })
})

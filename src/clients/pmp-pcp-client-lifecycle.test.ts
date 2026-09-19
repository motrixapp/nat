import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from '../__test__/utils.js'
import { NatErrorCode } from '../errors.js'
import { MockUdpSocket } from '../net/mock-udp-socket.js'
import { PmpPcpClient } from './pmp-pcp-client.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function reply(socket: MockUdpSocket) {
  const response = Buffer.alloc(12)
  response[1] = 0x80
  response.set([203, 0, 113, 42], 8)
  socket.emitMessage(response, { address: '192.168.1.1', port: 5351, size: 12 })
}

describe('PmpPcpClient socket lifecycle', () => {
  let first: MockUdpSocket
  let second: MockUdpSocket
  let client: PmpPcpClient

  beforeEach(() => {
    first = new MockUdpSocket()
    second = new MockUdpSocket()
    client = new PmpPcpClient({
      udpFactory: vi.fn().mockReturnValueOnce(first).mockReturnValue(second),
      gatewayIp: '192.168.1.1',
      clientIp: Buffer.alloc(16),
    })
  })

  afterEach(async () => {
    await client.close()
  })

  it('does not let an old close detach a newly opened socket', async () => {
    const pending = client.natPmpGetExternalIp()
    await tick()
    const closing = deferred()
    const close = vi.spyOn(first, 'close').mockReturnValue(closing.promise)
    const firstClose = client.close()
    const secondClose = client.close()
    const next = client.natPmpGetExternalIp()
    await tick()
    closing.resolve()
    await Promise.all([firstClose, secondClose])
    expect(close).toHaveBeenCalledOnce()
    expect((await pending).ok).toBe(false)
    expect(second.sendCalls).toHaveLength(1)
    reply(second)
    expect((await next).ok).toBe(true)
    const third = client.natPmpGetExternalIp()
    await tick()
    reply(second)
    expect((await third).ok).toBe(true)
  })

  it('discards a bind that completes after close and reopen', async () => {
    const binding = deferred()
    vi.spyOn(first, 'bind').mockReturnValue(binding.promise)
    const old = client.natPmpGetExternalIp()
    await client.close()
    const next = client.natPmpGetExternalIp()
    await tick()
    binding.resolve()
    expect(await old).toMatchObject({
      ok: false,
      error: NatErrorCode.NetworkChanged,
    })
    expect(first.sendCalls).toHaveLength(0)
    reply(second)
    expect((await next).ok).toBe(true)
  })

  it('retries with a fresh socket after bind fails', async () => {
    vi.spyOn(first, 'bind').mockRejectedValueOnce(new Error('bind failed'))
    expect(await client.natPmpGetExternalIp()).toMatchObject({
      ok: false,
      error: NatErrorCode.GatewayUnreachable,
    })
    expect(first.closed).toBe(true)
    const next = client.natPmpGetExternalIp()
    await tick()
    reply(second)
    expect((await next).ok).toBe(true)
  })

  it('does not let a late send failure cancel the next request', async () => {
    const sending = deferred()
    vi.spyOn(first, 'send').mockReturnValueOnce(sending.promise)
    const old = client.natPmpGetExternalIp()
    await tick()
    await client.close()
    expect((await old).ok).toBe(false)
    const next = client.natPmpGetExternalIp()
    await tick()
    sending.reject(new Error('late network error'))
    await tick()
    reply(second)
    expect((await next).ok).toBe(true)
  })

  it('recovers from a synchronously throwing bind', async () => {
    vi.spyOn(first, 'bind').mockImplementationOnce(() => {
      throw new Error('bind failed')
    })
    expect(await client.natPmpGetExternalIp()).toMatchObject({
      ok: false,
      error: NatErrorCode.GatewayUnreachable,
    })
    const next = client.natPmpGetExternalIp()
    await tick()
    reply(second)
    expect((await next).ok).toBe(true)
  })

  it('settles a cancelled bind that never completes', async () => {
    vi.spyOn(first, 'bind').mockReturnValue(new Promise(() => {}))
    const old = client.natPmpGetExternalIp()
    await tick()
    await client.close()
    expect(await old).toMatchObject({
      ok: false,
      error: NatErrorCode.NetworkChanged,
    })
  })

  it('ignores messages retained by an old socket during close', async () => {
    const old = client.natPmpGetExternalIp()
    await tick()
    vi.spyOn(first, 'close').mockResolvedValue()
    await client.close()
    await old
    const next = client.natPmpGetExternalIp()
    await tick()
    let settled = false
    void next.then(() => {
      settled = true
    })
    reply(first)
    await tick()
    expect(settled).toBe(false)
    reply(second)
    expect((await next).ok).toBe(true)
  })

  it('does not let an old PCP send failure delete a reused nonce', async () => {
    const sending = deferred()
    vi.spyOn(first, 'send').mockReturnValueOnce(sending.promise)
    const params = {
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP' as const,
      ttl: 3600,
      nonce: Buffer.alloc(12, 1),
    }
    const old = client.pcpMap(params)
    await tick()
    await client.close()
    await old
    const next = client.pcpMap(params)
    await tick()
    sending.reject(new Error('late send error'))
    await tick()
    const response = Buffer.alloc(60)
    response[0] = 2
    response[1] = 0x81
    response.writeUInt32BE(3600, 4)
    params.nonce.copy(response, 24)
    response[36] = 6
    response.writeUInt16BE(6881, 40)
    response.writeUInt16BE(6881, 42)
    second.emitMessage(response, {
      address: '192.168.1.1',
      port: 5351,
      size: 60,
    })
    expect((await next).ok).toBe(true)
  })

  it('rejects duplicate in-flight PCP nonces without orphaning the first request', async () => {
    const params = {
      internalPort: 6881,
      externalPort: 6881,
      protocol: 'TCP' as const,
      ttl: 3600,
      nonce: Buffer.alloc(12, 1),
    }
    const pending = client.pcpMap(params)
    await tick()
    expect(await client.pcpMap(params)).toMatchObject({
      ok: false,
      error: NatErrorCode.ProtocolRejected,
    })
    await client.close()
    expect(await pending).toMatchObject({
      ok: false,
      error: NatErrorCode.NetworkChanged,
    })
  })
})

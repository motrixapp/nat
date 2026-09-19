import dgram from 'node:dgram'
import { natLogger } from '../logger.js'

const log = natLogger('udp')

export interface UdpSocketOptions {
  type: 'udp4'
  reuseAddr?: boolean
}

export interface UdpRemoteInfo {
  address: string
  port: number
  size: number
}

export type UdpMessageListener = (msg: Buffer, rinfo: UdpRemoteInfo) => void

export interface UdpSocket {
  bind(port?: number, address?: string): Promise<void>
  addMembership(multicastAddress: string, interfaceAddress?: string): void
  setMulticastInterface?(interfaceAddress: string): void
  setMulticastTTL(ttl: number): void
  send(msg: Buffer, port: number, address: string): Promise<void>
  onMessage(listener: UdpMessageListener): void
  offMessage(listener: UdpMessageListener): void
  close(): Promise<void>
  address(): { port: number; address: string } | null
}

export class NodeUdpSocket implements UdpSocket {
  private socket: dgram.Socket | null
  private listeners = new Set<UdpMessageListener>()
  private closePromise: Promise<void> | null = null
  private readonly pending = new Set<(error: Error) => void>()

  constructor(options: UdpSocketOptions) {
    this.socket = dgram.createSocket({
      type: options.type,
      reuseAddr: options.reuseAddr ?? true,
    })
    // dgram can emit errors after bind/send callbacks have completed. Keep
    // this listener for the native socket's entire lifetime, including close.
    this.socket.on('error', (error: Error) => {
      if (!this.socket) return
      log.warn({ err: error }, 'UDP socket error')
      this.rejectPending(error)
    })
    this.socket.once('close', () => {
      this.socket = null
      this.listeners.clear()
      this.rejectPending(new Error('socket closed'))
    })
    this.socket.on('message', (msg, rinfo) => {
      for (const l of this.listeners) l(msg, rinfo)
    })
  }

  bind(port?: number, address?: string): Promise<void> {
    return this.runOperation((socket, finish) => {
      socket.bind(port ?? 0, address, () => finish())
    })
  }

  private runOperation(
    start: (
      socket: dgram.Socket,
      finish: (error?: Error | null) => void
    ) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (!socket) return reject(new Error('socket closed'))
      const finish = (error?: Error | null) => {
        if (!this.pending.delete(finish)) return
        if (error) reject(error)
        else resolve()
      }
      this.pending.add(finish)
      try {
        start(socket, finish)
      } catch (error) {
        finish(error as Error)
      }
    })
  }

  private rejectPending(error: Error): void {
    for (const finish of this.pending) finish(error)
  }

  addMembership(multicastAddress: string, interfaceAddress?: string): void {
    if (!this.socket) throw new Error('socket closed')
    this.socket.addMembership(multicastAddress, interfaceAddress)
  }

  setMulticastInterface(interfaceAddress: string): void {
    if (!this.socket) throw new Error('socket closed')
    this.socket.setMulticastInterface(interfaceAddress)
  }

  setMulticastTTL(ttl: number): void {
    if (!this.socket) throw new Error('socket closed')
    this.socket.setMulticastTTL(ttl)
  }

  send(msg: Buffer, port: number, address: string): Promise<void> {
    return this.runOperation((socket, finish) => {
      socket.send(msg, port, address, finish)
    })
  }

  onMessage(listener: UdpMessageListener): void {
    if (this.socket) this.listeners.add(listener)
  }

  offMessage(listener: UdpMessageListener): void {
    this.listeners.delete(listener)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    const socket = this.socket
    this.socket = null
    this.listeners.clear()
    this.rejectPending(new Error('socket closed'))
    this.closePromise = new Promise((resolve, reject) => {
      if (!socket) return resolve()
      const finish = (error?: unknown) => {
        socket.off('error', closeNative)
        if (error) reject(error)
        else resolve()
      }
      const closeNative = () => {
        try {
          socket.close(() => finish())
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code ===
            'ERR_SOCKET_DGRAM_NOT_RUNNING'
          ) {
            finish()
          } else {
            finish(error)
          }
        }
      }
      // dgram queues close behind an implicit bind from send(). A bind error
      // discards that queue without closing the handle or invoking callbacks;
      // retry close once the error event has cleared the native queue.
      socket.on('error', closeNative)
      closeNative()
    })
    return this.closePromise
  }

  address(): { port: number; address: string } | null {
    if (!this.socket) return null
    try {
      const a = this.socket.address()
      return { port: a.port, address: a.address }
    } catch {
      return null
    }
  }
}

export type UdpSocketFactory = (options: UdpSocketOptions) => UdpSocket
export const nodeUdpSocketFactory: UdpSocketFactory = (opts) =>
  new NodeUdpSocket(opts)

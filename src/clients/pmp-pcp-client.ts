import {
  buildExternalIpRequest,
  buildMappingRequest,
  buildPcpMapRequest,
  ipv4ToBuffer,
  isIpv4String,
  NATPMP_OPCODE_EXTERNAL_IP,
  NATPMP_OPCODE_MAP_TCP,
  NATPMP_OPCODE_MAP_UDP,
  NATPMP_PORT,
  NATPMP_VERSION,
  type NatPmpResponse,
  PCP_VERSION,
  type PcpMapResponse,
  parseNatPmpResponse,
  parsePcpMapResponse,
  peekPcpNonce,
} from '../codecs/index.js'
import { type ParseResult, parseErr, parseOk } from '../codecs/parse-result.js'
import { NatErrorCode } from '../errors.js'
import { natLogger } from '../logger.js'
import type {
  UdpRemoteInfo,
  UdpSocket,
  UdpSocketFactory,
} from '../net/udp-socket.js'
import type { NatTransportProtocol } from '../types.js'

const log = natLogger('pmp-pcp')

export const DEFAULT_REQUEST_TIMEOUT_MS = 1000
export const MAX_CONCURRENT_REQUESTS = 4

export interface PmpPcpClientOptions {
  udpFactory: UdpSocketFactory
  gatewayIp: string
  clientIp: Buffer // 16-byte IPv6 / v4-mapped form
  now?: () => number
}

export interface PmpPcpNetworkRoute {
  gatewayIp: string
  internalIp: string
}

interface PendingNonce {
  nonce: Buffer
  expiresAt: number
  resolve: (r: ParseResult<PcpMapResponse>) => void
}

interface PendingPmp {
  opcode: number
  resolve: (r: ParseResult<NatPmpResponse>) => void
  timer: NodeJS.Timeout
}

export interface PcpMapOptions {
  internalPort: number
  externalPort: number
  protocol: NatTransportProtocol
  ttl: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Existing mapping nonce for delete (ttl=0) requests per RFC 6887. */
  nonce?: Buffer
}

export class PmpPcpClient {
  private socket: UdpSocket | null = null
  private socketReady: Promise<UdpSocket> | null = null
  private cancelSocketReady: (() => void) | null = null
  private socketGeneration = 0
  private closing: Promise<void> | null = null
  private readonly udpFactory: UdpSocketFactory
  private gatewayIp: string
  private clientIp: Buffer
  private readonly now: () => number

  private readonly pendingNonces = new Map<string, PendingNonce>()
  private pendingPmp: PendingPmp | null = null // NAT-PMP has no correlator: serialize
  private nonceCleanupTimer: NodeJS.Timeout | null = null

  constructor(opts: PmpPcpClientOptions) {
    this.udpFactory = opts.udpFactory
    this.gatewayIp = opts.gatewayIp
    this.clientIp = Buffer.from(opts.clientIp)
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Point subsequent NAT-PMP / PCP traffic at a different gateway address.
   *
   * Prefer setNetworkRoute() after an interface change so PCP's embedded
   * client address changes with the gateway. This method remains for callers
   * that intentionally need a gateway-only update.
   *
   * Any requests already in flight retain the address they were sent to —
   * responses from the old gateway arriving after the switch will be dropped
   * by the rinfo filter. That's acceptable: a retry will hit the new address.
   */
  setGatewayIp(ip: string): void {
    // isIpv4String enforces both dotted-quad format (rejecting leading zeros
    // like 192.168.001.1) and the 0..255 octet range, replacing the previous
    // inline `\d{1,3}` regex + manual octet check. This is the same validator
    // used across the codec layer (ssdp-codec, http-client).
    if (!ip || !isIpv4String(ip)) {
      throw new RangeError(
        `PmpPcpClient.setGatewayIp: invalid IPv4 address: ${JSON.stringify(ip)}`
      )
    }
    this.gatewayIp = ip
  }

  /** Atomically update the gateway and PCP client address after a route change. */
  setNetworkRoute(route: PmpPcpNetworkRoute): void {
    if (
      !route.gatewayIp ||
      route.gatewayIp === '0.0.0.0' ||
      !isIpv4String(route.gatewayIp)
    ) {
      throw new RangeError(
        `PmpPcpClient.setNetworkRoute: invalid gateway IPv4 address: ${JSON.stringify(route.gatewayIp)}`
      )
    }
    if (
      !route.internalIp ||
      route.internalIp === '0.0.0.0' ||
      !isIpv4String(route.internalIp)
    ) {
      throw new RangeError(
        `PmpPcpClient.setNetworkRoute: invalid internal IPv4 address: ${JSON.stringify(route.internalIp)}`
      )
    }

    const clientIp = Buffer.concat([
      Buffer.alloc(10),
      Buffer.from([0xff, 0xff]),
      ipv4ToBuffer(route.internalIp),
    ])
    this.gatewayIp = route.gatewayIp
    this.clientIp = clientIp
  }

  async natPmpGetExternalIp(
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<ParseResult<Extract<NatPmpResponse, { kind: 'external-ip' }>>> {
    const resp = await this.sendNatPmp(
      buildExternalIpRequest(),
      NATPMP_OPCODE_EXTERNAL_IP,
      options
    )
    if (!resp.ok) return resp
    if (resp.value.kind !== 'external-ip') {
      return parseErr(NatErrorCode.ParseError, 'unexpected kind')
    }
    return parseOk(resp.value)
  }

  async natPmpMap(params: {
    protocol: NatTransportProtocol
    internalPort: number
    externalPort: number
    ttl: number
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<ParseResult<Extract<NatPmpResponse, { kind: 'mapping' }>>> {
    let req: Buffer
    try {
      req = buildMappingRequest(
        params.protocol,
        params.internalPort,
        params.externalPort,
        params.ttl
      )
    } catch (err) {
      return parseErr(NatErrorCode.ProtocolRejected, (err as Error).message)
    }
    const opcode =
      params.protocol === 'TCP' ? NATPMP_OPCODE_MAP_TCP : NATPMP_OPCODE_MAP_UDP
    const resp = await this.sendNatPmp(req, opcode, params)
    if (!resp.ok) return resp
    if (resp.value.kind !== 'mapping') {
      return parseErr(NatErrorCode.ParseError, 'unexpected kind')
    }
    return parseOk(resp.value)
  }

  async pcpMap(params: PcpMapOptions): Promise<ParseResult<PcpMapResponse>> {
    const generation = this.socketGeneration
    let socket: UdpSocket
    try {
      socket = await this.ensureSocket()
    } catch (error) {
      return parseErr(
        generation === this.socketGeneration
          ? NatErrorCode.GatewayUnreachable
          : NatErrorCode.NetworkChanged,
        (error as Error).message
      )
    }
    if (socket !== this.socket) {
      return parseErr(NatErrorCode.NetworkChanged, 'client closing')
    }
    if (this.pendingNonces.size >= MAX_CONCURRENT_REQUESTS) {
      return parseErr(
        NatErrorCode.ProtocolRejected,
        'too many pending PCP requests'
      )
    }
    let request: Buffer
    let nonce: Buffer
    try {
      const built = buildPcpMapRequest(
        params.protocol,
        params.internalPort,
        params.externalPort,
        params.ttl,
        this.clientIp,
        params.nonce
      )
      request = built.request
      nonce = built.nonce
    } catch (err) {
      return parseErr(NatErrorCode.ProtocolRejected, (err as Error).message)
    }
    const key = nonce.toString('hex')
    if (this.pendingNonces.has(key)) {
      return parseErr(
        NatErrorCode.ProtocolRejected,
        'pcp nonce already in flight'
      )
    }
    const timeoutMs = Math.max(
      1,
      params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    )

    return new Promise<ParseResult<PcpMapResponse>>((resolve) => {
      let onAbort: (() => void) | null = null

      const timer = setTimeout(() => {
        if (this.pendingNonces.get(key) === entry) {
          this.pendingNonces.delete(key)
          if (onAbort && params.signal) {
            params.signal.removeEventListener('abort', onAbort)
          }
          resolve(parseErr(NatErrorCode.Timeout, 'pcp request timed out'))
        }
      }, timeoutMs)
      timer.unref?.()

      const entry: PendingNonce = {
        nonce,
        expiresAt: this.now() + timeoutMs,
        resolve: (r) => {
          clearTimeout(timer)
          if (onAbort && params.signal) {
            params.signal.removeEventListener('abort', onAbort)
          }
          resolve(r)
        },
      }
      this.pendingNonces.set(key, entry)

      if (params.signal) {
        onAbort = () => {
          if (this.pendingNonces.get(key) === entry) {
            this.pendingNonces.delete(key)
            clearTimeout(timer)
            resolve(parseErr(NatErrorCode.Timeout, 'aborted'))
          }
        }
        if (params.signal.aborted) {
          onAbort()
          return
        }
        params.signal.addEventListener('abort', onAbort, { once: true })
      }

      socket.send(request, NATPMP_PORT, this.gatewayIp).catch((err) => {
        if (this.pendingNonces.get(key) === entry) {
          this.pendingNonces.delete(key)
          clearTimeout(timer)
          if (onAbort && params.signal) {
            params.signal.removeEventListener('abort', onAbort)
          }
          resolve(
            parseErr(NatErrorCode.GatewayUnreachable, (err as Error).message)
          )
        }
      })
    })
  }

  close(): Promise<void> {
    // Detach the old generation before awaiting I/O. New discovery may open
    // another socket while this one is still closing.
    const socket = this.socket
    this.socket = null
    this.socketReady = null
    this.socketGeneration++
    this.cancelSocketReady?.()
    this.cancelSocketReady = null
    // Reject all pending
    for (const [, pending] of this.pendingNonces) {
      pending.resolve(parseErr(NatErrorCode.NetworkChanged, 'client closing'))
    }
    this.pendingNonces.clear()
    if (this.pendingPmp) {
      clearTimeout(this.pendingPmp.timer)
      this.pendingPmp.resolve(
        parseErr(NatErrorCode.NetworkChanged, 'client closing')
      )
      this.pendingPmp = null
    }
    if (this.nonceCleanupTimer) {
      clearInterval(this.nonceCleanupTimer)
      this.nonceCleanupTimer = null
    }
    if (!socket) return this.closing ?? Promise.resolve()
    const closing = Promise.all([
      this.closing,
      Promise.resolve().then(() => socket.close()),
    ])
      .then(() => {})
      .finally(() => {
        if (this.closing === closing) this.closing = null
      })
    this.closing = closing
    return closing
  }

  private async sendNatPmp(
    request: Buffer,
    expectedOpcode: number,
    options: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<ParseResult<NatPmpResponse>> {
    const generation = this.socketGeneration
    let socket: UdpSocket
    try {
      socket = await this.ensureSocket()
    } catch (error) {
      return parseErr(
        generation === this.socketGeneration
          ? NatErrorCode.GatewayUnreachable
          : NatErrorCode.NetworkChanged,
        (error as Error).message
      )
    }
    if (socket !== this.socket) {
      return parseErr(NatErrorCode.NetworkChanged, 'client closing')
    }
    if (this.pendingPmp) {
      return parseErr(NatErrorCode.ProtocolRejected, 'natpmp request in flight')
    }
    const timeoutMs = Math.max(
      1,
      options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    )

    return new Promise<ParseResult<NatPmpResponse>>((resolve) => {
      let onAbort: (() => void) | null = null

      const cleanupAbort = () => {
        if (onAbort && options.signal) {
          options.signal.removeEventListener('abort', onAbort)
          onAbort = null
        }
      }

      const wrappedResolve = (r: ParseResult<NatPmpResponse>) => {
        cleanupAbort()
        resolve(r)
      }

      const timer = setTimeout(() => {
        if (this.pendingPmp === entry) {
          this.pendingPmp = null
          wrappedResolve(parseErr(NatErrorCode.Timeout, 'natpmp timeout'))
        }
      }, timeoutMs)
      timer.unref?.()

      const entry: PendingPmp = {
        opcode: expectedOpcode,
        resolve: wrappedResolve,
        timer,
      }
      this.pendingPmp = entry

      if (options.signal) {
        onAbort = () => {
          if (this.pendingPmp === entry) {
            clearTimeout(this.pendingPmp.timer)
            this.pendingPmp = null
            wrappedResolve(parseErr(NatErrorCode.Timeout, 'aborted'))
          }
        }
        if (options.signal.aborted) {
          onAbort()
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      socket.send(request, NATPMP_PORT, this.gatewayIp).catch((err) => {
        if (this.pendingPmp === entry) {
          clearTimeout(this.pendingPmp.timer)
          this.pendingPmp = null
          wrappedResolve(
            parseErr(NatErrorCode.GatewayUnreachable, (err as Error).message)
          )
        }
      })
    })
  }

  private ensureSocket(): Promise<UdpSocket> {
    if (this.socketReady) return this.socketReady
    const socket = this.udpFactory({ type: 'udp4' })
    this.socket = socket
    this.socketReady = this.bindSocket(socket)
    return this.socketReady
  }

  private async bindSocket(socket: UdpSocket): Promise<UdpSocket> {
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancelSocketReady = () => reject(new Error('client closing'))
    })
    try {
      await Promise.race([
        Promise.resolve().then(() => {
          if (this.socket !== socket) throw new Error('client closing')
          return socket.bind(0)
        }),
        cancelled,
      ])
      if (this.socket !== socket) throw new Error('client closing')
      this.cancelSocketReady = null
      socket.onMessage((msg, rinfo) => {
        if (this.socket === socket) this.onMessage(msg, rinfo)
      })
      this.nonceCleanupTimer = setInterval(
        () => this.cleanupExpiredNonces(),
        1000
      )
      this.nonceCleanupTimer.unref?.()
      return socket
    } catch (error) {
      // A failed bind must not poison all future requests with a cached
      // rejection. A detached socket is already owned by close().
      if (this.socket === socket) {
        this.socket = null
        this.socketReady = null
        this.cancelSocketReady = null
        try {
          await socket.close()
        } catch (closeError) {
          log.warn(
            { err: closeError },
            'failed to close UDP socket after bind failure'
          )
        }
      }
      throw error
    }
  }

  private onMessage(msg: Buffer, rinfo: UdpRemoteInfo): void {
    // CRITICAL: pre-filter on source IP BEFORE consuming any pending state.
    // Otherwise a bogus packet from a wrong address would consume pendingPmp
    // / pendingNonces and resolve the promise with a parse error, instead of
    // letting the legitimate response (which arrives later) succeed.
    if (rinfo.address !== this.gatewayIp) {
      log.debug(
        { expected: this.gatewayIp, from: rinfo.address },
        'ignoring packet from non-gateway'
      )
      return
    }
    if (msg.length === 0) return
    const version = msg[0]
    if (version === PCP_VERSION) {
      // PCP response — correlate via nonce
      const nonceBytes = peekPcpNonce(msg)
      if (!nonceBytes) {
        log.debug({ len: msg.length }, 'pcp response too short')
        return
      }
      const key = nonceBytes.toString('hex')
      const pending = this.pendingNonces.get(key)
      if (!pending) {
        log.debug(
          { nonce: key, from: rinfo.address },
          'pcp response with unknown nonce — discarded'
        )
        return
      }
      this.pendingNonces.delete(key)
      const parsed = parsePcpMapResponse(
        msg,
        pending.nonce,
        rinfo.address,
        this.gatewayIp
      )
      pending.resolve(parsed)
    } else if (version === NATPMP_VERSION) {
      // NAT-PMP response
      if (!this.pendingPmp) {
        log.debug(
          { from: rinfo.address },
          'natpmp response with no pending request — discarded'
        )
        return
      }
      const p = this.pendingPmp
      this.pendingPmp = null
      clearTimeout(p.timer)
      const parsed = parseNatPmpResponse(
        msg,
        p.opcode,
        rinfo.address,
        this.gatewayIp
      )
      p.resolve(parsed)
    }
    // Other versions silently ignored
  }

  private cleanupExpiredNonces(): void {
    const now = this.now()
    for (const [key, entry] of this.pendingNonces) {
      if (entry.expiresAt < now) {
        this.pendingNonces.delete(key)
        entry.resolve(parseErr(NatErrorCode.Timeout, 'pcp nonce expired'))
      }
    }
  }
}

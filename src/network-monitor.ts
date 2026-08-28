import { natLogger } from './logger.js'
import { createCachedNetworkRouteResolver } from './network-route.js'

const log = natLogger('network-monitor')

export interface NetworkSnapshot {
  gatewayIp: string // Best-effort default gateway ('' if unknown)
  internalIp: string // Best-effort internal IP
  hash: string // Compared for equality across polls
}

export interface NetworkMonitorOptions {
  intervalMs?: number
  stableRounds?: number // Consecutive identical snapshots before emitting a change
  snapshotFn?: () => NetworkSnapshot // Injectable for tests
  verifiedSnapshotFn?: () => Promise<NetworkSnapshot>
}

export const DEFAULT_INTERVAL_MS = 5000
export const DEFAULT_STABLE_ROUNDS = 2

export type NetworkChangeListener = (snapshot: NetworkSnapshot) => void

export class NetworkMonitor {
  private readonly intervalMs: number
  private readonly stableRounds: number
  private readonly snapshotFn: () => NetworkSnapshot
  private readonly verifiedSnapshotFn: () => Promise<NetworkSnapshot>
  private timer: NodeJS.Timeout | null = null
  private listeners = new Set<NetworkChangeListener>()
  private established: NetworkSnapshot | null = null
  private candidate: NetworkSnapshot | null = null
  private candidateCount = 0

  constructor(opts: NetworkMonitorOptions = {}) {
    this.intervalMs = Math.max(500, opts.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.stableRounds = Math.max(1, opts.stableRounds ?? DEFAULT_STABLE_ROUNDS)
    const defaultSource = createDefaultSnapshotSource()
    this.snapshotFn = opts.snapshotFn ?? defaultSource.snapshot
    this.verifiedSnapshotFn =
      opts.verifiedSnapshotFn ??
      (opts.snapshotFn
        ? async () => this.snapshotFn()
        : defaultSource.verifiedSnapshot)
  }

  onChange(listener: NetworkChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.timer) return
    this.poll()
    this.timer = setInterval(() => this.poll(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  snapshot(): NetworkSnapshot {
    try {
      return this.snapshotFn()
    } catch (err) {
      log.warn({ err }, 'snapshot failed')
      return { gatewayIp: '', internalIp: '', hash: '' }
    }
  }

  async verifiedSnapshot(): Promise<NetworkSnapshot> {
    try {
      return await this.verifiedSnapshotFn()
    } catch (err) {
      log.warn({ err }, 'verified snapshot failed; using current snapshot')
      return this.snapshot()
    }
  }

  private poll(): void {
    let snap: NetworkSnapshot
    try {
      snap = this.snapshotFn()
    } catch (err) {
      log.warn({ err }, 'snapshot failed')
      return
    }
    if (!this.established) {
      this.established = snap
      return
    }
    if (snap.hash === this.established.hash) {
      this.candidate = null
      this.candidateCount = 0
      return
    }
    if (this.candidate && this.candidate.hash === snap.hash) {
      this.candidateCount++
    } else {
      this.candidate = snap
      this.candidateCount = 1
    }
    if (this.candidateCount >= this.stableRounds) {
      this.established = snap
      this.candidate = null
      this.candidateCount = 0
      for (const l of this.listeners) {
        try {
          l(snap)
        } catch (err) {
          log.warn({ err }, 'listener threw')
        }
      }
    }
  }
}

function createDefaultSnapshotSource(): {
  snapshot: () => NetworkSnapshot
  verifiedSnapshot: () => Promise<NetworkSnapshot>
} {
  const resolveRoute = createCachedNetworkRouteResolver()
  const toSnapshot = (route: {
    gatewayIp: string
    internalIp: string
  }): NetworkSnapshot => {
    return {
      gatewayIp: route.gatewayIp,
      internalIp: route.internalIp,
      hash: `${route.gatewayIp}|${route.internalIp}`,
    }
  }
  return {
    snapshot: () => toSnapshot(resolveRoute()),
    verifiedSnapshot: async () => toSnapshot(await resolveRoute.verified()),
  }
}

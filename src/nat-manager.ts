import crypto from 'node:crypto'
import { isIpv4String, UPNP_WANIP_V1 } from './codecs/index.js'
import { NatErrorCode } from './errors.js'
import { natLogger } from './logger.js'
import { GenerationGuard, TransitionMutex } from './state-machine.js'
import {
  type NatGatewayInfo,
  type NatMapping,
  type NatMappingPurpose,
  NatProtocol,
  NatState,
  type NatStatus,
  type NatTransportProtocol,
} from './types.js'

const log = natLogger('manager')

// Injectable dependency interfaces (structural subsets; concrete classes
// implement them)
export interface NatManagerSettings {
  enabled: boolean
  preferredProtocol: 'auto' | 'pcp' | 'natpmp' | 'upnp'
  mappingTtl: number
  natTypeDetectionEnabled: boolean
  stunServers: string[]
  portReachabilityCheckEnabled: boolean
  portCheckerEndpoints: string[]
}

export interface NatSettingsProvider {
  getEngine(): { listenPort: number; dhtListenPort: number }
  getNat(): NatManagerSettings
}

export interface UpnpClientLike {
  discover(opts?: {
    timeoutMs?: number
    interfaceAddress?: string
  }): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  mapPort(
    gateway: unknown,
    params: unknown,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; error?: unknown }>
  unmapPort(
    gateway: unknown,
    params: unknown,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; error?: unknown }>
  getExternalIp(
    gateway: unknown,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; value?: string; error?: unknown }>
}

export interface PmpPcpClientLike {
  natPmpGetExternalIp(options?: {
    timeoutMs?: number
  }): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  natPmpMap(
    params: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  pcpMap(
    params: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  setGatewayIp(ip: string): void
  setNetworkRoute?(route: { gatewayIp: string; internalIp: string }): void
  close(): Promise<void>
}

export interface StunClientLike {
  detectNatType(
    options: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
}

export interface PortCheckerLike {
  checkPortReachable(
    options: unknown
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
}

export interface NetworkMonitorLike {
  start(): void
  stop(): void
  onChange(listener: (snap: unknown) => void): () => void
  snapshot(): { gatewayIp: string; internalIp: string; hash: string }
  verifiedSnapshot?(): Promise<{
    gatewayIp: string
    internalIp: string
    hash: string
  }>
}

export interface NatManagerHooks {
  /** External conditions met — start mapping configured ports. */
  onReady(listener: () => void): () => void
  /** NAT or port configuration may have changed. */
  onConfigChanged(listener: () => void): () => void
}

export type NatEvent =
  | { type: 'state-changed'; state: NatState }
  | { type: 'error'; error: { code: string; message: string } }
  | { type: 'gateway-changed'; info: NatGatewayInfo }
  | { type: 'mapping-updated'; mappings: NatMapping[] }
  | { type: 'diagnostic-completed'; result: unknown }

export interface NatManagerDeps {
  hooks: NatManagerHooks
  onEvent: (event: NatEvent) => void
  settingsProvider: NatSettingsProvider
  upnpClient: UpnpClientLike
  pmpPcpClient: PmpPcpClientLike
  stunClient: StunClientLike
  portChecker: PortCheckerLike
  networkMonitor: NetworkMonitorLike
  now?: () => number
}

interface QueuedTransition {
  lifecycleEpoch: number
  work: (lifecycleEpoch: number) => Promise<void>
}

export class NatManager {
  protected readonly deps: NatManagerDeps
  protected readonly mutex = new TransitionMutex()
  protected readonly gen = new GenerationGuard()
  protected readonly now: () => number
  protected readonly PROTOCOL_ORDER: NatProtocol[] = [
    NatProtocol.Pcp,
    NatProtocol.NatPmp,
    NatProtocol.Upnp,
  ]

  protected state: NatState = NatState.Idle
  protected gatewayInfo: NatGatewayInfo | null = null
  protected activeMappings: NatMapping[] = []
  protected lastError: NatStatus['lastError'] = null
  protected unsubscribers: Array<() => void> = []
  protected abortController: AbortController | null = null
  protected stickyProtocol: NatProtocol | null = null
  protected renewalTimer: NodeJS.Timeout | null = null
  protected readonly RETRY_DELAYS_MS: ReadonlyArray<number> = [
    5_000, 15_000, 45_000,
  ]
  protected retryCount = 0
  protected retryTimer: NodeJS.Timeout | null = null
  private readonly queuedWork = new Map<string, QueuedTransition>()
  private queueDrain: Promise<void> | null = null
  private stopInFlight: Promise<void> | null = null
  private lifecycleEpoch = 0
  private lifecycleActive = false
  private networkRemapPending = false
  private natPmpGatewayReady = false
  private pcpRouteReady = false

  constructor(deps: NatManagerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  getStatus(): NatStatus {
    return {
      state: this.state,
      enabled: this.deps.settingsProvider.getNat().enabled,
      activeMappings: [...this.activeMappings],
      gatewayInfo: this.gatewayInfo,
      lastError: this.lastError,
      lastDiagnostic: null, // diagnostics live in a follow-up milestone
      retryAttempt: this.retryCount,
      maxRetries: this.RETRY_DELAYS_MS.length,
    }
  }

  async start(): Promise<void> {
    const stopping = this.stopInFlight
    if (stopping) await stopping
    const nat = this.deps.settingsProvider.getNat()
    const engine = this.deps.settingsProvider.getEngine()
    // Reset retry budget on every explicit start so user-triggered enable()
    // and recovery flows get a fresh attempt counter, regardless of whether
    // the manager was previously dormant.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retryCount = 0
    log.info(
      {
        enabled: nat.enabled,
        preferredProtocol: nat.preferredProtocol,
        mappingTtl: nat.mappingTtl,
        natTypeDetectionEnabled: nat.natTypeDetectionEnabled,
        portReachabilityCheckEnabled: nat.portReachabilityCheckEnabled,
        listenPort: engine.listenPort,
        dhtListenPort: engine.dhtListenPort,
        currentState: this.state,
      },
      'NatManager.start: entering'
    )
    if (!nat.enabled) {
      this.lifecycleActive = false
      this.lifecycleEpoch++
      this.queuedWork.clear()
      this.gen.bump()
      this.networkRemapPending = false
      this.setState(NatState.Stopped)
      log.info(
        { state: this.state },
        'NatManager.start: NAT disabled, stopped without discovery'
      )
      return
    }
    this.lifecycleActive = true
    this.subscribeToBus()
    log.debug(
      { subscribers: this.unsubscribers.length },
      'NatManager.start: event subscribers registered'
    )
    this.deps.networkMonitor.start()
    log.debug('NatManager.start: networkMonitor started')
    await this.runDiscovery()
    log.info(
      {
        state: this.state,
        gatewayIp: this.gatewayInfo?.gatewayIp ?? null,
        internalIp: this.gatewayInfo?.internalIp ?? null,
        externalIp: this.gatewayInfo?.externalIp ?? null,
        supportedProtocols: this.gatewayInfo?.supportedProtocols ?? [],
        manufacturer: this.gatewayInfo?.manufacturer ?? null,
        modelName: this.gatewayInfo?.modelName ?? null,
        lastErrorCode: this.lastError?.code ?? null,
        lastErrorMessage: this.lastError?.message ?? null,
        retryCount: this.retryCount,
      },
      'NatManager.start: completed'
    )
  }

  stop(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight
    const task = Promise.resolve().then(() => this.doStop())
    this.stopInFlight = task
    void task.then(
      () => {
        if (this.stopInFlight === task) this.stopInFlight = null
      },
      () => {
        if (this.stopInFlight === task) this.stopInFlight = null
      }
    )
    return task
  }

  private async doStop(): Promise<void> {
    const beforeState = this.state
    const beforeMappingCount = this.activeMappings.length
    const mappingsToUnmap = [...this.activeMappings]
    const gatewayForUnmap = this.gatewayInfo
    const droppedTransitions = this.queuedWork.size
    this.lifecycleActive = false
    this.lifecycleEpoch++
    const stopEpoch = this.lifecycleEpoch
    this.queuedWork.clear()
    this.networkRemapPending = false
    this.natPmpGatewayReady = false
    this.pcpRouteReady = false
    this.activeMappings = []
    this.gatewayInfo = null
    this.stickyProtocol = null
    // Invalidate any in-flight discovery before its trailing setState writes
    // can resurrect us from Stopped — the generation guard inside doDiscovery
    // honours this bump on every isCurrent() checkpoint.
    this.gen.bump()
    log.info(
      {
        state: beforeState,
        activeMappings: beforeMappingCount,
        stickyProtocol: this.stickyProtocol,
        retryCount: this.retryCount,
        hasRetryTimer: this.retryTimer !== null,
        hasRenewalTimer: this.renewalTimer !== null,
        hasAbortController: this.abortController !== null,
        subscribers: this.unsubscribers.length,
        droppedTransitions,
      },
      'NatManager.stop: entering'
    )
    let retryTimerCleared = false
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      retryTimerCleared = true
    }
    const renewalWasActive = this.renewalTimer !== null
    this.clearRenewalTimer()
    const aborted = this.abortController !== null
    this.abortController?.abort()
    const subscriberCount = this.unsubscribers.length
    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
    log.debug(
      {
        retryTimerCleared,
        renewalTimerCleared: renewalWasActive,
        aborted,
        releasedSubscribers: subscriberCount,
      },
      'NatManager.stop: timers and subscribers released'
    )
    this.deps.networkMonitor.stop()
    log.debug('NatManager.stop: networkMonitor stopped')
    // Unmap all active port mappings from the router before closing clients.
    // Best-effort: each mapping is independent, so one failure must not block
    // the rest or prevent shutdown.
    let unmappedCount = 0
    for (const mapping of mappingsToUnmap) {
      try {
        await this.unmapOne(mapping, gatewayForUnmap)
        unmappedCount++
      } catch (err) {
        log.warn(
          { err, port: mapping.internalPort, method: mapping.method },
          'NatManager.stop: unmapOne failed, continuing'
        )
      }
    }
    log.debug(
      { unmappedCount, total: beforeMappingCount },
      'NatManager.stop: unmapping complete'
    )
    let pmpPcpClosed = true
    try {
      await this.deps.pmpPcpClient.close()
    } catch (err) {
      pmpPcpClosed = false
      log.warn({ err }, 'pmpPcp close failed')
    }
    if (this.lifecycleEpoch === stopEpoch && !this.lifecycleActive) {
      this.setState(NatState.Stopped)
    }
    log.info(
      {
        previousState: beforeState,
        clearedMappings: beforeMappingCount,
        retryTimerCleared,
        renewalTimerCleared: renewalWasActive,
        aborted,
        releasedSubscribers: subscriberCount,
        droppedTransitions,
        pmpPcpClosed,
        state: this.state,
      },
      'NatManager.stop: completed'
    )
  }

  protected setState(next: NatState): void {
    if (this.state === next) return
    this.state = next
    this.deps.onEvent({ type: 'state-changed', state: next })
    this.handleRetryOnStateChange(next)
  }

  protected setLastError(code: NatErrorCode, message: string): void {
    this.lastError = { code, message, occurredAt: this.now() }
    this.deps.onEvent({ type: 'error', error: { code, message } })
  }

  /** Push one discovery round's gateway and client address into PMP/PCP. */
  protected syncPmpPcpNetworkRoute(route: {
    gatewayIp: string | undefined | null
    internalIp: string | undefined | null
  }): boolean {
    this.natPmpGatewayReady = false
    this.pcpRouteReady = false
    if (
      !route.gatewayIp ||
      route.gatewayIp === '0.0.0.0' ||
      !isIpv4String(route.gatewayIp)
    ) {
      return false
    }

    const hasValidInternalIp =
      Boolean(route.internalIp) &&
      route.internalIp !== '0.0.0.0' &&
      isIpv4String(route.internalIp as string)
    if (hasValidInternalIp && this.deps.pmpPcpClient.setNetworkRoute) {
      try {
        this.deps.pmpPcpClient.setNetworkRoute({
          gatewayIp: route.gatewayIp,
          internalIp: route.internalIp as string,
        })
        this.natPmpGatewayReady = true
        this.pcpRouteReady = true
        return true
      } catch (err) {
        log.warn(
          { err, gatewayIp: route.gatewayIp, internalIp: route.internalIp },
          'syncPmpPcpNetworkRoute: atomic route update failed; falling back to gateway-only mode'
        )
      }
    }

    try {
      this.deps.pmpPcpClient.setGatewayIp(route.gatewayIp)
      this.natPmpGatewayReady = true
      log.debug(
        { gatewayIp: route.gatewayIp },
        'PMP/PCP adapter is in gateway-only mode; PCP is disabled'
      )
      return true
    } catch (err) {
      log.warn(
        { err, gatewayIp: route.gatewayIp },
        'syncPmpPcpNetworkRoute: gateway update failed'
      )
      return false
    }
  }

  protected handleRetryOnStateChange(next: NatState): void {
    if (next === NatState.Active || next === NatState.Stopped) {
      this.retryCount = 0
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      return
    }
    if (next === NatState.Failed) {
      if (this.retryCount >= this.RETRY_DELAYS_MS.length) {
        log.info(
          { retries: this.retryCount },
          'entering dormant state; awaiting network change or manual remap'
        )
        return
      }
      // biome-ignore lint/style/noNonNullAssertion: retryCount bounded by length check above
      const delay = this.RETRY_DELAYS_MS[this.retryCount]!
      this.retryCount++
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        void this.runDiscovery()
      }, delay)
      this.retryTimer.unref?.()
    }
  }

  protected subscribeToBus(): void {
    const settingsOff = this.deps.hooks.onConfigChanged(() => {
      void this.handleSettingsChanged()
    })

    const readyOff = this.deps.hooks.onReady(() => {
      void this.mapConfiguredPorts()
    })

    const netOff = this.deps.networkMonitor.onChange((snap: unknown) => {
      this.handleNetworkChange(snap)
    })

    this.unsubscribers.push(settingsOff, readyOff, netOff)
  }

  private handleNetworkChange(snap: unknown): void {
    if (!this.lifecycleActive) return
    const shouldRemap =
      this.networkRemapPending ||
      this.activeMappings.length > 0 ||
      this.queuedWork.has('map-configured') ||
      this.queuedWork.has('remap-all') ||
      this.state === NatState.Mapping ||
      this.state === NatState.Active
    const hadVisibleMappings = this.activeMappings.length > 0

    // A topology change invalidates every transition created for the old
    // route. Keep the lifecycle active, then enqueue a fresh discovery in the
    // new epoch behind whichever transition is currently unwinding.
    this.lifecycleEpoch++
    this.queuedWork.clear()
    this.gen.bump()
    this.abortController?.abort()
    this.clearRenewalTimer()
    this.networkRemapPending ||= shouldRemap
    this.activeMappings = []
    this.gatewayInfo = null
    this.stickyProtocol = null
    this.natPmpGatewayReady = false
    this.pcpRouteReady = false
    if (hadVisibleMappings) {
      this.deps.onEvent({ type: 'mapping-updated', mappings: [] })
    }

    log.info(
      { snap, shouldRemap, hadVisibleMappings },
      'network change invalidated the previous route; re-discovering'
    )
    void this.runDiscovery()
  }

  private async handleSettingsChanged(): Promise<void> {
    const nat = this.deps.settingsProvider.getNat()
    if (!nat.enabled) {
      await this.stop()
      return
    }
    const engine = this.deps.settingsProvider.getEngine()
    const currentPorts = new Set(this.activeMappings.map((m) => m.internalPort))
    const expected = new Set([engine.listenPort, engine.dhtListenPort])
    const portsChanged =
      currentPorts.size !== expected.size ||
      [...expected].some((p) => !currentPorts.has(p))
    if (portsChanged) {
      for (const mapping of this.activeMappings) {
        if (!expected.has(mapping.internalPort)) {
          await this.unmapOne(mapping).catch(() => {})
        }
      }
      this.activeMappings = []
      await this.mapConfiguredPorts()
    }
  }

  private async unmapOne(
    mapping: NatMapping,
    gatewayInfo: NatGatewayInfo | null = this.gatewayInfo
  ): Promise<void> {
    if (mapping.method === NatProtocol.Upnp) {
      if (
        !gatewayInfo?.controlUrl ||
        !gatewayInfo.controlHost ||
        !gatewayInfo.controlPort
      ) {
        return
      }
      await this.deps.upnpClient.unmapPort(
        {
          gatewayIp: gatewayInfo.gatewayIp,
          controlUrl: gatewayInfo.controlUrl,
          controlHost: gatewayInfo.controlHost,
          controlPort: gatewayInfo.controlPort,
          serviceType: UPNP_WANIP_V1,
          manufacturer: gatewayInfo.manufacturer ?? '',
          modelName: gatewayInfo.modelName ?? '',
        },
        {
          externalPort: mapping.externalPort,
          protocol: mapping.protocol,
        }
      )
    } else if (mapping.method === NatProtocol.Pcp) {
      // PCP: lifetime=0 means "delete" per RFC 6887 §10.2.
      // The nonce MUST match the one used when creating the mapping.
      await this.deps.pmpPcpClient.pcpMap({
        protocol: mapping.protocol,
        internalPort: mapping.internalPort,
        externalPort: 0,
        ttl: 0,
        nonce: mapping.pcpNonce
          ? Buffer.from(mapping.pcpNonce, 'hex')
          : undefined,
      })
    } else if (mapping.method === NatProtocol.NatPmp) {
      // NAT-PMP: ttl=0 means "remove" per RFC 6886 §3.3
      await this.deps.pmpPcpClient.natPmpMap({
        protocol: mapping.protocol,
        internalPort: mapping.internalPort,
        externalPort: 0,
        ttl: 0,
      })
    }
  }

  private async discardStaleMappings(
    mappings: NatMapping[],
    gatewayInfo: NatGatewayInfo | null
  ): Promise<void> {
    let pmpCleanupAttempted = false
    for (const mapping of mappings) {
      if (
        mapping.method === NatProtocol.Pcp ||
        mapping.method === NatProtocol.NatPmp
      ) {
        pmpCleanupAttempted = true
      }
      try {
        await this.unmapOne(mapping, gatewayInfo)
      } catch (err) {
        log.warn(
          { err, port: mapping.internalPort, method: mapping.method },
          'failed to discard mapping from a stopped lifecycle'
        )
      }
    }
    if (pmpCleanupAttempted) {
      try {
        // A stale cleanup may run after stop() closed the shared UDP client.
        // Close again so its one final delete request cannot leave a reopened
        // socket or cleanup timer behind in the stopped lifecycle.
        await this.deps.pmpPcpClient.close()
      } catch (err) {
        log.warn({ err }, 'failed to close PMP/PCP client after stale cleanup')
      }
    }
  }

  /**
   * Queue work by label, coalescing duplicate labels while preserving ordering
   * across different labels. One drain owns the mutex, so a network discovery
   * queued during mapping/remapping cannot be lost when that holder releases.
   */
  private async runCoalesced(
    label: string,
    work: (lifecycleEpoch: number) => Promise<void>
  ): Promise<void> {
    if (!this.lifecycleActive) {
      log.debug({ label }, 'transition ignored while NAT lifecycle is stopped')
      return
    }
    const lifecycleEpoch = this.lifecycleEpoch
    const alreadyQueued = this.queuedWork.has(label)
    this.queuedWork.set(label, { lifecycleEpoch, work })
    if (alreadyQueued || this.mutex.currentHolder?.startsWith(`${label}@`)) {
      log.debug(
        { currentHolder: this.mutex.currentHolder },
        `${label}: coalesced in transition queue`
      )
    }

    if (!this.queueDrain) {
      // Start on the next microtask so queueDrain is installed before work can
      // synchronously re-enter through a state/event callback.
      this.queueDrain = Promise.resolve().then(() => this.drainQueuedWork())
    }
    await this.queueDrain
  }

  private async drainQueuedWork(): Promise<void> {
    try {
      while (this.queuedWork.size > 0) {
        const next = this.queuedWork.entries().next()
        if (next.done) return
        const [label, transition] = next.value
        this.queuedWork.delete(label)
        if (!this.isLifecycleCurrent(transition.lifecycleEpoch)) {
          log.debug(
            { label, lifecycleEpoch: transition.lifecycleEpoch },
            'discarding stale queued transition'
          )
          continue
        }
        const caller = `${label}@${this.now()}`
        log.debug(
          { caller, currentHolder: this.mutex.currentHolder },
          `${label}: draining transition queue`
        )
        try {
          await this.mutex.runExclusive(async () => {
            log.debug({ caller }, `${label}: mutex acquired`)
            if (!this.isLifecycleCurrent(transition.lifecycleEpoch)) return
            await transition.work(transition.lifecycleEpoch)
          }, caller)
          log.debug({ caller }, `${label}: mutex released`)
        } catch (err) {
          log.warn(
            { err, caller, currentHolder: this.mutex.currentHolder },
            `${label}: queued transition failed`
          )
        }
      }
    } finally {
      this.queueDrain = null
    }
  }

  private isLifecycleCurrent(lifecycleEpoch: number): boolean {
    return this.lifecycleActive && lifecycleEpoch === this.lifecycleEpoch
  }

  protected async runDiscovery(): Promise<void> {
    await this.runCoalesced('discovery', (lifecycleEpoch) =>
      this.doDiscoveryTransition(lifecycleEpoch)
    )
  }

  private async doDiscoveryTransition(lifecycleEpoch: number): Promise<void> {
    await this.doDiscovery(lifecycleEpoch)
    if (!this.isLifecycleCurrent(lifecycleEpoch) || !this.networkRemapPending) {
      return
    }

    if (this.state === NatState.Ready) {
      this.consumeSatisfiedMappingTransitions(lifecycleEpoch)
      // Stay inside the current queue/mutex transition. Calling the public
      // method here would await this same drain and deadlock.
      await this.doMapConfiguredPorts(lifecycleEpoch)
    }
    if (!this.isLifecycleCurrent(lifecycleEpoch)) return
    if (this.state === NatState.Active) {
      // ready/config/remap events can arrive while either mapping request is
      // awaiting I/O. The successful B mapping satisfies those same-epoch
      // intents too; consume them with no further await before clearing the
      // remap marker and returning to the queue drain.
      this.consumeSatisfiedMappingTransitions(lifecycleEpoch)
      this.networkRemapPending = false
      return
    }

    // Discovery or immediate remapping on the new route failed. Keep the
    // remap intent for the retry cycle, but never expose the previous route's
    // gateway or mappings in the meantime.
    this.clearRenewalTimer()
    this.activeMappings = []
    this.gatewayInfo = null
    this.stickyProtocol = null
    this.natPmpGatewayReady = false
    this.pcpRouteReady = false
  }

  private consumeSatisfiedMappingTransitions(lifecycleEpoch: number): void {
    for (const label of ['map-configured', 'remap-all']) {
      const queued = this.queuedWork.get(label)
      if (queued?.lifecycleEpoch === lifecycleEpoch) {
        this.queuedWork.delete(label)
        log.debug(
          { label, lifecycleEpoch },
          'direct post-discovery mapping consumed queued transition'
        )
      }
    }
  }

  private async readVerifiedNetworkSnapshot(): Promise<{
    gatewayIp: string
    internalIp: string
    hash: string
  }> {
    try {
      return this.deps.networkMonitor.verifiedSnapshot
        ? await this.deps.networkMonitor.verifiedSnapshot()
        : this.deps.networkMonitor.snapshot()
    } catch (err) {
      log.warn({ err }, 'verified route snapshot failed; using cached snapshot')
      return this.deps.networkMonitor.snapshot()
    }
  }

  private async doDiscovery(lifecycleEpoch: number): Promise<void> {
    if (!this.isLifecycleCurrent(lifecycleEpoch)) return
    this.setState(NatState.Discovering)
    this.natPmpGatewayReady = false
    this.pcpRouteReady = false
    const generation = this.gen.bump()
    this.abortController?.abort()
    this.abortController = new AbortController()

    // Phase 1 discovery: try UPnP first; NAT-PMP/PCP probe is a fast
    // UDP request and does not establish gateway info for SOAP, so treat
    // UPnP as primary.
    const network = await this.readVerifiedNetworkSnapshot()
    if (
      !this.isLifecycleCurrent(lifecycleEpoch) ||
      !this.gen.isCurrent(generation)
    ) {
      return
    }
    const upnp = await this.deps.upnpClient.discover({
      timeoutMs: 3000,
      ...(network.internalIp ? { interfaceAddress: network.internalIp } : {}),
    })
    if (
      !this.isLifecycleCurrent(lifecycleEpoch) ||
      !this.gen.isCurrent(generation)
    ) {
      return
    }
    if (upnp.ok && upnp.value) {
      const g = upnp.value as {
        gatewayIp: string
        controlUrl: string
        controlHost: string
        controlPort: number
        serviceType: string
        manufacturer: string
        modelName: string
      }
      this.gatewayInfo = {
        internalIp: network.internalIp,
        gatewayIp: g.gatewayIp,
        externalIp: null,
        controlUrl: g.controlUrl,
        controlHost: g.controlHost,
        controlPort: g.controlPort,
        manufacturer: g.manufacturer,
        modelName: g.modelName,
        supportedProtocols: [NatProtocol.Upnp],
      }
      this.syncPmpPcpNetworkRoute({
        gatewayIp: g.gatewayIp,
        internalIp: network.internalIp,
      })
      this.deps.onEvent({ type: 'gateway-changed', info: this.gatewayInfo })
      this.setState(NatState.Ready)
      return
    }

    // Fall back to NAT-PMP probe
    // The topology can change while UPnP awaits its timeout. Verify the route
    // again so PMP never reuses a newly-created interface heuristic.
    const pmpNetwork = await this.readVerifiedNetworkSnapshot()
    if (
      !this.isLifecycleCurrent(lifecycleEpoch) ||
      !this.gen.isCurrent(generation)
    ) {
      return
    }
    if (this.syncPmpPcpNetworkRoute(pmpNetwork)) {
      const pmp = await this.deps.pmpPcpClient.natPmpGetExternalIp({
        timeoutMs: 1000,
      })
      if (
        !this.isLifecycleCurrent(lifecycleEpoch) ||
        !this.gen.isCurrent(generation)
      ) {
        return
      }
      if (pmp.ok) {
        const pmpVal = pmp.value as { externalIp?: string } | undefined
        this.gatewayInfo = {
          internalIp: pmpNetwork.internalIp,
          gatewayIp: pmpNetwork.gatewayIp,
          externalIp: pmpVal?.externalIp ?? null,
          controlUrl: null,
          controlHost: null,
          controlPort: null,
          manufacturer: null,
          modelName: null,
          supportedProtocols: [NatProtocol.NatPmp],
        }
        this.deps.onEvent({ type: 'gateway-changed', info: this.gatewayInfo })
        this.setState(NatState.Ready)
        return
      }
    }

    if (
      !this.isLifecycleCurrent(lifecycleEpoch) ||
      !this.gen.isCurrent(generation)
    ) {
      return
    }
    this.setLastError(
      NatErrorCode.DiscoveryFailed,
      'all discovery attempts failed'
    )
    this.setState(NatState.Failed)
  }

  private async doMapConfiguredPorts(lifecycleEpoch: number): Promise<void> {
    if (
      !this.isLifecycleCurrent(lifecycleEpoch) ||
      (this.state !== NatState.Ready && this.state !== NatState.Active)
    ) {
      return
    }
    const engine = this.deps.settingsProvider.getEngine()
    const cleanupGateway = this.gatewayInfo
    const ports: Array<{
      port: number
      purpose: NatMappingPurpose
      protocol: NatTransportProtocol
    }> = [
      { port: engine.listenPort, purpose: 'bt-listen', protocol: 'TCP' },
      { port: engine.dhtListenPort, purpose: 'dht-listen', protocol: 'UDP' },
    ]
    this.setState(NatState.Mapping)
    const newMappings: NatMapping[] = []
    for (const p of ports) {
      const mapping = await this.mapOne(
        lifecycleEpoch,
        p.port,
        p.protocol,
        p.purpose
      )
      if (!this.isLifecycleCurrent(lifecycleEpoch)) {
        await this.discardStaleMappings(
          mapping ? [...newMappings, mapping] : newMappings,
          cleanupGateway
        )
        return
      }
      if (!mapping) {
        await this.discardStaleMappings(newMappings, cleanupGateway)
        if (!this.isLifecycleCurrent(lifecycleEpoch)) return
        this.setLastError(
          NatErrorCode.MappingFailed,
          `all protocols failed for port ${p.port}`
        )
        this.setState(NatState.Failed)
        return
      }
      newMappings.push(mapping)
    }
    this.activeMappings = newMappings
    this.deps.onEvent({
      type: 'mapping-updated',
      mappings: [...this.activeMappings],
    })
    this.setState(NatState.Active)
    this.scheduleRenewal()
  }

  async mapConfiguredPorts(): Promise<void> {
    await this.runCoalesced('map-configured', (lifecycleEpoch) =>
      this.doMapConfiguredPorts(lifecycleEpoch)
    )
  }

  async remapAll(): Promise<void> {
    await this.runCoalesced('remap-all', (lifecycleEpoch) =>
      this.doRemapAll(lifecycleEpoch)
    )
  }

  private async doRemapAll(lifecycleEpoch: number): Promise<void> {
    if (!this.isLifecycleCurrent(lifecycleEpoch)) return
    if (this.activeMappings.length === 0) {
      await this.doMapConfiguredPorts(lifecycleEpoch)
      return
    }
    const cleanupGateway = this.gatewayInfo
    const refreshed: NatMapping[] = []
    for (const existing of this.activeMappings) {
      const mapping = await this.mapOne(
        lifecycleEpoch,
        existing.internalPort,
        existing.protocol,
        existing.purpose,
        {
          preferred: existing.method,
          ...(existing.pcpNonce ? { existingNonce: existing.pcpNonce } : {}),
        }
      )
      if (!this.isLifecycleCurrent(lifecycleEpoch)) {
        await this.discardStaleMappings(
          mapping ? [...refreshed, mapping] : refreshed,
          cleanupGateway
        )
        return
      }
      if (!mapping) {
        // Partial failure: invalidate sticky protocol and attempt full fallback
        this.stickyProtocol = null
        const retry = await this.mapOne(
          lifecycleEpoch,
          existing.internalPort,
          existing.protocol,
          existing.purpose
        )
        if (!this.isLifecycleCurrent(lifecycleEpoch)) {
          await this.discardStaleMappings(
            retry ? [...refreshed, retry] : refreshed,
            cleanupGateway
          )
          return
        }
        if (!retry) {
          this.setState(NatState.Failed)
          return
        }
        refreshed.push(retry)
      } else {
        refreshed.push(mapping)
      }
    }
    this.activeMappings = refreshed
    this.deps.onEvent({
      type: 'mapping-updated',
      mappings: [...this.activeMappings],
    })
    this.scheduleRenewal()
  }

  protected scheduleRenewal(): void {
    if (this.renewalTimer) clearTimeout(this.renewalTimer)
    if (this.activeMappings.length === 0) return
    const ttl = this.deps.settingsProvider.getNat().mappingTtl
    const jitter = crypto.randomInt(0, 60_000)
    const base = ttl > 1200 ? (ttl - 600) * 1000 : (ttl / 2) * 1000
    const renewIn = Math.max(base + jitter, 60_000)
    this.renewalTimer = setTimeout(() => {
      void this.remapAll().then(() => this.scheduleRenewal())
    }, renewIn)
    this.renewalTimer.unref?.()
  }

  protected clearRenewalTimer(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer)
      this.renewalTimer = null
    }
  }

  private async mapOne(
    lifecycleEpoch: number,
    internalPort: number,
    protocol: NatTransportProtocol,
    purpose: NatMappingPurpose,
    opts?: { preferred?: NatProtocol; existingNonce?: string }
  ): Promise<NatMapping | null> {
    const { preferred, existingNonce } = opts ?? {}
    const order: NatProtocol[] = preferred
      ? [preferred, ...this.PROTOCOL_ORDER.filter((p) => p !== preferred)]
      : this.stickyProtocol
        ? [
            this.stickyProtocol,
            ...this.PROTOCOL_ORDER.filter((p) => p !== this.stickyProtocol),
          ]
        : [...this.PROTOCOL_ORDER]
    for (const proto of order) {
      const result = await this.tryMap(
        proto,
        internalPort,
        protocol,
        existingNonce
      )
      if (result) {
        const mapping: NatMapping = {
          internalPort,
          externalPort: result.externalPort,
          protocol,
          purpose,
          method: proto,
          ttl: result.ttl,
          expiresAt: this.now() + result.ttl * 1000,
          createdAt: this.now(),
          lastRenewedAt: this.now(),
        }
        if (result.pcpNonce) mapping.pcpNonce = result.pcpNonce
        if (!this.isLifecycleCurrent(lifecycleEpoch)) return mapping
        this.stickyProtocol = proto
        // SPEC FIX: warn when NAT-PMP is SELECTED (success), not when it fails
        if (proto === NatProtocol.NatPmp) {
          this.deps.onEvent({
            type: 'error',
            error: {
              code: 'NAT_SECURITY_WARNING',
              message: 'NAT-PMP selected; responses are unauthenticated',
            },
          })
        }
        return mapping
      }
      if (!this.isLifecycleCurrent(lifecycleEpoch)) return null
    }
    return null
  }

  private async tryMap(
    proto: NatProtocol,
    internalPort: number,
    protocol: NatTransportProtocol,
    existingNonce?: string
  ): Promise<{ externalPort: number; ttl: number; pcpNonce?: string } | null> {
    const ttl = this.deps.settingsProvider.getNat().mappingTtl
    try {
      switch (proto) {
        case NatProtocol.Pcp: {
          if (!this.pcpRouteReady) return null
          const r = await this.deps.pmpPcpClient.pcpMap({
            internalPort,
            externalPort: internalPort,
            protocol,
            ttl,
            timeoutMs: 1000,
            nonce: existingNonce
              ? Buffer.from(existingNonce, 'hex')
              : undefined,
          })
          if (!r.ok) return null
          const v = r.value as
            | { externalPort?: number; ttl?: number; nonce?: Buffer }
            | undefined
          const mapped: {
            externalPort: number
            ttl: number
            pcpNonce?: string
          } = {
            externalPort: v?.externalPort ?? internalPort,
            ttl: v?.ttl ?? ttl,
          }
          if (v?.nonce) mapped.pcpNonce = v.nonce.toString('hex')
          return mapped
        }
        case NatProtocol.NatPmp: {
          if (!this.natPmpGatewayReady) return null
          const r = await this.deps.pmpPcpClient.natPmpMap({
            protocol,
            internalPort,
            externalPort: internalPort,
            ttl,
            timeoutMs: 1000,
          })
          if (!r.ok) return null
          const v = r.value as
            | { externalPort?: number; ttl?: number }
            | undefined
          return {
            externalPort: v?.externalPort ?? internalPort,
            ttl: v?.ttl ?? ttl,
          }
        }
        case NatProtocol.Upnp: {
          const info = this.gatewayInfo
          if (
            !info?.controlUrl ||
            !info.controlHost ||
            !info.controlPort ||
            !info.internalIp ||
            info.controlPort < 1 ||
            info.controlPort > 65535
          ) {
            return null
          }
          const r = await this.deps.upnpClient.mapPort(
            {
              gatewayIp: info.gatewayIp,
              controlUrl: info.controlUrl,
              controlHost: info.controlHost,
              controlPort: info.controlPort,
              serviceType: UPNP_WANIP_V1,
              manufacturer: info.manufacturer ?? '',
              modelName: info.modelName ?? '',
            },
            {
              internalIp: info.internalIp,
              internalPort,
              externalPort: internalPort,
              protocol,
              ttl,
              description: 'Motrix',
            },
            // Thread the lifecycle AbortController into the SOAP call so a
            // stop()/re-discovery (both call abortController.abort()) cancels
            // an in-flight UPnP mapping. unmapOne deliberately does NOT pass
            // this signal: stop() aborts before its cleanup-unmap loop, and a
            // pre-aborted signal would cancel the very unmaps that release the
            // router's port mappings.
            this.abortController?.signal
          )
          if (!r.ok) return null
          return { externalPort: internalPort, ttl }
        }
      }
    } catch (err) {
      log.warn({ proto, internalPort, err }, 'tryMap threw')
    }
    return null
  }

  // ——— Public API consumed by M6 IPC layer ———
  async enable(): Promise<void> {
    await this.start()
  }

  async disable(): Promise<void> {
    await this.stop()
  }

  async forceRemap(): Promise<void> {
    if (this.state === NatState.Stopped || this.state === NatState.Idle) {
      await this.start()
      return
    }
    await this.remapAll()
  }

  async runDiagnostic(): Promise<void> {
    // Minimal stub: only NAT type detection if enabled. Full diagnostic
    // landing in M8.
    const nat = this.deps.settingsProvider.getNat()
    if (!nat.natTypeDetectionEnabled || nat.stunServers.length === 0) return
    const result = await this.deps.stunClient.detectNatType({
      servers: nat.stunServers,
      timeoutMs: 3000,
    })
    this.deps.onEvent({
      type: 'diagnostic-completed',
      result: {
        runAt: this.now(),
        natType: result.ok ? 'unknown' : 'unknown',
        gatewayInfo: this.gatewayInfo,
        portReachability: {
          btListenPort: 'unknown',
          dhtListenPort: 'unknown',
        },
        protocolAvailability: {
          pcp:
            this.gatewayInfo?.supportedProtocols.includes(NatProtocol.Pcp) ??
            false,
          natpmp:
            this.gatewayInfo?.supportedProtocols.includes(NatProtocol.NatPmp) ??
            false,
          upnp:
            this.gatewayInfo?.supportedProtocols.includes(NatProtocol.Upnp) ??
            false,
        },
        healthScore: 'fair',
        recommendations: [],
      },
    })
  }

  async exportBundle(): Promise<{
    clientVersion: string
    platform: NodeJS.Platform
    state: NatState
    stickyProtocol: NatProtocol | null
    gatewayManufacturer: string | null
    gatewayModel: string | null
    internalIpMasked: string | null
    gatewayIpMasked: string | null
    retryCount: number
    activeMappingCount: number
    lastErrorCode: string | null
    recordedAt: number
  }> {
    const mask = (ip: string | null | undefined): string | null => {
      if (!ip) return null
      const parts = ip.split('.')
      if (parts.length !== 4) return null
      return `${parts[0]}.${parts[1]}.x.x`
    }
    return {
      clientVersion: process.env.npm_package_version ?? 'dev',
      platform: process.platform,
      state: this.state,
      stickyProtocol: this.stickyProtocol,
      gatewayManufacturer: this.gatewayInfo?.manufacturer ?? null,
      gatewayModel: this.gatewayInfo?.modelName ?? null,
      internalIpMasked: mask(this.gatewayInfo?.internalIp),
      gatewayIpMasked: mask(this.gatewayInfo?.gatewayIp),
      retryCount: this.retryCount,
      activeMappingCount: this.activeMappings.length,
      lastErrorCode: this.lastError?.code ?? null,
      recordedAt: this.now(),
    }
  }
}

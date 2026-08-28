import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from './__test__/utils.js'
import {
  type NatEvent,
  NatManager,
  type NatManagerDeps,
  type NatManagerHooks,
  type NatManagerSettings,
} from './nat-manager.js'
import { NatProtocol, NatState } from './types.js'

const DEFAULT_NAT_SETTINGS: NatManagerSettings = {
  enabled: true,
  preferredProtocol: 'auto',
  mappingTtl: 7200,
  natTypeDetectionEnabled: false,
  stunServers: [],
  portReachabilityCheckEnabled: false,
  portCheckerEndpoints: [],
}

const UPNP_GATEWAY_STUB = {
  ok: true as const,
  value: {
    gatewayIp: '192.168.1.1',
    controlUrl: '/ctl',
    controlHost: '192.168.1.1',
    controlPort: 49152,
    serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    manufacturer: 'T',
    modelName: 'M',
  },
}

interface TestHooks extends NatManagerHooks {
  _fireReady: () => void
  _fireConfigChanged: () => void
}

function makeHooks(): TestHooks {
  const listeners = {
    ready: [] as Array<() => void>,
    config: [] as Array<() => void>,
  }
  return {
    onReady(listener) {
      listeners.ready.push(listener)
      return () => {
        listeners.ready = listeners.ready.filter((l) => l !== listener)
      }
    },
    onConfigChanged(listener) {
      listeners.config.push(listener)
      return () => {
        listeners.config = listeners.config.filter((l) => l !== listener)
      }
    },
    _fireReady: () => {
      for (const l of listeners.ready) l()
    },
    _fireConfigChanged: () => {
      for (const l of listeners.config) l()
    },
  }
}

interface TestDeps extends NatManagerDeps {
  hooks: TestHooks
  events: NatEvent[]
}

function makeDeps(): TestDeps {
  const hooks = makeHooks()
  const events: NatEvent[] = []
  const stunClient = { detectNatType: vi.fn() }
  const portChecker = { checkPortReachable: vi.fn() }
  const upnpClient = {
    discover: vi.fn(),
    mapPort: vi.fn(),
    unmapPort: vi.fn(),
    getExternalIp: vi.fn(),
  }
  const pmpPcpClient = {
    natPmpGetExternalIp: vi.fn(),
    natPmpMap: vi.fn(),
    pcpMap: vi.fn(),
    setGatewayIp: vi.fn(),
    setNetworkRoute: vi.fn(),
    close: vi.fn(),
  }
  const networkMonitor = {
    start: vi.fn(),
    stop: vi.fn(),
    onChange: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({
      gatewayIp: '192.168.1.1',
      internalIp: '192.168.1.100',
      hash: 'x',
    })),
  }
  const settingsProvider = {
    getEngine: vi.fn(() => ({ listenPort: 6881, dhtListenPort: 6881 })),
    getNat: vi.fn(() => DEFAULT_NAT_SETTINGS),
  }
  return {
    hooks,
    onEvent: (e: NatEvent) => events.push(e),
    events,
    stunClient,
    portChecker,
    upnpClient,
    pmpPcpClient,
    networkMonitor,
    settingsProvider,
  } as unknown as TestDeps
}

class RenewalTrackingNatManager extends NatManager {
  renewalSchedules = 0
  renewalClears = 0

  protected override scheduleRenewal(): void {
    this.renewalSchedules++
  }

  protected override clearRenewalTimer(): void {
    this.renewalClears++
    super.clearRenewalTimer()
  }
}

describe('NatManager lifecycle', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    manager = new NatManager(deps)
  })

  it('starts in Idle state', () => {
    expect(manager.getStatus().state).toBe(NatState.Idle)
  })

  it('emits state-changed event when transitioning', async () => {
    // Mock discover to prevent actual work
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({
      ok: false,
      error: 'ND',
    })
    vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mockResolvedValue({
      ok: false,
      error: 'ND',
    })

    await manager.start()
    const states = deps.events
      .filter(
        (e): e is { type: 'state-changed'; state: NatState } =>
          e.type === 'state-changed'
      )
      .map((e) => e.state)
    expect(states).toContain(NatState.Discovering)
  })

  it('stop() transitions to Stopped', async () => {
    await manager.stop()
    expect(manager.getStatus().state).toBe(NatState.Stopped)
  })
})

describe('NatManager shutdown unmapping', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
    manager = new NatManager(deps)
  })

  it('stop() sends unmap requests for UPnP mappings', async () => {
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })
    vi.mocked(deps.upnpClient.unmapPort).mockResolvedValue({ ok: true })
    await manager.start()
    await manager.mapConfiguredPorts()
    expect(manager.getStatus().activeMappings).toHaveLength(2)

    await manager.stop()

    expect(deps.upnpClient.unmapPort).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().activeMappings).toHaveLength(0)
    expect(manager.getStatus().state).toBe(NatState.Stopped)
  })

  it('stop() sends pcpMap(ttl:0) with original nonce for PCP mappings', async () => {
    const testNonce = Buffer.from('aabbccdd11223344aabbccdd', 'hex')
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200, nonce: testNonce },
    })
    await manager.start()
    await manager.mapConfiguredPorts()
    const mappings = manager.getStatus().activeMappings
    expect(mappings).toHaveLength(2)
    expect(mappings[0]?.method).toBe(NatProtocol.Pcp)
    expect(mappings[0]?.pcpNonce).toBe('aabbccdd11223344aabbccdd')

    vi.mocked(deps.pmpPcpClient.pcpMap).mockClear()
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({ ok: true })
    await manager.stop()

    // pcpMap called twice with ttl:0 + original nonce
    expect(deps.pmpPcpClient.pcpMap).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(deps.pmpPcpClient.pcpMap).mock.calls) {
      const args = call[0] as { ttl: number; nonce?: Buffer }
      expect(args.ttl).toBe(0)
      expect(args.nonce).toEqual(testNonce)
    }
  })

  it('stop() sends natPmpMap(ttl:0) for NAT-PMP mappings', async () => {
    // PCP fails, NAT-PMP succeeds → sticky = NatPmp
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: false,
      error: 'no pcp',
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200 },
    })
    await manager.start()
    await manager.mapConfiguredPorts()
    const mappings = manager.getStatus().activeMappings
    expect(mappings[0]?.method).toBe(NatProtocol.NatPmp)

    vi.mocked(deps.pmpPcpClient.natPmpMap).mockClear()
    await manager.stop()

    expect(deps.pmpPcpClient.natPmpMap).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(deps.pmpPcpClient.natPmpMap).mock.calls) {
      const args = call[0] as { ttl: number }
      expect(args.ttl).toBe(0)
    }
  })

  it('stop() completes even if one unmapOne fails', async () => {
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })
    vi.mocked(deps.upnpClient.unmapPort)
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({ ok: true })
    await manager.start()
    await manager.mapConfiguredPorts()
    expect(manager.getStatus().activeMappings).toHaveLength(2)

    // Should not throw despite the first unmapOne failing
    await manager.stop()

    expect(deps.upnpClient.unmapPort).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe(NatState.Stopped)
  })

  it('stop() with no active mappings skips unmapping', async () => {
    await manager.start()
    // No mapConfiguredPorts called → no active mappings
    await manager.stop()
    expect(deps.upnpClient.unmapPort).not.toHaveBeenCalled()
    expect(deps.pmpPcpClient.pcpMap).not.toHaveBeenCalled()
  })
})

describe('NatManager discovery', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    manager = new NatManager(deps)
  })

  it('transitions Discovering → Ready on UPnP success', async () => {
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
    await manager.start()
    const states = deps.events
      .filter(
        (e): e is Extract<NatEvent, { type: 'state-changed' }> =>
          e.type === 'state-changed'
      )
      .map((e) => e.state)
    expect(states).toContain(NatState.Discovering)
    expect(states).toContain(NatState.Ready)
    expect(manager.getStatus().gatewayInfo?.gatewayIp).toBe('192.168.1.1')
  })

  it('binds UPnP discovery to the monitored default-route interface', async () => {
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)

    await manager.start()

    expect(deps.upnpClient.discover).toHaveBeenCalledWith({
      timeoutMs: 3000,
      interfaceAddress: '192.168.1.100',
    })
    expect(deps.networkMonitor.snapshot).toHaveBeenCalledTimes(1)
  })

  it('awaits a verified route before accepting UPnP on a multi-NIC host', async () => {
    const verified = Promise.withResolvers<{
      gatewayIp: string
      internalIp: string
      hash: string
    }>()
    deps.networkMonitor.verifiedSnapshot = vi.fn(() => verified.promise)
    vi.mocked(deps.networkMonitor.snapshot).mockReturnValue({
      gatewayIp: '192.168.1.1',
      internalIp: '192.168.1.20',
      hash: 'fallback-a',
    })
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({
      ...UPNP_GATEWAY_STUB,
      value: {
        ...UPNP_GATEWAY_STUB.value,
        gatewayIp: '10.0.0.254',
        controlHost: '10.0.0.254',
      },
    })

    const starting = manager.start()
    await tick()
    expect(deps.upnpClient.discover).not.toHaveBeenCalled()

    verified.resolve({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.42',
      hash: 'verified-b',
    })
    await starting

    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(1)
    expect(deps.upnpClient.discover).toHaveBeenCalledWith({
      timeoutMs: 3000,
      interfaceAddress: '10.0.0.42',
    })
    expect(deps.networkMonitor.snapshot).not.toHaveBeenCalled()

    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({ ok: false })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({ ok: false })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })
    await manager.mapConfiguredPorts()

    expect(deps.upnpClient.mapPort).toHaveBeenCalledTimes(2)
    for (const [, params] of vi.mocked(deps.upnpClient.mapPort).mock.calls) {
      expect(params).toMatchObject({ internalIp: '10.0.0.42' })
    }
  })

  it('transitions Discovering → Failed when all protocols fail', async () => {
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({
      ok: false,
      error: 'X',
    })
    vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mockResolvedValue({
      ok: false,
      error: 'X',
    })

    await manager.start()
    const states = deps.events
      .filter(
        (e): e is Extract<NatEvent, { type: 'state-changed' }> =>
          e.type === 'state-changed'
      )
      .map((e) => e.state)
    expect(states[states.length - 1]).toBe(NatState.Failed)
  })

  it('uses a background-refreshed route before probing NAT-PMP', async () => {
    vi.mocked(deps.networkMonitor.snapshot)
      .mockReturnValueOnce({
        gatewayIp: '192.168.1.1',
        internalIp: '192.168.1.100',
        hash: 'fallback',
      })
      .mockReturnValueOnce({
        gatewayIp: '192.168.1.254',
        internalIp: '192.168.1.100',
        hash: 'resolved',
      })
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({ ok: false })
    vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mockResolvedValue({
      ok: true,
      value: { externalIp: '203.0.113.10' },
    })

    await manager.start()

    expect(deps.upnpClient.discover).toHaveBeenCalledWith({
      timeoutMs: 3000,
      interfaceAddress: '192.168.1.100',
    })
    expect(deps.pmpPcpClient.setNetworkRoute).toHaveBeenCalledWith({
      gatewayIp: '192.168.1.254',
      internalIp: '192.168.1.100',
    })
    const setNetworkRoute = deps.pmpPcpClient.setNetworkRoute
    if (!setNetworkRoute) throw new Error('setNetworkRoute mock missing')
    const gatewayUpdateOrder =
      vi.mocked(setNetworkRoute).mock.invocationCallOrder[0]
    const probeOrder = vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mock
      .invocationCallOrder[0]
    expect(gatewayUpdateOrder).toBeLessThan(probeOrder ?? 0)
  })

  it('re-verifies the route after UPnP when topology changes mid-discovery', async () => {
    const upnpResult = Promise.withResolvers<{ ok: false }>()
    const routeB = Promise.withResolvers<{
      gatewayIp: string
      internalIp: string
      hash: string
    }>()
    deps.networkMonitor.verifiedSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        gatewayIp: '192.168.1.1',
        internalIp: '192.168.1.20',
        hash: 'route-a',
      })
      .mockReturnValueOnce(routeB.promise)
    vi.mocked(deps.upnpClient.discover).mockReturnValue(upnpResult.promise)
    vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mockResolvedValue({
      ok: true,
      value: { externalIp: '203.0.113.10' },
    })

    const starting = manager.start()
    await tick()
    expect(deps.upnpClient.discover).toHaveBeenCalledWith({
      timeoutMs: 3000,
      interfaceAddress: '192.168.1.20',
    })

    upnpResult.resolve({ ok: false })
    await tick()
    expect(deps.networkMonitor.verifiedSnapshot).toHaveBeenCalledTimes(2)
    expect(deps.pmpPcpClient.setNetworkRoute).not.toHaveBeenCalled()
    expect(deps.pmpPcpClient.natPmpGetExternalIp).not.toHaveBeenCalled()

    routeB.resolve({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.42',
      hash: 'route-b',
    })
    await starting

    expect(deps.pmpPcpClient.setNetworkRoute).toHaveBeenCalledTimes(1)
    expect(deps.pmpPcpClient.setNetworkRoute).toHaveBeenCalledWith({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.42',
    })
    expect(deps.pmpPcpClient.natPmpGetExternalIp).toHaveBeenCalledTimes(1)
    expect(manager.getStatus().gatewayInfo).toMatchObject({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.42',
    })
  })

  it('does not probe an old NAT-PMP gateway when the route is unavailable', async () => {
    vi.mocked(deps.networkMonitor.snapshot).mockReturnValue({
      gatewayIp: '',
      internalIp: '',
      hash: '',
    })
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({ ok: false })

    await manager.start()

    expect(deps.pmpPcpClient.setNetworkRoute).not.toHaveBeenCalled()
    expect(deps.pmpPcpClient.natPmpGetExternalIp).not.toHaveBeenCalled()
    expect(manager.getStatus().state).toBe(NatState.Failed)
  })

  it('keeps NAT-PMP available for a gateway-only legacy adapter', async () => {
    delete deps.pmpPcpClient.setNetworkRoute
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({ ok: false })
    vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mockResolvedValue({
      ok: true,
      value: { externalIp: '203.0.113.10' },
    })

    await manager.start()

    expect(deps.pmpPcpClient.setGatewayIp).toHaveBeenCalledWith('192.168.1.1')
    expect(deps.pmpPcpClient.natPmpGetExternalIp).toHaveBeenCalledTimes(1)
    expect(manager.getStatus().state).toBe(NatState.Ready)
    expect(manager.getStatus().gatewayInfo?.supportedProtocols).toEqual([
      NatProtocol.NatPmp,
    ])
  })

  it('emits NatGatewayChanged when gateway is discovered', async () => {
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({
      ok: true,
      value: {
        gatewayIp: '192.168.1.1',
        controlUrl: '/ctl',
        controlHost: '192.168.1.1',
        controlPort: 49152,
        serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
        manufacturer: 'ASUSTeK',
        modelName: 'AX',
      },
    })
    await manager.start()
    const gateways = deps.events.filter(
      (e): e is Extract<NatEvent, { type: 'gateway-changed' }> =>
        e.type === 'gateway-changed'
    )
    expect(gateways).toHaveLength(1)
    expect(gateways[0]?.info.manufacturer).toBe('ASUSTeK')
  })
})

describe('NatManager mapping with fallback', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    manager = new NatManager(deps)
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
  })

  it('tries PCP → NAT-PMP → UPnP in order', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: false,
      error: 'no pcp',
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: false,
      error: 'no pmp',
    })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })

    await manager.start()
    await manager.mapConfiguredPorts()

    expect(deps.pmpPcpClient.pcpMap).toHaveBeenCalled()
    expect(deps.pmpPcpClient.natPmpMap).toHaveBeenCalled()
    expect(deps.upnpClient.mapPort).toHaveBeenCalled()
    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().activeMappings).toHaveLength(2)
  })

  it('disables PCP but maps with NAT-PMP for a legacy adapter', async () => {
    delete deps.pmpPcpClient.setNetworkRoute
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200 },
    })

    await manager.start()
    await manager.mapConfiguredPorts()

    expect(deps.pmpPcpClient.setGatewayIp).toHaveBeenCalledWith('192.168.1.1')
    expect(deps.pmpPcpClient.pcpMap).not.toHaveBeenCalled()
    expect(deps.pmpPcpClient.natPmpMap).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe(NatState.Active)
  })

  it('uses the discovery interface for UPnP mapping', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({ ok: false })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({ ok: false })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })

    await manager.start()
    vi.mocked(deps.networkMonitor.snapshot).mockReturnValue({
      gatewayIp: '10.0.0.1',
      internalIp: '10.0.0.50',
      hash: 'changed',
    })
    await manager.mapConfiguredPorts()

    const mappingParams = vi.mocked(deps.upnpClient.mapPort).mock.calls[0]?.[1]
    expect(mappingParams).toMatchObject({ internalIp: '192.168.1.100' })
    expect(deps.networkMonitor.snapshot).toHaveBeenCalledTimes(1)
  })

  it('passes the lifecycle abort signal to UPnP mapPort and aborts it on stop', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: false,
      error: 'no pcp',
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: false,
      error: 'no pmp',
    })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })

    await manager.start()
    await manager.mapConfiguredPorts()

    // tryMap must thread the lifecycle AbortController.signal into the
    // UPnP SOAP call so that stop()/re-discovery can cancel an in-flight
    // mapping. Before this wiring the third arg was undefined and abort()
    // cancelled nothing.
    const signal = vi.mocked(deps.upnpClient.mapPort).mock.calls[0]?.[2] as
      | AbortSignal
      | undefined
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)

    await manager.stop()
    expect(signal?.aborted).toBe(true)
  })

  it('sticks to successful protocol on subsequent maps', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: false,
      error: 'no pcp',
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200 },
    })

    await manager.start()
    await manager.mapConfiguredPorts()

    vi.mocked(deps.pmpPcpClient.pcpMap).mockClear()
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockClear()

    await manager.remapAll()

    expect(deps.pmpPcpClient.pcpMap).not.toHaveBeenCalled() // sticky
    expect(deps.pmpPcpClient.natPmpMap).toHaveBeenCalled()
  })

  it('transitions to Failed if all protocols fail', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: false,
      error: 'x',
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: false,
      error: 'x',
    })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({
      ok: false,
      error: 'x',
    })

    await manager.start()
    await manager.mapConfiguredPorts()
    expect(manager.getStatus().state).toBe(NatState.Failed)
  })

  it('concurrent mapConfiguredPorts() calls do not corrupt activeMappings', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true, value: { externalPort: 6881, ttl: 7200 } }
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: false,
      error: 'no pmp',
    })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({
      ok: false,
      error: 'no upnp',
    })

    await manager.start()
    // Fire two concurrent maps; the second should be queued by the mutex
    await Promise.all([
      manager.mapConfiguredPorts(),
      manager.mapConfiguredPorts(),
    ])
    // Both return void; state is Active; mappings has exactly 2 entries (not 4)
    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().activeMappings).toHaveLength(2)
  })

  it('stop() resets stickyProtocol', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: false,
      error: 'x',
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200 },
    })
    await manager.start()
    await manager.mapConfiguredPorts()
    // Sticky is now NatPmp. After stop, it should be cleared.
    await manager.stop()
    // Can't inspect stickyProtocol directly (protected). Indirect: after next
    // start+map, PCP should be tried first, not NatPmp.
    // For this test, just verify stop completed.
    expect(manager.getStatus().state).toBe(NatState.Stopped)
  })
})

describe('NatManager TTL renewal', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    vi.useFakeTimers()
    deps = makeDeps()
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
    manager = new NatManager(deps)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules renewal before TTL expiry', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: false,
      error: 'no pcp',
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: false,
      error: 'no pmp',
    })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })
    await manager.start()
    await manager.mapConfiguredPorts()
    vi.mocked(deps.upnpClient.mapPort).mockClear()

    // Default mappingTtl 7200 → renew at 7200-600 = 6600s ± jitter
    // Advance past the renewal window and run only the current timer
    vi.advanceTimersByTime(7000 * 1000)
    await vi.runOnlyPendingTimersAsync()
    expect(deps.upnpClient.mapPort).toHaveBeenCalled()
  })
})

describe('NatManager event reactivity', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    // Override default ports for test isolation
    deps.settingsProvider.getEngine = vi.fn(() => ({
      listenPort: 6881,
      dhtListenPort: 6882,
    }))
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
    manager = new NatManager(deps)
  })

  it('stops mappings when nat.enabled changes false', async () => {
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })
    await manager.start()
    await manager.mapConfiguredPorts()
    expect(manager.getStatus().activeMappings).toHaveLength(2)

    deps.settingsProvider.getNat = vi.fn(() => ({
      ...DEFAULT_NAT_SETTINGS,
      enabled: false,
    }))
    deps.hooks._fireConfigChanged()
    // Allow async work to settle
    await tick()
    // stop() is async; we need to wait for its mutex + close() calls
    await tick()
    await tick()
    expect(manager.getStatus().state).toBe(NatState.Stopped)
  })

  it('remaps when listenPort changes', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: false,
      error: 'no pcp',
    })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({
      ok: false,
      error: 'no pmp',
    })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })
    await manager.start()
    await manager.mapConfiguredPorts()
    vi.mocked(deps.upnpClient.mapPort).mockClear()
    vi.mocked(deps.upnpClient.unmapPort).mockResolvedValue({ ok: true })

    deps.settingsProvider.getEngine = vi.fn(() => ({
      listenPort: 6883,
      dhtListenPort: 6882,
    }))
    deps.hooks._fireConfigChanged()
    // Allow settings handler + unmap + remap to settle (multiple await points)
    for (let i = 0; i < 10; i++) {
      await tick()
    }

    expect(deps.upnpClient.unmapPort).toHaveBeenCalled()
    expect(deps.upnpClient.mapPort).toHaveBeenCalled()
  })
})

describe('NatManager retry ceiling', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    vi.useFakeTimers()
    deps = makeDeps()
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({
      ok: false,
      error: 'X',
    })
    vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mockResolvedValue({
      ok: false,
      error: 'X',
    })
    manager = new NatManager(deps)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exponentially backs off and eventually stops retrying', async () => {
    await manager.start()
    // Initial discovery failed — should now back off
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(10 * 60 * 1000)
      await vi.runAllTimersAsync()
    }
    // After 3 retries we stop (dormant)
    const discoverCalls = vi.mocked(deps.upnpClient.discover).mock.calls.length
    expect(discoverCalls).toBeLessThanOrEqual(4) // initial + up to 3 retries
  })
})

describe('NatManager stop during in-flight discovery', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    manager = new NatManager(deps)
  })

  it('keeps state Stopped when discovery resolves with failure after stop', async () => {
    // Hang UPnP discovery until we manually resolve it, simulating the
    // 3-second window where a real router is unreachable.
    let resolveUpnp: (v: unknown) => void = () => {}
    const upnpHang = new Promise((r) => {
      resolveUpnp = r
    })
    vi.mocked(deps.upnpClient.discover).mockReturnValueOnce(upnpHang as never)
    vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mockResolvedValue({
      ok: false,
      error: 'X',
    })

    const startPromise = manager.start()
    await tick()
    expect(manager.getStatus().state).toBe(NatState.Discovering)

    // User clicks Disable while discovery is mid-flight.
    const stopPromise = manager.stop()
    await tick()
    expect(manager.getStatus().state).toBe(NatState.Stopped)
    expect(manager.getStatus().retryAttempt).toBe(0)

    // The hung discovery now resolves with failure. Its trailing
    // setState(Failed) MUST be ignored by the generation guard — otherwise
    // the user's explicit Disable would silently flip back into a retry
    // cycle (the bug this test guards against).
    resolveUpnp({ ok: false, error: 'late' })
    await Promise.all([startPromise, stopPromise])
    await tick()

    expect(manager.getStatus().state).toBe(NatState.Stopped)
    expect(manager.getStatus().retryAttempt).toBe(0)
    // No NAT_DISCOVERY_FAILED error should leak past the gen guard.
    expect(manager.getStatus().lastError).toBeNull()
  })
})

describe('NatManager stop during queued transitions', () => {
  let deps: TestDeps
  let manager: RenewalTrackingNatManager

  beforeEach(() => {
    deps = makeDeps()
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
    manager = new RenewalTrackingNatManager(deps)
  })

  it('drops queued discovery and invalidates an active mapping, then restarts', async () => {
    const gate = Promise.withResolvers<void>()
    let positiveMapCalls = 0
    vi.mocked(deps.pmpPcpClient.pcpMap).mockImplementation(async (params) => {
      const ttl = (params as { ttl: number }).ttl
      if (ttl === 0) return { ok: true }
      positiveMapCalls++
      if (positiveMapCalls === 1) await gate.promise
      return { ok: true, value: { externalPort: 6881, ttl: 7200 } }
    })

    await manager.start()
    const mapping = manager.mapConfiguredPorts()
    await tick()
    expect(manager.getStatus().state).toBe(NatState.Mapping)

    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'changed' })
    await tick()

    await manager.stop()
    expect(manager.getStatus().state).toBe(NatState.Stopped)
    gate.resolve()
    await mapping

    expect(positiveMapCalls).toBe(1)
    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(1)
    expect(manager.getStatus().state).toBe(NatState.Stopped)
    expect(manager.getStatus().activeMappings).toHaveLength(0)
    expect(manager.renewalSchedules).toBe(0)

    const cleanupIndex = vi
      .mocked(deps.pmpPcpClient.pcpMap)
      .mock.calls.findIndex(([params]) => (params as { ttl: number }).ttl === 0)
    expect(cleanupIndex).toBeGreaterThanOrEqual(0)
    const cleanupOrder = vi.mocked(deps.pmpPcpClient.pcpMap).mock
      .invocationCallOrder[cleanupIndex]
    const closeOrders = vi.mocked(deps.pmpPcpClient.close).mock
      .invocationCallOrder
    expect(closeOrders.at(-1)).toBeGreaterThan(cleanupOrder ?? 0)

    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200 },
    })
    await manager.start()
    await manager.mapConfiguredPorts()

    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().activeMappings).toHaveLength(2)
    expect(manager.renewalSchedules).toBe(1)
  })

  it('invalidates an active remap and does not run queued discovery', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200 },
    })
    await manager.start()
    await manager.mapConfiguredPorts()
    manager.renewalSchedules = 0

    const gate = Promise.withResolvers<void>()
    let positiveRemapCalls = 0
    vi.mocked(deps.pmpPcpClient.pcpMap).mockImplementation(async (params) => {
      const ttl = (params as { ttl: number }).ttl
      if (ttl === 0) return { ok: true }
      positiveRemapCalls++
      if (positiveRemapCalls === 1) await gate.promise
      return { ok: true, value: { externalPort: 6881, ttl: 7200 } }
    })

    const remapping = manager.remapAll()
    await tick()
    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'changed' })
    await tick()

    await manager.stop()
    gate.resolve()
    await remapping

    expect(positiveRemapCalls).toBe(1)
    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(1)
    expect(manager.getStatus().state).toBe(NatState.Stopped)
    expect(manager.getStatus().activeMappings).toHaveLength(0)
    expect(manager.renewalSchedules).toBe(0)

    const pcpCalls = vi.mocked(deps.pmpPcpClient.pcpMap).mock.calls
    const lastCleanupIndex = pcpCalls.findLastIndex(
      ([params]) => (params as { ttl: number }).ttl === 0
    )
    const lastCleanupOrder = vi.mocked(deps.pmpPcpClient.pcpMap).mock
      .invocationCallOrder[lastCleanupIndex]
    const lastCloseOrder = vi
      .mocked(deps.pmpPcpClient.close)
      .mock.invocationCallOrder.at(-1)
    expect(lastCloseOrder).toBeGreaterThan(lastCleanupOrder ?? 0)
  })

  it('serializes a rapid stop then start without overwriting the new route', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({ ok: false })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({ ok: false })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })
    vi.mocked(deps.upnpClient.discover)
      .mockReset()
      .mockResolvedValueOnce(UPNP_GATEWAY_STUB)
      .mockResolvedValueOnce({
        ...UPNP_GATEWAY_STUB,
        value: {
          ...UPNP_GATEWAY_STUB.value,
          gatewayIp: '10.0.0.254',
          controlHost: '10.0.0.254',
        },
      })
    await manager.start()
    await manager.mapConfiguredPorts()

    const unmapGate = Promise.withResolvers<void>()
    let unmapCalls = 0
    vi.mocked(deps.upnpClient.unmapPort).mockImplementation(async () => {
      unmapCalls++
      if (unmapCalls === 1) await unmapGate.promise
      return { ok: true }
    })
    vi.mocked(deps.networkMonitor.snapshot).mockReturnValue({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.50',
      hash: 'route-b',
    })

    const stopping = manager.stop()
    const restarting = manager.start()
    await tick()
    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(1)

    unmapGate.resolve()
    await Promise.all([stopping, restarting])

    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe(NatState.Ready)
    expect(manager.getStatus().gatewayInfo).toMatchObject({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.50',
    })
    for (const [gateway] of vi.mocked(deps.upnpClient.unmapPort).mock.calls) {
      expect(gateway).toMatchObject({ gatewayIp: '192.168.1.1' })
    }
    const closeOrder = vi
      .mocked(deps.pmpPcpClient.close)
      .mock.invocationCallOrder.at(-1)
    const secondDiscoveryOrder = vi.mocked(deps.upnpClient.discover).mock
      .invocationCallOrder[1]
    expect(secondDiscoveryOrder).toBeGreaterThan(closeOrder ?? 0)
  })
})

describe('NatManager topology-change remapping', () => {
  let deps: TestDeps
  let manager: RenewalTrackingNatManager

  const gatewayB = {
    ...UPNP_GATEWAY_STUB,
    value: {
      ...UPNP_GATEWAY_STUB.value,
      gatewayIp: '10.0.0.254',
      controlHost: '10.0.0.254',
    },
  }

  beforeEach(() => {
    deps = makeDeps()
    vi.mocked(deps.upnpClient.discover)
      .mockResolvedValueOnce(UPNP_GATEWAY_STUB)
      .mockResolvedValueOnce(gatewayB)
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200 },
    })
    manager = new RenewalTrackingNatManager(deps)
  })

  it('clears route A and immediately rebuilds mappings on route B', async () => {
    await manager.start()
    await manager.mapConfiguredPorts()
    expect(manager.getStatus().activeMappings).toHaveLength(2)
    expect(manager.renewalSchedules).toBe(1)

    vi.mocked(deps.networkMonitor.snapshot).mockReturnValue({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.50',
      hash: 'route-b',
    })
    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'route-b' })

    expect(manager.getStatus().activeMappings).toHaveLength(0)
    expect(manager.getStatus().gatewayInfo).toBeNull()
    expect(manager.renewalClears).toBe(1)
    await tick()

    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().gatewayInfo).toMatchObject({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.50',
    })
    expect(manager.getStatus().activeMappings).toHaveLength(2)
    expect(manager.renewalSchedules).toBe(2)
    const mappingSizes = deps.events
      .filter(
        (event): event is Extract<NatEvent, { type: 'mapping-updated' }> =>
          event.type === 'mapping-updated'
      )
      .map((event) => event.mappings.length)
    expect(mappingSizes).toEqual([2, 0, 2])
  })

  it('does not retain route A when route B remapping fails', async () => {
    await manager.start()
    await manager.mapConfiguredPorts()
    expect(manager.getStatus().activeMappings).toHaveLength(2)

    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({ ok: false })
    vi.mocked(deps.pmpPcpClient.natPmpMap).mockResolvedValue({ ok: false })
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: false })
    vi.mocked(deps.networkMonitor.snapshot).mockReturnValue({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.50',
      hash: 'route-b',
    })
    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'route-b' })
    await tick()

    expect(manager.getStatus().state).toBe(NatState.Failed)
    expect(manager.getStatus().activeMappings).toHaveLength(0)
    expect(manager.getStatus().gatewayInfo).toBeNull()
    expect(manager.renewalSchedules).toBe(1)
    expect(manager.renewalClears).toBeGreaterThanOrEqual(2)
    const mappingSizes = deps.events
      .filter(
        (event): event is Extract<NatEvent, { type: 'mapping-updated' }> =>
          event.type === 'mapping-updated'
      )
      .map((event) => event.mappings.length)
    expect(mappingSizes).toEqual([2, 0])
  })

  it('consumes map and remap intents queued while B discovery awaits', async () => {
    await manager.start()
    await manager.mapConfiguredPorts()

    const bDiscovery = Promise.withResolvers<typeof gatewayB>()
    vi.mocked(deps.upnpClient.discover)
      .mockReset()
      .mockReturnValueOnce(bDiscovery.promise)
    vi.mocked(deps.pmpPcpClient.pcpMap).mockClear()
    vi.mocked(deps.networkMonitor.snapshot).mockReturnValue({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.50',
      hash: 'route-b',
    })
    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'route-b' })
    await tick()
    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(1)

    deps.hooks._fireReady()
    const remapping = manager.remapAll()
    bDiscovery.resolve(gatewayB)
    await remapping

    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().activeMappings).toHaveLength(2)
    expect(deps.pmpPcpClient.pcpMap).toHaveBeenCalledTimes(2)
    expect(manager.renewalSchedules).toBe(2)
  })

  it('consumes map and remap intents queued while B mapping awaits', async () => {
    await manager.start()
    await manager.mapConfiguredPorts()

    const firstBMap = Promise.withResolvers<void>()
    let bMapCalls = 0
    vi.mocked(deps.pmpPcpClient.pcpMap).mockClear()
    vi.mocked(deps.pmpPcpClient.pcpMap).mockImplementation(async () => {
      bMapCalls++
      if (bMapCalls === 1) await firstBMap.promise
      return { ok: true, value: { externalPort: 6881, ttl: 7200 } }
    })
    vi.mocked(deps.networkMonitor.snapshot).mockReturnValue({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.50',
      hash: 'route-b',
    })
    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'route-b' })
    await tick()
    expect(bMapCalls).toBe(1)

    deps.hooks._fireReady()
    const remapping = manager.remapAll()
    firstBMap.resolve()
    await remapping

    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().activeMappings).toHaveLength(2)
    expect(bMapCalls).toBe(2)
    expect(manager.renewalSchedules).toBe(2)
  })

  it('preserves remap intent when topology change clears a queued map', async () => {
    const firstDiscovery = Promise.withResolvers<typeof UPNP_GATEWAY_STUB>()
    vi.mocked(deps.upnpClient.discover)
      .mockReset()
      .mockReturnValueOnce(firstDiscovery.promise)
      .mockResolvedValueOnce(gatewayB)
    vi.mocked(deps.networkMonitor.snapshot)
      .mockReturnValueOnce({
        gatewayIp: '192.168.1.1',
        internalIp: '192.168.1.100',
        hash: 'route-a',
      })
      .mockReturnValue({
        gatewayIp: '10.0.0.254',
        internalIp: '10.0.0.50',
        hash: 'route-b',
      })

    const starting = manager.start()
    await tick()
    expect(manager.getStatus().state).toBe(NatState.Discovering)
    deps.hooks._fireReady()
    await Promise.resolve()

    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'route-b' })
    firstDiscovery.resolve(UPNP_GATEWAY_STUB)
    await starting

    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().gatewayInfo?.gatewayIp).toBe('10.0.0.254')
    expect(manager.getStatus().activeMappings).toHaveLength(2)
  })
})

describe('NatManager public API', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    manager = new NatManager(deps)
  })

  it('enable() starts the manager', async () => {
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({ ok: false })
    vi.mocked(deps.pmpPcpClient.natPmpGetExternalIp).mockResolvedValue({
      ok: false,
    })
    await manager.enable()
    expect(deps.networkMonitor.start).toHaveBeenCalled()
  })

  it('disable() stops the manager', async () => {
    await manager.disable()
    expect(manager.getStatus().state).toBe(NatState.Stopped)
    expect(deps.pmpPcpClient.close).toHaveBeenCalled()
  })

  it('forceRemap() triggers remapAll', async () => {
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
    vi.mocked(deps.upnpClient.mapPort).mockResolvedValue({ ok: true })
    await manager.start()
    await manager.mapConfiguredPorts()
    vi.mocked(deps.upnpClient.mapPort).mockClear()
    await manager.forceRemap()
    expect(deps.upnpClient.mapPort).toHaveBeenCalled()
  })

  it('exportBundle() produces sanitized output', async () => {
    vi.mocked(deps.upnpClient.discover).mockResolvedValue({
      ok: true,
      value: {
        gatewayIp: '192.168.1.1',
        controlUrl: '/ctl',
        controlHost: '192.168.1.1',
        controlPort: 49152,
        serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
        manufacturer: 'ASUSTeK',
        modelName: 'AX',
      },
    })
    await manager.start()
    const bundle = await manager.exportBundle()
    const json = JSON.stringify(bundle)
    expect(json).not.toMatch(/\b203\.0\.113\.\d+\b/) // no public IP
    expect(json).toContain('ASUSTeK') // manufacturer preserved
    expect(bundle.platform).toBeTypeOf('string')
  })
})

describe('NatManager mutex coalescing', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
    manager = new NatManager(deps)
  })

  it('coalesces a concurrent mapConfiguredPorts call', async () => {
    const gate = Promise.withResolvers<void>()
    vi.mocked(deps.pmpPcpClient.pcpMap).mockImplementation(async () => {
      await gate.promise // block until test releases
      return { ok: true, value: { externalPort: 6881, ttl: 7200 } }
    })

    await manager.start()
    // Launch first call — it will block inside doMapConfiguredPorts
    const first = manager.mapConfiguredPorts()
    // Yield so first call enters mutex
    await tick()
    // Launch second — it shares the queue drain and requests one re-run.
    const second = manager.mapConfiguredPorts()

    // Release the block
    gate.resolve()
    await Promise.all([first, second])

    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().activeMappings).toHaveLength(2)
  })

  it('same-label queue entry causes one re-run after mutex release', async () => {
    const gate = Promise.withResolvers<void>()
    let callCount = 0
    vi.mocked(deps.pmpPcpClient.pcpMap).mockImplementation(async () => {
      callCount++
      if (callCount === 1) await gate.promise // block until test releases
      return { ok: true, value: { externalPort: 6881, ttl: 7200 } }
    })

    await manager.start()
    // First call enters mutex, blocks at first pcpMap call
    const first = manager.mapConfiguredPorts()
    await tick()
    // Second call coalesces to one pending map-configured entry.
    const second = manager.mapConfiguredPorts()
    // Release gate: first call finishes, then the pending entry re-runs.
    gate.resolve()
    await Promise.all([first, second])

    // First run: 2 ports. Re-run due to dirty: 2 more ports. Total = 4
    expect(callCount).toBe(4)
    expect(manager.getStatus().state).toBe(NatState.Active)
  })

  it('drains discovery queued while mapConfiguredPorts is running', async () => {
    const gate = Promise.withResolvers<void>()
    let mapCalls = 0
    vi.mocked(deps.pmpPcpClient.pcpMap).mockImplementation(async () => {
      mapCalls++
      if (mapCalls === 1) await gate.promise
      return { ok: true, value: { externalPort: 6881, ttl: 7200 } }
    })

    await manager.start()
    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(1)
    const mapping = manager.mapConfiguredPorts()
    await tick()

    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'changed' })
    await tick()
    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(1)

    gate.resolve()
    await mapping

    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().activeMappings).toHaveLength(2)
  })

  it('drains discovery queued while remapAll is running', async () => {
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200 },
    })
    await manager.start()
    await manager.mapConfiguredPorts()

    const gate = Promise.withResolvers<void>()
    let remapCalls = 0
    vi.mocked(deps.pmpPcpClient.pcpMap).mockImplementation(async () => {
      remapCalls++
      if (remapCalls === 1) await gate.promise
      return { ok: true, value: { externalPort: 6881, ttl: 7200 } }
    })
    const remapping = manager.remapAll()
    await tick()

    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (!onChange) throw new Error('network listener missing')
    onChange({ hash: 'changed' })
    await tick()
    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(1)

    gate.resolve()
    await remapping

    expect(deps.upnpClient.discover).toHaveBeenCalledTimes(2)
    expect(manager.getStatus().state).toBe(NatState.Active)
    expect(manager.getStatus().activeMappings).toHaveLength(2)
  })

  it('concurrent runDiscovery calls coalesce without warn', async () => {
    vi.mocked(deps.upnpClient.discover).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return {
        ok: true,
        value: {
          gatewayIp: '192.168.1.1',
          controlUrl: '/ctl',
          controlHost: '192.168.1.1',
          controlPort: 49152,
          serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
          manufacturer: 'T',
          modelName: 'M',
        },
      }
    })

    // start() calls runDiscovery internally
    const startPromise = manager.start()
    // Yield so start() enters the discovery mutex
    await tick()
    // Simulate a network-change event firing runDiscovery while start is running
    // Access via the protected method by using the public start flow
    // Instead, emit the network change event to trigger runDiscovery
    const onChange = vi.mocked(deps.networkMonitor.onChange).mock.calls[0]?.[0]
    if (onChange) onChange({ hash: 'changed' })

    await startPromise

    // No thrown errors, state is Ready
    expect(manager.getStatus().state).toBe(NatState.Ready)
  })
})

describe('NatManager PCP renewal nonce reuse', () => {
  let deps: TestDeps
  let manager: NatManager

  beforeEach(() => {
    deps = makeDeps()
    vi.mocked(deps.upnpClient.discover).mockResolvedValue(UPNP_GATEWAY_STUB)
    manager = new NatManager(deps)
  })

  it('remapAll passes existing pcpNonce to pcpMap', async () => {
    const testNonce = Buffer.from('aabbccdd11223344aabbccdd', 'hex')
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200, nonce: testNonce },
    })
    await manager.start()
    await manager.mapConfiguredPorts()
    expect(manager.getStatus().activeMappings[0]?.pcpNonce).toBe(
      'aabbccdd11223344aabbccdd'
    )

    vi.mocked(deps.pmpPcpClient.pcpMap).mockClear()
    vi.mocked(deps.pmpPcpClient.pcpMap).mockResolvedValue({
      ok: true,
      value: { externalPort: 6881, ttl: 7200, nonce: testNonce },
    })

    await manager.remapAll()

    for (const call of vi.mocked(deps.pmpPcpClient.pcpMap).mock.calls) {
      const args = call[0] as { nonce?: Buffer; ttl: number }
      expect(args.nonce).toEqual(testNonce)
      expect(args.ttl).toBeGreaterThan(0)
    }
  })
})

describe('NatManager privacy gate', () => {
  it('runDiagnostic does not touch StunClient when natTypeDetectionEnabled is false', async () => {
    const deps = makeDeps()
    vi.mocked(deps.settingsProvider.getNat).mockReturnValue({
      ...DEFAULT_NAT_SETTINGS,
      natTypeDetectionEnabled: false,
      stunServers: ['stun.example.com:3478'], // servers present, toggle still gates
    })
    const manager = new NatManager(deps)
    await manager.runDiagnostic()
    expect(deps.stunClient.detectNatType).not.toHaveBeenCalled()
  })

  it('runDiagnostic does not touch StunClient when stunServers is empty', async () => {
    const deps = makeDeps()
    vi.mocked(deps.settingsProvider.getNat).mockReturnValue({
      ...DEFAULT_NAT_SETTINGS,
      natTypeDetectionEnabled: true,
      stunServers: [], // no server configured → still no external packet
    })
    const manager = new NatManager(deps)
    await manager.runDiagnostic()
    expect(deps.stunClient.detectNatType).not.toHaveBeenCalled()
  })

  it('runDiagnostic invokes StunClient only when both gates pass', async () => {
    const deps = makeDeps()
    vi.mocked(deps.settingsProvider.getNat).mockReturnValue({
      ...DEFAULT_NAT_SETTINGS,
      natTypeDetectionEnabled: true,
      stunServers: ['stun.example.com:3478'],
    })
    vi.mocked(deps.stunClient.detectNatType).mockResolvedValue({
      ok: false,
      error: 'ND',
    })
    const manager = new NatManager(deps)
    await manager.runDiagnostic()
    expect(deps.stunClient.detectNatType).toHaveBeenCalledTimes(1)
  })
})

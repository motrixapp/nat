import { readFileSync } from 'node:fs'
import type os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { tick } from './__test__/utils.js'
import { NetworkMonitor, type NetworkSnapshot } from './network-monitor.js'
import {
  createCachedNetworkRouteResolver,
  DEFAULT_ROUTE_CACHE_MAX_AGE_MS,
  parseWindowsIpv4DefaultRoutes,
  resolveDefaultNetworkRoute,
  resolveWindowsRouteExecutable,
} from './network-route.js'

const TAILSCALE_ROUTE_PRINT = readFileSync(
  new URL(
    './__test__/fixtures/windows-route-print-tailscale.txt',
    import.meta.url
  ),
  'utf8'
)

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>

function ipv4(
  address: string,
  netmask: string,
  internal = false
): NonNullable<NetworkInterfaces[string]>[number] {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  }
}

describe('Windows default route resolution', () => {
  it('resolves route.exe only beneath an absolute SystemRoot', () => {
    expect(resolveWindowsRouteExecutable('C:\\Windows')).toBe(
      'C:\\Windows\\System32\\route.exe'
    )
    expect(resolveWindowsRouteExecutable('Windows')).toBeNull()
    expect(resolveWindowsRouteExecutable('')).toBeNull()
    expect(
      resolveWindowsRouteExecutable('\\\\server\\share\\Windows')
    ).toBeNull()
  })

  it('parses only complete numeric IPv4 default-route rows', () => {
    expect(parseWindowsIpv4DefaultRoutes(TAILSCALE_ROUTE_PRINT)).toEqual([
      {
        gatewayIp: '10.0.0.1',
        internalIp: '10.0.0.42',
        metric: 25,
      },
    ])
  })

  it('selects the physical default route instead of a Tailscale interface', () => {
    const resolved = resolveDefaultNetworkRoute({
      platform: 'win32',
      interfaces: {
        Tailscale: [ipv4('169.254.40.20', '255.255.0.0')],
        'Wi-Fi': [ipv4('10.0.0.42', '255.255.255.0')],
      },
      windowsRouteTable: TAILSCALE_ROUTE_PRINT,
    })

    expect(resolved).toEqual({
      gatewayIp: '10.0.0.1',
      internalIp: '10.0.0.42',
    })
  })

  it('uses the lowest metric among physical routes', () => {
    const resolved = resolveDefaultNetworkRoute({
      platform: 'win32',
      interfaces: {
        Ethernet: [ipv4('192.168.1.20', '255.255.255.0')],
        'Wi-Fi': [ipv4('10.0.0.42', '255.255.255.0')],
      },
      windowsRouteTable: `
        0.0.0.0  0.0.0.0  192.168.1.1  192.168.1.20  55
        0.0.0.0  0.0.0.0  10.0.0.1     10.0.0.42     25
      `,
    })

    expect(resolved).toEqual({
      gatewayIp: '10.0.0.1',
      internalIp: '10.0.0.42',
    })
  })

  it('prefers a physical route over a lower-metric virtual route', () => {
    const resolved = resolveDefaultNetworkRoute({
      platform: 'win32',
      interfaces: {
        'Tailscale Tunnel': [ipv4('100.100.20.30', '255.255.255.255')],
        Ethernet: [ipv4('192.168.1.20', '255.255.255.0')],
      },
      windowsRouteTable: `
        0.0.0.0  0.0.0.0  100.100.20.1  100.100.20.30  1
        0.0.0.0  0.0.0.0  192.168.1.1   192.168.1.20  25
      `,
    })

    expect(resolved).toEqual({
      gatewayIp: '192.168.1.1',
      internalIp: '192.168.1.20',
    })
  })

  it('falls back to a physical private interface before route data arrives', () => {
    const resolved = resolveDefaultNetworkRoute({
      platform: 'win32',
      interfaces: {
        Tailscale: [ipv4('169.254.40.20', '255.255.0.0')],
        'Hyper-V Virtual Ethernet': [ipv4('172.20.0.1', '255.255.240.0')],
        'Wi-Fi': [ipv4('10.8.4.42', '255.255.252.0')],
      },
    })

    expect(resolved).toEqual({
      gatewayIp: '10.8.4.1',
      internalIp: '10.8.4.42',
    })
  })

  it('returns an empty snapshot when only link-local interfaces exist', () => {
    const resolved = resolveDefaultNetworkRoute({
      platform: 'win32',
      interfaces: {
        Tailscale: [ipv4('169.254.40.20', '255.255.0.0')],
      },
      windowsRouteTable: TAILSCALE_ROUTE_PRINT,
    })

    expect(resolved).toEqual({ gatewayIp: '', internalIp: '' })
  })
})

describe('background network route resolution', () => {
  const wlanInterfaces: NetworkInterfaces = {
    'Wi-Fi': [ipv4('10.0.0.42', '255.255.255.0')],
  }
  const firstRoute = '0.0.0.0 0.0.0.0 10.0.0.1 10.0.0.42 25'
  const changedRoute = '0.0.0.0 0.0.0.0 10.0.0.254 10.0.0.42 5'

  it('awaits a verified route instead of accepting the first NIC fallback', async () => {
    let reads = 0
    const interfaces: NetworkInterfaces = {
      Ethernet: [ipv4('192.168.1.20', '255.255.255.0')],
      'Wi-Fi': [ipv4('10.0.0.42', '255.255.255.0')],
    }
    const resolve = createCachedNetworkRouteResolver({
      platform: 'win32',
      readInterfaces: () => interfaces,
      readWindowsRouteTable: async () => {
        reads++
        return changedRoute
      },
      now: () => 1_000,
    })

    expect(resolve()).toEqual({
      gatewayIp: '192.168.1.1',
      internalIp: '192.168.1.20',
    })
    await expect(resolve.verified()).resolves.toEqual({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.42',
    })
    expect(reads).toBe(1)
  })

  it('returns fallback immediately and single-flights adjacent calls', async () => {
    let reads = 0
    let finishRead: ((output: string) => void) | undefined
    const resolve = createCachedNetworkRouteResolver({
      platform: 'win32',
      readInterfaces: () => wlanInterfaces,
      readWindowsRouteTable: () => {
        reads++
        return new Promise((resolveRead) => {
          finishRead = resolveRead
        })
      },
      now: () => 1_000,
    })

    expect(resolve()).toEqual({
      gatewayIp: '10.0.0.1',
      internalIp: '10.0.0.42',
    })
    expect(resolve()).toEqual({
      gatewayIp: '10.0.0.1',
      internalIp: '10.0.0.42',
    })
    expect(reads).toBe(0)
    await Promise.resolve()
    expect(reads).toBe(1)

    finishRead?.(changedRoute)
    await tick()
    expect(resolve()).toEqual({
      gatewayIp: '10.0.0.254',
      internalIp: '10.0.0.42',
    })
  })

  it('refreshes route and metric changes after cache expiry', async () => {
    let reads = 0
    let now = 0
    let routeTable = firstRoute
    const resolve = createCachedNetworkRouteResolver({
      platform: 'win32',
      readInterfaces: () => wlanInterfaces,
      readWindowsRouteTable: async () => {
        reads++
        return routeTable
      },
      now: () => now,
    })

    expect(resolve().gatewayIp).toBe('10.0.0.1')
    await tick()
    expect(reads).toBe(1)

    routeTable = changedRoute
    now = DEFAULT_ROUTE_CACHE_MAX_AGE_MS - 1
    expect(resolve().gatewayIp).toBe('10.0.0.1')
    expect(reads).toBe(1)

    now = DEFAULT_ROUTE_CACHE_MAX_AGE_MS
    expect(resolve().gatewayIp).toBe('10.0.0.1')
    await tick()
    expect(resolve().gatewayIp).toBe('10.0.0.254')
    expect(reads).toBe(2)
  })

  it('negatively caches route-command failures', async () => {
    let reads = 0
    let now = 0
    const resolve = createCachedNetworkRouteResolver({
      platform: 'win32',
      readInterfaces: () => wlanInterfaces,
      readWindowsRouteTable: async () => {
        reads++
        throw new Error('route.exe timed out')
      },
      now: () => now,
    })

    expect(resolve()).toEqual({
      gatewayIp: '10.0.0.1',
      internalIp: '10.0.0.42',
    })
    await tick()
    expect(resolve()).toEqual({
      gatewayIp: '10.0.0.1',
      internalIp: '10.0.0.42',
    })
    expect(reads).toBe(1)

    now = DEFAULT_ROUTE_CACHE_MAX_AGE_MS
    resolve()
    await tick()
    expect(reads).toBe(2)
  })

  it('refreshes immediately when interface topology changes', async () => {
    let reads = 0
    let interfaces = wlanInterfaces
    const resolve = createCachedNetworkRouteResolver({
      platform: 'win32',
      readInterfaces: () => interfaces,
      readWindowsRouteTable: async () => {
        reads++
        return firstRoute
      },
      now: () => 1_000,
    })

    expect(resolve().gatewayIp).toBe('10.0.0.1')
    await tick()
    interfaces = {
      ...wlanInterfaces,
      Tailscale: [ipv4('169.254.40.20', '255.255.0.0')],
    }
    expect(resolve().gatewayIp).toBe('10.0.0.1')
    await tick()
    expect(reads).toBe(2)
  })

  it('observes a same-interface route change within four default polls', async () => {
    vi.useFakeTimers()
    let reads = 0
    let now = 0
    let routeTable = firstRoute
    const resolve = createCachedNetworkRouteResolver({
      platform: 'win32',
      readInterfaces: () => wlanInterfaces,
      readWindowsRouteTable: async () => {
        reads++
        return routeTable
      },
      now: () => now,
    })
    const snapshot = (): NetworkSnapshot => {
      const route = resolve()
      return { ...route, hash: `${route.gatewayIp}|${route.internalIp}` }
    }
    const monitor = new NetworkMonitor({
      intervalMs: 5_000,
      stableRounds: 2,
      snapshotFn: snapshot,
    })
    const changes: NetworkSnapshot[] = []
    monitor.onChange((change) => changes.push(change))

    try {
      monitor.start()
      await vi.advanceTimersByTimeAsync(0)
      routeTable = changedRoute
      for (const timestamp of [5_000, 10_000, 15_000, 20_000]) {
        now = timestamp
        await vi.advanceTimersByTimeAsync(5_000)
      }

      expect(changes).toEqual([
        {
          gatewayIp: '10.0.0.254',
          internalIp: '10.0.0.42',
          hash: '10.0.0.254|10.0.0.42',
        },
      ])
      expect(reads).toBe(3)
    } finally {
      monitor.stop()
      vi.useRealTimers()
    }
  })
})

import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {
  isIpv4String,
  isLinkLocalIpv4,
  isLoopbackIpv4,
  isPrivateIpv4,
  parseIpv4,
} from './codecs/ip-utils.js'

const MAX_ROUTE_PRINT_BYTES = 1024 * 1024
const ROUTE_PRINT_TIMEOUT_MS = 1000

/**
 * NetworkMonitor.snapshot() remains synchronous by returning cached or
 * interface-derived data while route.exe refreshes in the background.
 */
export const DEFAULT_ROUTE_CACHE_MAX_AGE_MS = 10_000

const VIRTUAL_INTERFACE_RE =
  /(?:tailscale|wireguard|wintun|zerotier|\bvpn\b|\btap\b|hyper-v|vethernet|vmware|virtualbox|docker|\bwsl\b)/i

export interface ResolvedNetworkRoute {
  gatewayIp: string
  internalIp: string
}

export interface WindowsIpv4DefaultRoute extends ResolvedNetworkRoute {
  metric: number
}

interface NetworkCandidate {
  address: string
  name: string
  netmask: string
  virtual: boolean
}

interface NetworkRouteOptions {
  platform?: NodeJS.Platform
  interfaces?: ReturnType<typeof os.networkInterfaces>
  windowsRouteTable?: string
}

interface CachedNetworkRouteOptions {
  platform?: NodeJS.Platform
  readInterfaces?: () => ReturnType<typeof os.networkInterfaces>
  readWindowsRouteTable?: () => Promise<string>
  now?: () => number
  maxAgeMs?: number
}

interface CachedNetworkRoute {
  fingerprint: string
  refreshedAt: number
  route: ResolvedNetworkRoute
}

export interface CachedNetworkRouteResolver {
  (): ResolvedNetworkRoute
  verified(): Promise<ResolvedNetworkRoute>
}

interface RefreshContext {
  fallback: ResolvedNetworkRoute
  fingerprint: string
  interfaces: ReturnType<typeof os.networkInterfaces>
}

/**
 * Create a non-blocking synchronous route snapshot backed by async refreshes.
 *
 * Interface topology changes bypass the cache immediately (for example when
 * Tailscale connects or disconnects). Route/metric-only changes are detected
 * when maxAgeMs expires. Only one route command runs at a time. Failures are
 * negatively cached so endpoint-policy blocks cannot cause a process storm.
 */
export function createCachedNetworkRouteResolver(
  options: CachedNetworkRouteOptions = {}
): CachedNetworkRouteResolver {
  const platform = options.platform ?? process.platform
  const readInterfaces =
    options.readInterfaces ?? (() => os.networkInterfaces())
  const now = options.now ?? (() => Date.now())
  const maxAgeMs = Math.max(
    1,
    options.maxAgeMs ?? DEFAULT_ROUTE_CACHE_MAX_AGE_MS
  )
  let cached: CachedNetworkRoute | null = null
  let inFlight: Promise<void> | null = null
  let inFlightFingerprint = ''
  let latestFingerprint = ''
  let pending: RefreshContext | null = null

  const startRefresh = (context: RefreshContext): Promise<void> | null => {
    if (platform !== 'win32') return null
    if (inFlight) {
      pending = inFlightFingerprint === context.fingerprint ? null : context
      return inFlight
    }

    inFlightFingerprint = context.fingerprint
    const task = Promise.resolve()
      .then(options.readWindowsRouteTable ?? readWindowsRouteTable)
      .then((output) => {
        if (latestFingerprint !== context.fingerprint) return
        cached = {
          fingerprint: context.fingerprint,
          refreshedAt: now(),
          route: resolveDefaultNetworkRoute({
            platform,
            interfaces: context.interfaces,
            windowsRouteTable: output,
          }),
        }
      })
      .catch(() => {
        if (latestFingerprint !== context.fingerprint) return
        cached = {
          fingerprint: context.fingerprint,
          refreshedAt: now(),
          route: context.fallback,
        }
      })
      .finally(() => {
        if (inFlight !== task) return
        inFlight = null
        inFlightFingerprint = ''
        const next = pending
        pending = null
        if (next && next.fingerprint === latestFingerprint) {
          startRefresh(next)
        }
      })
    inFlight = task
    return task
  }

  const resolve = (): ResolvedNetworkRoute => {
    const interfaces = readInterfaces()
    const fingerprint = networkInterfacesFingerprint(interfaces)
    latestFingerprint = fingerprint
    const timestamp = now()
    const fallback = resolveDefaultNetworkRoute({ platform, interfaces })
    const matchingCache = cached?.fingerprint === fingerprint ? cached : null
    const route = matchingCache?.route ?? fallback
    const cacheFresh =
      matchingCache !== null &&
      timestamp >= matchingCache.refreshedAt &&
      timestamp - matchingCache.refreshedAt < maxAgeMs
    if (!cacheFresh) {
      startRefresh({ fallback, fingerprint, interfaces })
    }
    return route
  }

  resolve.verified = async (): Promise<ResolvedNetworkRoute> => {
    if (platform !== 'win32') return resolve()

    // If topology changes while route.exe is in flight, loop onto the pending
    // single-flight refresh so the returned route always matches the latest
    // interface fingerprint observed here.
    for (;;) {
      const interfaces = readInterfaces()
      const fingerprint = networkInterfacesFingerprint(interfaces)
      latestFingerprint = fingerprint
      const timestamp = now()
      const fallback = resolveDefaultNetworkRoute({ platform, interfaces })
      const matchingCache = cached?.fingerprint === fingerprint ? cached : null
      const cacheFresh =
        matchingCache !== null &&
        timestamp >= matchingCache.refreshedAt &&
        timestamp - matchingCache.refreshedAt < maxAgeMs
      if (cacheFresh) return matchingCache.route

      const refresh = startRefresh({ fallback, fingerprint, interfaces })
      if (refresh) await refresh

      const latestInterfaces = readInterfaces()
      const latest = networkInterfacesFingerprint(latestInterfaces)
      if (latest !== fingerprint) continue
      const verifiedCache = cached?.fingerprint === fingerprint ? cached : null
      if (verifiedCache) return verifiedCache.route
      if (inFlight) continue
      return fallback
    }
  }

  return resolve
}

/**
 * Resolve the IPv4 route that should reach the local NAT gateway.
 *
 * Windows gets its gateway and source address from the kernel route table.
 * Other platforms, and Windows installations where route.exe is unavailable,
 * use a conservative interface fallback.
 */
export function resolveDefaultNetworkRoute(
  options: NetworkRouteOptions = {}
): ResolvedNetworkRoute {
  const platform = options.platform ?? process.platform
  const interfaces = options.interfaces ?? os.networkInterfaces()
  const candidates = collectNetworkCandidates(interfaces)

  if (platform === 'win32' && options.windowsRouteTable !== undefined) {
    const route = selectWindowsDefaultRoute(
      parseWindowsIpv4DefaultRoutes(options.windowsRouteTable),
      candidates
    )
    if (route) {
      return {
        gatewayIp: route.gatewayIp,
        internalIp: route.internalIp,
      }
    }
  }

  return fallbackNetworkRoute(candidates)
}

/** Parse numeric Active Routes rows from locale-independent route.exe output. */
export function parseWindowsIpv4DefaultRoutes(
  output: string
): WindowsIpv4DefaultRoute[] {
  if (output.length > MAX_ROUTE_PRINT_BYTES) return []

  const routes: WindowsIpv4DefaultRoute[] = []
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (
      columns.length !== 5 ||
      columns[0] !== '0.0.0.0' ||
      columns[1] !== '0.0.0.0'
    ) {
      continue
    }

    const gatewayIp = columns[2] ?? ''
    const internalIp = columns[3] ?? ''
    const metricText = columns[4] ?? ''
    if (!isUsableRouteAddress(gatewayIp) || !isUsableRouteAddress(internalIp)) {
      continue
    }
    if (!/^\d+$/.test(metricText)) continue
    const metric = Number(metricText)
    if (!Number.isSafeInteger(metric)) continue

    routes.push({ gatewayIp, internalIp, metric })
  }

  return routes
}

export function resolveWindowsRouteExecutable(
  systemRoot = process.env.SystemRoot
): string | null {
  if (!systemRoot) return null
  const normalized = path.win32.normalize(systemRoot)
  if (!/^[A-Za-z]:\\/.test(normalized) || !path.win32.isAbsolute(normalized)) {
    return null
  }
  return path.win32.join(normalized, 'System32', 'route.exe')
}

function readWindowsRouteTable(): Promise<string> {
  const executable = resolveWindowsRouteExecutable()
  if (!executable) {
    return Promise.reject(
      new Error('SystemRoot is missing or is not an absolute Windows path')
    )
  }
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['PRINT', '-4'],
      {
        encoding: 'utf8',
        maxBuffer: MAX_ROUTE_PRINT_BYTES,
        timeout: ROUTE_PRINT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
  })
}

function selectWindowsDefaultRoute(
  routes: readonly WindowsIpv4DefaultRoute[],
  candidates: readonly NetworkCandidate[]
): WindowsIpv4DefaultRoute | null {
  const candidateByAddress = new Map<string, NetworkCandidate>()
  for (const candidate of candidates) {
    const existing = candidateByAddress.get(candidate.address)
    if (!existing || (existing.virtual && !candidate.virtual)) {
      candidateByAddress.set(candidate.address, candidate)
    }
  }

  const available = routes.filter((route) =>
    candidateByAddress.has(route.internalIp)
  )
  available.sort((a, b) => {
    const aVirtual = candidateByAddress.get(a.internalIp)?.virtual ? 1 : 0
    const bVirtual = candidateByAddress.get(b.internalIp)?.virtual ? 1 : 0
    return aVirtual - bVirtual || a.metric - b.metric
  })
  return available[0] ?? null
}

function collectNetworkCandidates(
  interfaces: ReturnType<typeof os.networkInterfaces>
): NetworkCandidate[] {
  const candidates: NetworkCandidate[] = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue
    for (const address of addresses) {
      if (
        address.family !== 'IPv4' ||
        address.internal ||
        !isUsableRouteAddress(address.address)
      ) {
        continue
      }
      candidates.push({
        address: address.address,
        name,
        netmask: address.netmask,
        virtual: VIRTUAL_INTERFACE_RE.test(name),
      })
    }
  }
  return candidates
}

function networkInterfacesFingerprint(
  interfaces: ReturnType<typeof os.networkInterfaces>
): string {
  const entries: string[] = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue
    for (const address of addresses) {
      if (address.family !== 'IPv4') continue
      entries.push(
        JSON.stringify([
          name,
          address.address,
          address.netmask,
          address.internal,
        ])
      )
    }
  }
  return entries.sort().join('\n')
}

function fallbackNetworkRoute(
  candidates: readonly NetworkCandidate[]
): ResolvedNetworkRoute {
  const ranked = [...candidates].sort((a, b) => {
    const aScore = (a.virtual ? 100 : 0) + (isPrivateIpv4(a.address) ? 0 : 10)
    const bScore = (b.virtual ? 100 : 0) + (isPrivateIpv4(b.address) ? 0 : 10)
    return aScore - bScore
  })
  const selected = ranked[0]
  if (!selected) return { gatewayIp: '', internalIp: '' }
  return {
    gatewayIp: deriveProbableGateway(selected.address, selected.netmask),
    internalIp: selected.address,
  }
}

function isUsableRouteAddress(address: string): boolean {
  if (
    !isIpv4String(address) ||
    isLinkLocalIpv4(address) ||
    isLoopbackIpv4(address) ||
    address === '0.0.0.0'
  ) {
    return false
  }
  const parsed = parseIpv4(address)
  return parsed.ok && parsed.value[0] > 0 && parsed.value[0] < 224
}

function deriveProbableGateway(address: string, netmask: string): string {
  const ip = ipv4ToUint32(address)
  const mask = ipv4ToUint32(netmask)
  if (ip === null || mask === null) return ''
  const hostMask = ~mask >>> 0
  if (hostMask < 2) return ''
  return uint32ToIpv4(((ip & mask) >>> 0) + 1)
}

function ipv4ToUint32(address: string): number | null {
  const parsed = parseIpv4(address)
  if (!parsed.ok) return null
  const [a, b, c, d] = parsed.value
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0) as number
}

function uint32ToIpv4(value: number): string {
  const normalized = value >>> 0
  return `${normalized >>> 24}.${(normalized >>> 16) & 0xff}.${(normalized >>> 8) & 0xff}.${normalized & 0xff}`
}

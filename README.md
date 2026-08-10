# @motrix/nat

English | [简体中文](./README.zh-CN.md)

`@motrix/nat` is a dependency-free, security-focused NAT discovery and port
mapping toolkit for Node.js. It supports UPnP IGD v1/v2, NAT-PMP, PCP, and
STUN, from a lifecycle manager down to strict wire-format codecs.

Use it when a desktop app, P2P service, game server, self-hosted tool, or
download client needs to:

- discover a local gateway and its public IPv4 address;
- create, renew, and remove TCP or UDP port mappings;
- prefer PCP and fall back through NAT-PMP and UPnP;
- query a STUN server for the observed public endpoint;
- react to network changes without duplicating lifecycle logic; or
- parse untrusted router responses with bounded, fail-closed codecs.

## Why `@motrix/nat`

- **One package, three abstraction levels.** Use `NatManager`, call a protocol
  client directly, or consume the codecs and transport interfaces.
- **Secure by default.** UPnP control endpoints must be literal private or
  link-local IPv4 addresses. Redirects, DNS names, loopback targets, malformed
  packets, and unsafe XML constructs are rejected.
- **Designed for long-running applications.** The manager handles discovery,
  protocol fallback, mapping renewal, retry backoff, network-change recovery,
  and best-effort cleanup during shutdown.
- **Easy to integrate and test.** HTTP, UDP, settings, lifecycle hooks, clocks,
  and network snapshots are injected behind small interfaces.
- **Zero runtime dependencies.** The published package uses only Node.js
  built-ins and the global `fetch` implementation provided by Node.js.

## Standards and protocol model

NAT traversal is not one protocol. Port-mapping protocols ask a gateway to
create inbound forwarding state, while STUN reports the transport address an
endpoint appears to use on the far side of a NAT.

The general NAT terminology follows [RFC 2663](https://www.rfc-editor.org/rfc/rfc2663.html).
In this README, a private IPv4 address means one of the address blocks reserved
by [RFC 1918](https://www.rfc-editor.org/rfc/rfc1918.html): `10.0.0.0/8`,
`172.16.0.0/12`, or `192.168.0.0/16`.

The terms used throughout this README mean:

- **Internal address and port:** the private transport endpoint on the local
  host.
- **External or mapped address and port:** the endpoint exposed by the NAT to
  the external network.
- **Port mapping:** an explicit forwarding rule from an external protocol and
  port to an internal protocol and port.
- **Mapping lifetime or TTL:** the lease duration in seconds. A client must
  renew the mapping before it expires; a lifetime of zero deletes a mapping in
  NAT-PMP and PCP.
- **Server-reflexive address:** the IP address and port observed by a STUN
  server after any intervening NAT translation.

### Implemented standards

| Protocol | Standard | Standard role | Implementation in this package |
| --- | --- | --- | --- |
| UPnP IGD | [OCF UPnP IGD 2.0 device control protocol](https://openconnectivity.org/developer/specifications/upnp-resources/upnp/internet-gateway-device-igd-v-2-0/) | Discovers an Internet Gateway Device and invokes WAN connection actions through SSDP, HTTP device descriptions, and SOAP | IGD v1/v2 discovery; `AddPortMapping`, `DeletePortMapping`, and `GetExternalIPAddress`; multicast SSDP on `239.255.255.250:1900` |
| NAT-PMP | [RFC 6886](https://www.rfc-editor.org/rfc/rfc6886.html) | Requests the external IPv4 address and TCP/UDP mappings from the default gateway | Version 0 requests over UDP port `5351`; external-address, create, renew, and delete operations; serialized requests because NAT-PMP has no transaction ID |
| PCP | [RFC 6887](https://www.rfc-editor.org/rfc/rfc6887.html) | Controls mappings in NATs and firewalls, including CGN and IPv6 transition environments | Version 2 MAP requests over UDP port `5351`; TCP/UDP mappings; nonce-correlated create, renew, and delete operations |
| STUN | [RFC 8489](https://www.rfc-editor.org/rfc/rfc8489.html) | Lets an endpoint learn its server-reflexive transport address and supports larger traversal mechanisms | Basic UDP Binding request/response; explicit `host:port` servers; `MAPPED-ADDRESS` and `XOR-MAPPED-ADDRESS`; the RFC default port is `3478`, but this package requires the caller to include it |

### NAT behavior terminology

[RFC 4787](https://www.rfc-editor.org/rfc/rfc4787.html) describes UDP NATs by
their individual mapping and filtering behaviors. It avoids treating the older
full-cone, restricted-cone, port-restricted-cone, and symmetric labels as a
complete NAT taxonomy because those labels do not capture all real-world
behavior.

| Behavior | Mapping definition | Filtering definition |
| --- | --- | --- |
| Endpoint-independent | Reuses the same external mapping for a given internal endpoint regardless of the remote endpoint | Once the mapping exists, accepts packets from any external endpoint |
| Address-dependent | Reuses the mapping only when the remote IP address is the same; the remote port may differ | Accepts packets only from a remote IP address to which the internal endpoint has already sent |
| Address-and-port-dependent | Reuses the mapping only when both the remote IP address and port are the same | Accepts packets only from the exact remote IP address and port to which the internal endpoint has already sent |

Mapping and filtering are separate dimensions. A single STUN Binding result
reveals one server-reflexive endpoint; it does not classify either dimension.

The protocol table describes both the standards and this package's current
profile.
It does not imply full implementation of every optional operation, transport,
authentication mode, extension, or address family in those specifications.
In particular, STUN is a building block rather than a complete traversal
solution, and this release does not implement ICE or TURN.

## Requirements and installation

- Node.js 22 or later
- ESM

```bash
pnpm add @motrix/nat
```

Equivalent npm and Yarn commands work as expected:

```bash
npm install @motrix/nat
yarn add @motrix/nat
```

## Quick start: create a UPnP mapping

This is the shortest path when you only need UPnP. Replace the example
`internalIp` with the private IPv4 address of the interface that accepts the
incoming connection.

```ts
import {
  nodeHttpClient,
  nodeUdpSocketFactory,
  UpnpClient,
} from '@motrix/nat'

const upnp = new UpnpClient({
  udpFactory: nodeUdpSocketFactory,
  http: nodeHttpClient,
})

const discovered = await upnp.discover({ timeoutMs: 3_000 })
if (!discovered.ok) {
  throw new Error(
    `UPnP discovery failed: ${discovered.error} (${discovered.detail ?? 'no detail'})`
  )
}

const gateway = discovered.value
const mapping = {
  internalIp: '192.168.1.25',
  internalPort: 51413,
  externalPort: 51413,
  protocol: 'TCP' as const,
  ttl: 3_600,
  description: 'my-app',
}

const mapped = await upnp.mapPort(gateway, mapping)
if (!mapped.ok) {
  throw new Error(
    `UPnP mapping failed: ${mapped.error} (${mapped.detail ?? 'no detail'})`
  )
}

try {
  const externalIp = await upnp.getExternalIp(gateway)
  if (externalIp.ok) {
    console.log(`Listening on ${externalIp.value}:${mapping.externalPort}`)
  }
} finally {
  await upnp.unmapPort(gateway, {
    externalPort: mapping.externalPort,
    protocol: mapping.protocol,
  })
}
```

## Choose the right API level

| Goal | Recommended API |
| --- | --- |
| Manage discovery, fallback, renewal, retries, and shutdown | `NatManager` |
| Discover or map through UPnP IGD | `UpnpClient` |
| Create PCP or NAT-PMP mappings | `PmpPcpClient` |
| Query the public endpoint observed by a STUN server | `StunClient` |
| Check a mapped port through an application-owned HTTPS service | `PortChecker` |
| Observe stable local-interface changes | `NetworkMonitor` |
| Build or inspect protocol packets | `codecs` or named codec exports |
| Share NAT state with a browser or renderer bundle | `@motrix/nat/types` |

## Return values and errors

Protocol and transport operations return a discriminated `ParseResult<T>`:

```ts
import type { ParseResult } from '@motrix/nat'

function valueOrThrow<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    const suffix = result.detail ? `: ${result.detail}` : ''
    throw new Error(`${result.error}${suffix}`)
  }
  return result.value
}
```

This keeps expected network, validation, and protocol failures out of
exception control flow. Constructor misuse and invalid imperative updates may
still throw; for example, `PmpPcpClient.setGatewayIp()` throws `RangeError` for
an invalid IPv4 address.

`NatErrorCode` contains the stable package-level error codes:

| Code | Meaning |
| --- | --- |
| `NAT_DISCOVERY_FAILED` | No supported gateway was discovered |
| `NAT_MAPPING_FAILED` | A mapping could not be created |
| `NAT_MAPPING_CONFLICT` | The requested mapping conflicts with an existing entry |
| `NAT_PROTOCOL_REJECTED` | Input or a router response violates the protocol contract |
| `NAT_PARSE_ERROR` | A response could not be decoded safely |
| `NAT_SECURITY_VIOLATION` | A security boundary or origin check failed |
| `NAT_TIMEOUT` | An operation timed out or was aborted |
| `NAT_NETWORK_CHANGED` | An operation was invalidated by a network change or shutdown |
| `NAT_GATEWAY_UNREACHABLE` | The gateway transport failed |
| `STUN_DETECTION_FAILED` | No configured STUN server returned a usable response |

`NatManager` may also emit `NAT_SECURITY_WARNING` when NAT-PMP is selected,
because NAT-PMP responses are unauthenticated. Treat it as a warning rather
than a failed mapping.

## High-level lifecycle management

`NatManager` coordinates the protocol clients and application lifecycle. Its
public methods are:

| Method | Behavior |
| --- | --- |
| `start()` / `enable()` | Subscribe to hooks, start monitoring, and discover a gateway |
| `mapConfiguredPorts()` | Map the configured TCP listen and UDP DHT ports |
| `remapAll()` / `forceRemap()` | Renew or recreate active mappings |
| `getStatus()` | Return a snapshot of state, gateway, mappings, retries, and last error |
| `runDiagnostic()` | Run the currently available minimal STUN diagnostic |
| `exportBundle()` | Export a privacy-reduced diagnostic bundle with masked local IPs |
| `stop()` / `disable()` | Abort work, unmap ports, stop monitoring, and close UDP resources |

The manager is intentionally adapter-based. A complete setup looks like this:

```ts
import {
  NatManager,
  NatState,
  NetworkMonitor,
  ipv4ToBuffer,
  nodeHttpClient,
  nodeUdpSocketFactory,
  PmpPcpClient,
  PortChecker,
  StunClient,
  UpnpClient,
  type NatEvent,
} from '@motrix/nat'

function toIpv4MappedAddress(ip: string): Buffer {
  return Buffer.concat([
    Buffer.alloc(10),
    Buffer.from([0xff, 0xff]),
    ipv4ToBuffer(ip),
  ])
}

const networkMonitor = new NetworkMonitor()
const network = networkMonitor.snapshot()
if (!network.internalIp || !network.gatewayIp) {
  throw new Error('No usable private IPv4 interface was detected')
}

const manager = new NatManager({
  settingsProvider: {
    getEngine: () => ({ listenPort: 51413, dhtListenPort: 51413 }),
    getNat: () => ({
      enabled: true,
      preferredProtocol: 'auto',
      mappingTtl: 3_600,
      natTypeDetectionEnabled: false,
      stunServers: [],
      portReachabilityCheckEnabled: false,
      portCheckerEndpoints: [],
    }),
  },
  hooks: {
    // Replace these no-op adapters with subscriptions to your app lifecycle.
    onReady: () => () => {},
    onConfigChanged: () => () => {},
  },
  onEvent: (event: NatEvent) => console.log('NAT event', event),
  upnpClient: new UpnpClient({
    udpFactory: nodeUdpSocketFactory,
    http: nodeHttpClient,
  }),
  pmpPcpClient: new PmpPcpClient({
    udpFactory: nodeUdpSocketFactory,
    gatewayIp: network.gatewayIp,
    clientIp: toIpv4MappedAddress(network.internalIp),
  }),
  stunClient: new StunClient({ udpFactory: nodeUdpSocketFactory }),
  portChecker: new PortChecker(),
  networkMonitor,
})

await manager.start()
if (manager.getStatus().state === NatState.Ready) {
  await manager.mapConfiguredPorts()
}

console.log(manager.getStatus())

// Call during application shutdown.
await manager.stop()
```

In an event-driven application, implement `NatManagerHooks.onReady()` and
`onConfigChanged()` with your event bus. The manager will then map ports when
the application becomes ready and remap them after relevant configuration
changes.

### Manager events

The `onEvent` callback receives a `NatEvent` union:

- `state-changed`
- `error`
- `gateway-changed`
- `mapping-updated`
- `diagnostic-completed`

`NatState` progresses through `idle`, `discovering`, `ready`, `mapping`,
`active`, `failed`, `stopping`, and `stopped`.

## Protocol clients

### UPnP IGD

`UpnpClient` supports:

- `discover(options?)`
- `mapPort(gateway, params, signal?)`
- `unmapPort(gateway, params, signal?)`
- `getExternalIp(gateway, signal?)`

Discovery sends one M-SEARCH request for each configured search target. The
default targets cover IGD v1 and v2, with a 3-second timeout and at most 10
responses. Pass an `AbortSignal` to mapping operations when they belong to a
larger cancellable lifecycle.

### PCP and NAT-PMP

Use one `PmpPcpClient` per local gateway and close it during shutdown:

```ts
import {
  ipv4ToBuffer,
  nodeUdpSocketFactory,
  PmpPcpClient,
} from '@motrix/nat'

const clientIp = Buffer.concat([
  Buffer.alloc(10),
  Buffer.from([0xff, 0xff]),
  ipv4ToBuffer('192.168.1.25'),
])

const client = new PmpPcpClient({
  udpFactory: nodeUdpSocketFactory,
  gatewayIp: '192.168.1.1',
  clientIp,
})

try {
  const created = await client.pcpMap({
    protocol: 'TCP',
    internalPort: 51413,
    externalPort: 51413,
    ttl: 3_600,
    timeoutMs: 1_000,
  })

  if (created.ok) {
    // PCP requires the original nonce when deleting a mapping.
    await client.pcpMap({
      protocol: 'TCP',
      internalPort: created.value.internalPort,
      externalPort: created.value.externalPort,
      ttl: 0,
      nonce: created.value.nonce,
    })
  }
} finally {
  await client.close()
}
```

The same client exposes:

- `natPmpGetExternalIp({ timeoutMs, signal }?)`
- `natPmpMap({ protocol, internalPort, externalPort, ttl, timeoutMs, signal })`
- `pcpMap({ protocol, internalPort, externalPort, ttl, timeoutMs, signal, nonce })`
- `setGatewayIp(ip)`
- `close()`

NAT-PMP requests are serialized because the protocol has no transaction
correlator. PCP requests are correlated by nonce and allow up to four
concurrent requests per client.

### STUN endpoint discovery

```ts
import { nodeUdpSocketFactory, StunClient } from '@motrix/nat'

const stun = new StunClient({ udpFactory: nodeUdpSocketFactory })
const observed = await stun.detectNatType({
  servers: ['stun.example.net:3478'],
  timeoutMs: 2_000,
})

if (observed.ok) {
  console.log(observed.value.mappedIp, observed.value.mappedPort)
}
```

Despite the current method name, this release returns the mapped public IP and
port observed by the first responding server. Distinguishing legacy
cone/symmetric labels or RFC 4787 mapping and filtering behaviors requires
multi-server behavior tests and is not implemented yet.

## Supporting APIs

### Network monitoring

`NetworkMonitor` polls snapshots and emits a change only after the new snapshot
has remained stable for a configurable number of rounds:

```ts
const monitor = new NetworkMonitor({
  intervalMs: 5_000,
  stableRounds: 2,
  snapshotFn: readPlatformNetworkSnapshot,
})

const unsubscribe = monitor.onChange((snapshot) => {
  console.log('Network changed', snapshot)
})

monitor.start()
// Later:
unsubscribe()
monitor.stop()
```

For production routing decisions, inject a platform-aware `snapshotFn`. The
default implementation selects the first non-internal IPv4 interface and
estimates a `/24` gateway ending in `.1`; it does not inspect the operating
system routing table.

### Port reachability checks

`PortChecker` calls application-configured HTTPS endpoints with `ip` and `port`
query parameters. No endpoint is built in, and the feature performs no request
unless the caller explicitly invokes it.

```ts
const result = await new PortChecker().checkPortReachable({
  endpoints: ['https://status.example.net/check-port'],
  externalIp: '203.0.113.10',
  port: 51413,
  timeoutMs: 3_000,
})
```

The service response should contain an unambiguous word such as `open`,
`closed`, `reachable`, or `unreachable`. For a structured API, inject a custom
`fetcher` through `PortCheckerOptions`.

### Logger injection

Logging is a no-op by default. Inject a pino-compatible logger once during
application startup:

```ts
import pino from 'pino'
import { setNatLogger } from '@motrix/nat'

setNatLogger(pino())
```

The required `NatLogger` surface is only `child`, `debug`, `info`, `warn`, and
`error`. Pino is an optional application dependency and is not bundled with
`@motrix/nat`. Call `setNatLogger()` without an argument to restore no-op
logging.

### Rate limiting and concurrency helpers

- `TokenBucket` provides synchronous token acquisition and wait-time
  calculation.
- `TransitionMutex` serializes asynchronous transitions and exposes the
  current holder for diagnostics.
- `GenerationGuard` invalidates stale asynchronous work after lifecycle
  changes.

## Codecs and transport interfaces

All codecs are available as named exports and through the `codecs` namespace:

```ts
import { codecs } from '@motrix/nat'

const request = codecs.buildMSearch(codecs.SSDP_IGD_V2_ST, 2)
const response = codecs.parseMSearchResponse(datagram)
```

The public codec surface includes:

| Area | Main exports |
| --- | --- |
| SSDP | `buildMSearch`, `parseMSearchResponse`, `validateLocationUrl` |
| Device description | `parseDeviceDescription` |
| SOAP | `buildSoapEnvelope`, `parseSoapResponse`, `xmlEscape` |
| NAT-PMP | `buildExternalIpRequest`, `buildMappingRequest`, `parseNatPmpResponse` |
| PCP | `buildPcpMapRequest`, `parsePcpMapResponse`, `peekPcpNonce` |
| STUN | `buildBindingRequest`, `parseBindingResponse` |
| XML | `tokenizeXml`, `parseXml`, `findChild`, `findDescendants` |
| IP utilities | IPv4 parsing, classification, and buffer conversion helpers |

Custom runtimes and tests can implement `HttpClient`, `UdpSocket`, and
`UdpSocketFactory`. Node.js adapters are provided as `NodeHttpClient`,
`nodeHttpClient`, `NodeUdpSocket`, and `nodeUdpSocketFactory`.

## Package entry points

### `@motrix/nat`

The Node.js entry point exports managers, protocol clients, codecs, transports,
domain types, errors, logging, and concurrency utilities. It imports Node.js
built-ins and should stay in a Node.js process, Electron main process, server,
worker, or equivalent trusted runtime.

### `@motrix/nat/types`

The transport-agnostic entry point exports the runtime enums and TypeScript
types used to communicate NAT state:

```ts
import { NatState, type NatStatus } from '@motrix/nat/types'
```

This subpath does not import Node.js built-ins and is safe for browser and
Electron renderer bundles.

## Security model

The package treats router and network responses as untrusted input.

- **UPnP SSRF protection:** control endpoints must use literal private or
  link-local IPv4 addresses. Loopback, public IPs, DNS names, user info,
  redirects, fragments, and query strings are rejected.
- **Bounded HTTP:** responses are capped at 128 KiB, requests time out, and
  redirects are never followed.
- **Bounded XML:** the tokenizer rejects DTD, `ENTITY`, CDATA, comments,
  control characters, excessive nesting, oversized text, and oversized input.
- **Strict origin checks:** NAT-PMP and PCP responses must come from the
  configured gateway. PCP nonces and STUN transaction IDs are verified.
- **Strict binary parsing:** packet lengths, versions, opcodes, result codes,
  address families, attribute counts, ports, and lifetimes are validated.
- **Explicit external services:** STUN servers and port-check endpoints are
  supplied by the application. `PortChecker` only accepts HTTPS endpoints.

Security checks are covered by unit tests, property-based tests, a hostile
Docker fixture, and time-bounded codec fuzzing.

## Current scope and limitations

- Router discovery and transports are currently IPv4-oriented.
- The default `NetworkMonitor` gateway is a heuristic; inject routing-table
  integration when an exact default gateway is required.
- `StunClient.detectNatType()` currently reports the mapped endpoint, not a
  full RFC 3489-style NAT behavior classification.
- `NatManager.runDiagnostic()` is intentionally minimal in `0.1.0`.
- UPnP discovery is single-flight per `UpnpClient` instance.
- NAT-PMP is inherently unauthenticated and produces a manager warning when
  selected.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm fuzz
pnpm test:integration # requires Docker
```

The fuzz runner's `--duration` value is one total wall-clock budget shared by
all selected codecs.

## License

MIT

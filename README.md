# @motrix/nat

Dependency-free NAT traversal primitives for Node.js, extracted from Motrix.
The package implements UPnP IGD, NAT-PMP, PCP, and STUN, together with a
high-level manager for discovery, port mapping, renewal, and network-change
recovery.

## Security by default

- **SSRF-resistant UPnP discovery:** control endpoints must use literal
  private or link-local IPv4 addresses. Loopback, DNS names, user info,
  redirects, fragments, and query strings are rejected.
- **Bounded XML processing:** the built-in tokenizer rejects DTD, ENTITY,
  CDATA, comments, control characters, excessive nesting, and oversized
  inputs. This blocks XXE and entity-expansion attacks without a general XML
  dependency.
- **Strict binary and text codecs:** NAT-PMP, PCP, STUN, SSDP, SOAP, and device
  descriptions validate lengths, origins, transaction IDs, nonces, and
  protocol invariants before returning data.
- **Fuzz and property coverage:** codec fuzzing and fast-check properties run
  alongside unit tests; Docker integration tests exercise normal, hostile,
  malformed, and protocol-specific router fixtures.
- **Zero runtime dependencies:** the published package uses only Node.js
  built-ins.

## Install

```bash
pnpm add @motrix/nat
```

Node.js 22 or later is required.

## Example

```ts
import {
  nodeHttpClient,
  nodeUdpSocketFactory,
  UpnpClient,
} from '@motrix/nat'

const client = new UpnpClient({
  udpFactory: nodeUdpSocketFactory,
  http: nodeHttpClient,
})

const gateway = await client.discover({ timeoutMs: 5_000 })
if (!gateway.ok) {
  console.error(gateway.error, gateway.detail)
}
```

All public managers, clients, codecs, transports, domain types, and
`NatErrorCode` are exported from the package root.

Applications that only need transport-agnostic domain enums and types can
import them from `@motrix/nat/types`. This subpath has no Node.js built-in
imports and is safe to include in browser or renderer bundles.

## Logger injection

Logging is a no-op unless a pino-compatible logger is injected:

```ts
import pino from 'pino'
import { setNatLogger } from '@motrix/nat'

setNatLogger(pino())
```

The package only requires `child`, `debug`, `info`, `warn`, and `error`.

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

`--duration` in the fuzz runner is a total wall-clock budget shared among all
selected codecs.

## License

MIT

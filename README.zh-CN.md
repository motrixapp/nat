# @motrix/nat

从 Motrix 拆出的 Node.js NAT traversal 基础库，保持零 runtime dependency。
它实现 UPnP IGD、NAT-PMP、PCP 与 STUN，并提供 discovery、port mapping、
renewal 和 network-change recovery 的高层 manager。

## 默认安全

- **抵御 SSRF 的 UPnP discovery：**control endpoint 必须是 private 或
  link-local 的 IPv4 literal。拒绝 loopback、DNS name、user info、redirect、
  fragment 和 query string。
- **有界 XML 处理：**内置 tokenizer 拒绝 DTD、ENTITY、CDATA、comment、
  control character、过深嵌套和超大输入，无需通用 XML dependency 即可阻断
  XXE 与 entity-expansion attack。
- **严格 codec：**NAT-PMP、PCP、STUN、SSDP、SOAP 和 device description
  会先验证 length、origin、transaction ID、nonce 与协议 invariant。
- **Fuzz 与 property coverage：**codec fuzzing、fast-check property test 和
  unit test 一同运行；Docker integration test 覆盖正常、恶意、损坏及各协议
  router fixture。
- **零 runtime dependency：**发布包只使用 Node.js built-in module。

## 安装

```bash
pnpm add @motrix/nat
```

要求 Node.js 22 或更高版本。

## 示例

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

所有 public manager、client、codec、transport、domain type 和
`NatErrorCode` 都从 package root 导出。

## Logger 注入

默认 logger 为 no-op。应用可注入 pino-compatible logger：

```ts
import pino from 'pino'
import { setNatLogger } from '@motrix/nat'

setNatLogger(pino())
```

包只使用 `child`、`debug`、`info`、`warn` 和 `error`。

## 开发

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm fuzz
pnpm test:integration # 需要 Docker
```

fuzz runner 的 `--duration` 是所有选中 codec 共享的总 wall-clock budget。

## License

MIT

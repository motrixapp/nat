# @motrix/nat

[English](./README.md) | 简体中文

`@motrix/nat` 是一个零运行时依赖、注重安全边界的 Node.js NAT 发现与端口
映射工具包。它支持 UPnP IGD v1/v2、NAT-PMP、PCP 和 STUN，既提供统一的
生命周期管理器，也开放协议客户端、严格的编解码器和底层传输接口。

下列场景适合使用本包：

- 发现局域网网关及其公网 IPv4 地址；
- 创建、续租和删除 TCP 或 UDP 端口映射；
- 优先使用 PCP，并按 NAT-PMP、UPnP 的顺序自动回退；
- 通过 STUN 查询外部网络观察到的公网端点；
- 在网络发生变化时重新发现网关和恢复映射；
- 以有界、校验失败即拒绝的方式解析不可信路由器响应。

## 为什么选择 `@motrix/nat`

- **一套包覆盖三层抽象。** 可以直接使用 `NatManager`，也可以单独调用协议
  客户端，或只使用编解码器与传输接口。
- **默认收紧安全边界。** UPnP 控制端点必须是私有或链路本地 IPv4 字面地址；
  DNS 主机名、环回地址、重定向、畸形数据包和危险 XML 结构都会被拒绝。
- **适合常驻应用。** 生命周期管理器负责协议发现与回退、映射续租、退避重试、网络
  变化恢复，以及退出时的尽力清理。
- **便于集成和测试。** HTTP、UDP、设置、生命周期钩子、时钟和网络快照均通过
  小型接口注入。
- **零运行时依赖。** 发布包仅使用 Node.js 内置模块和 Node.js 提供的全局
  `fetch`。

## 标准与协议模型

NAT 穿越并不是一个单独的协议。端口映射协议用于请求网关创建入站转发
状态；STUN 则用于获知经过 NAT 转换后，远端所看到的传输地址。

本文采用 [RFC 2663](https://www.rfc-editor.org/rfc/rfc2663.html) 中的 NAT
基础术语。其中，私有 IPv4 地址是指
[RFC 1918](https://www.rfc-editor.org/rfc/rfc1918.html) 预留的三个地址块：
`10.0.0.0/8`、`172.16.0.0/12` 和 `192.168.0.0/16`。

本文使用的关键术语如下：

- **内部地址与端口：**本机在私有网络中监听的传输端点。
- **外部地址与映射端口：**NAT 暴露给外部网络的传输端点。
- **端口映射：**从外部协议和端口到内部协议和端口的显式转发规则。
- **映射有效期或 TTL：**租约持续时间，单位为秒。客户端应在到期前续租；在
  NAT-PMP 和 PCP 中，有效期为零表示删除映射。
- **服务器反射地址（server-reflexive address）：**数据经过中间 NAT 转换后，
  STUN 服务器实际观察到的客户端 IP 地址与端口。

### 已实现的标准

| 协议 | 标准 | 标准定义的用途 | 本包当前实现 |
| --- | --- | --- | --- |
| UPnP IGD | [OCF UPnP IGD 2.0 设备控制协议](https://openconnectivity.org/developer/specifications/upnp-resources/upnp/internet-gateway-device-igd-v-2-0/) | 通过 SSDP、HTTP 设备描述文档和 SOAP 发现并控制互联网网关设备 | 发现 IGD v1/v2；支持 `AddPortMapping`、`DeletePortMapping` 和 `GetExternalIPAddress`；在 `239.255.255.250:1900` 上进行 SSDP 组播 |
| NAT-PMP | [RFC 6886](https://www.rfc-editor.org/rfc/rfc6886.html) | 向默认网关查询外部 IPv4 地址并申请 TCP/UDP 映射 | 通过 UDP `5351` 发送版本 0 请求；支持查询外部地址以及创建、续租、删除映射；由于协议没有事务 ID，请求按顺序执行 |
| PCP | [RFC 6887](https://www.rfc-editor.org/rfc/rfc6887.html) | 控制 NAT 与防火墙中的映射，适用于家庭网关、运营商级 NAT（CGN）和 IPv6 过渡环境 | 通过 UDP `5351` 发送版本 2 MAP 请求；支持 TCP/UDP 映射；通过 `nonce` 关联创建、续租和删除操作 |
| STUN | [RFC 8489](https://www.rfc-editor.org/rfc/rfc8489.html) | 获取服务器反射传输地址，并作为更完整 NAT 穿越方案的基础组件 | 基于 UDP 的 Binding 请求与响应；使用显式 `host:port` 服务器地址；解析 `MAPPED-ADDRESS` 和 `XOR-MAPPED-ADDRESS`；RFC 默认端口为 `3478`，但本包要求调用方显式填写 |

### NAT 行为术语

[RFC 4787](https://www.rfc-editor.org/rfc/rfc4787.html) 分别从映射行为和过滤行为
描述 UDP NAT。该规范不再把较早的完全锥形、受限锥形、端口受限锥形和对称型
标签当作完整的 NAT 分类，因为这些标签不足以准确描述现实中的全部行为。

| 行为 | 映射行为定义 | 过滤行为定义 |
| --- | --- | --- |
| 端点无关 | 对同一个内部端点复用相同的外部映射，不受远端端点影响 | 映射建立后，允许来自任意外部端点的数据包 |
| 地址相关 | 仅在远端 IP 地址相同时复用映射，远端端口可以不同 | 仅允许内部端点曾向其发送数据的远端 IP 地址回包 |
| 地址和端口相关 | 仅在远端 IP 地址与端口都相同时复用映射 | 仅允许内部端点曾向其发送数据的同一远端 IP 地址和端口回包 |

映射行为和过滤行为是两个独立维度。一次 STUN Binding 请求只能得到一个服务器
反射端点，不能据此判断上述任一维度。

上述协议表同时说明了标准本身的用途和本包目前实现的子集，并不表示已经覆盖规范中的
所有可选操作、传输方式、认证方式、扩展或地址族。尤其需要注意：STUN 本身不是
完整的 NAT 穿越方案；本版本不实现 ICE 或 TURN。

## 运行要求与安装

- Node.js 22 或更高版本
- ESM

```bash
pnpm add @motrix/nat
```

也可以使用 npm 或 Yarn：

```bash
npm install @motrix/nat
yarn add @motrix/nat
```

## 快速开始：创建 UPnP 映射

如果只需要 UPnP，这是最直接的调用方式。请把示例中的 `internalIp` 替换为
实际接收入站连接的网卡私有 IPv4 地址。

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

## 如何选择 API 层级

| 目标 | 推荐 API |
| --- | --- |
| 统一处理发现、协议回退、续租、重试和退出清理 | `NatManager` |
| 通过 UPnP IGD 发现网关或管理映射 | `UpnpClient` |
| 创建 PCP 或 NAT-PMP 映射 | `PmpPcpClient` |
| 查询 STUN 服务器观察到的公网端点 | `StunClient` |
| 通过应用自有的 HTTPS 服务检查映射端口 | `PortChecker` |
| 监听稳定的本地网络接口变化 | `NetworkMonitor` |
| 构造或检查协议数据包 | `codecs` 命名空间或具名编解码器导出 |
| 与浏览器或 Electron 渲染进程共享 NAT 状态 | `@motrix/nat/types` |

## 返回值与错误模型

协议和传输操作统一返回可辨识联合类型 `ParseResult<T>`：

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

因此，预期内的网络错误、校验失败和协议错误无需通过异常控制流程处理。构造参数
误用或命令式更新中的无效值仍可能抛出异常；例如，传入无效 IPv4 地址时，
`PmpPcpClient.setGatewayIp()` 会抛出 `RangeError`。

`NatErrorCode` 定义了稳定的包级错误码：

| 错误码 | 含义 |
| --- | --- |
| `NAT_DISCOVERY_FAILED` | 未发现受支持的网关 |
| `NAT_MAPPING_FAILED` | 无法创建端口映射 |
| `NAT_MAPPING_CONFLICT` | 请求的映射与现有条目冲突 |
| `NAT_PROTOCOL_REJECTED` | 输入或路由器响应不符合协议约束 |
| `NAT_PARSE_ERROR` | 无法安全解析响应 |
| `NAT_SECURITY_VIOLATION` | 安全边界或响应来源校验失败 |
| `NAT_TIMEOUT` | 操作超时或被取消 |
| `NAT_NETWORK_CHANGED` | 网络变化或退出流程使操作失效 |
| `NAT_GATEWAY_UNREACHABLE` | 与网关通信失败 |
| `STUN_DETECTION_FAILED` | 所有已配置 STUN 服务器均未返回可用结果 |

当生命周期管理器选用 NAT-PMP 时，还会发出 `NAT_SECURITY_WARNING`。这是因为
NAT-PMP 响应没有认证机制；该事件是安全提醒，不表示映射失败。

## 高层生命周期管理

`NatManager` 负责协调协议客户端和应用生命周期。主要公共方法如下：

| 方法 | 行为 |
| --- | --- |
| `start()` / `enable()` | 订阅生命周期钩子、启动网络监控并发现网关 |
| `mapConfiguredPorts()` | 映射已配置的 TCP 监听端口和 UDP DHT 端口 |
| `remapAll()` / `forceRemap()` | 续租或重新创建当前映射 |
| `getStatus()` | 返回状态、网关、映射、重试次数和最近错误的快照 |
| `runDiagnostic()` | 执行当前版本提供的最小 STUN 诊断 |
| `exportBundle()` | 导出已遮蔽本地 IP 的精简诊断信息 |
| `stop()` / `disable()` | 取消任务、删除映射、停止监控并关闭 UDP 资源 |

生命周期管理器通过适配器与应用集成。下面是一套完整的基础配置：

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
    // 在实际应用中，应替换为对应用生命周期事件的订阅。
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

// 应在应用退出时调用。
await manager.stop()
```

在事件驱动的应用中，可以通过事件总线实现 `NatManagerHooks.onReady()` 和
`onConfigChanged()`。应用进入就绪状态后，生命周期管理器会创建映射；相关配置
变化后，生命周期管理器会重新映射端口。

### 管理器事件

`onEvent` 回调接收 `NatEvent` 联合类型：

- `state-changed`
- `error`
- `gateway-changed`
- `mapping-updated`
- `diagnostic-completed`

`NatState` 的状态依次可能为 `idle`、`discovering`、`ready`、`mapping`、
`active`、`failed`、`stopping` 和 `stopped`。

## 协议客户端

### UPnP IGD

`UpnpClient` 提供以下方法：

- `discover(options?)`
- `mapPort(gateway, params, signal?)`
- `unmapPort(gateway, params, signal?)`
- `getExternalIp(gateway, signal?)`

发现过程会为每个搜索目标发送一条 M-SEARCH 请求。默认覆盖 IGD v1 和
v2，超时时间为 3 秒，最多处理 10 条响应。若映射操作属于更大的可取消生命周期，
可以传入 `AbortSignal`。

### PCP 与 NAT-PMP

建议为每个本地网关创建一个 `PmpPcpClient` 实例，并在退出时关闭：

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
    // 删除 PCP 映射时必须带回创建映射时使用的 nonce。
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

同一个客户端还提供：

- `natPmpGetExternalIp({ timeoutMs, signal }?)`
- `natPmpMap({ protocol, internalPort, externalPort, ttl, timeoutMs, signal })`
- `pcpMap({ protocol, internalPort, externalPort, ttl, timeoutMs, signal, nonce })`
- `setGatewayIp(ip)`
- `close()`

NAT-PMP 没有用于关联请求与响应的事务 ID，因此请求会串行执行。PCP 使用
`nonce` 关联请求；每个客户端最多同时处理四个 PCP 请求。

### STUN 公网端点发现

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

虽然当前方法名为 `detectNatType()`，本版本实际返回的是第一台有效 STUN 服务器
观察到的公网 IP 与端口。无论是区分旧式的锥形/对称型标签，还是判断 RFC 4787
定义的映射行为和过滤行为，都需要进行多服务器行为测试，目前尚未实现。

## 辅助 API

### 网络变化监控

`NetworkMonitor` 会周期性获取网络快照。只有新快照连续稳定达到指定轮数后，才会
触发变化事件：

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
// 稍后执行：
unsubscribe()
monitor.stop()
```

若需要依据精确路由做生产决策，请注入能读取操作系统路由表的 `snapshotFn`。
默认实现只会选择第一个非回环 IPv4 网卡，并把同一 `/24`
网段的 `.1` 地址估算为网关；它不会读取系统路由表。

### 端口可达性检查

`PortChecker` 会向应用配置的 HTTPS 端点发起请求，并附加 `ip` 与 `port` 查询
参数。包内不预置端点；只有调用方显式执行检查时才会访问外部服务。

```ts
const result = await new PortChecker().checkPortReachable({
  endpoints: ['https://status.example.net/check-port'],
  externalIp: '203.0.113.10',
  port: 51413,
  timeoutMs: 3_000,
})
```

服务响应应包含 `open`、`closed`、`reachable` 或 `unreachable` 等含义明确的
单词。如果使用结构化 API，可以通过 `PortCheckerOptions` 注入自定义 `fetcher`。

### 日志器注入

默认日志器为空操作实现。应用可以在启动时注入一个兼容 Pino 的日志器：

```ts
import pino from 'pino'
import { setNatLogger } from '@motrix/nat'

setNatLogger(pino())
```

`NatLogger` 接口只要求实现 `child`、`debug`、`info`、`warn` 和 `error`。
Pino 是应用侧的可选依赖，不会随 `@motrix/nat` 安装。不带参数调用
`setNatLogger()` 可以恢复默认的空操作日志器。

### 限流与并发工具

- `TokenBucket` 提供同步获取令牌和计算等待时间的能力。
- `TransitionMutex` 用于串行执行异步状态转换，并可报告当前持有者，便于诊断。
- `GenerationGuard` 用于在生命周期变化后使旧异步任务失效。

## 编解码器与传输接口

所有编解码器既可以具名导入，也可以通过 `codecs` 命名空间使用：

```ts
import { codecs } from '@motrix/nat'

const request = codecs.buildMSearch(codecs.SSDP_IGD_V2_ST, 2)
const response = codecs.parseMSearchResponse(datagram)
```

主要公共编解码器如下：

| 领域 | 主要导出 |
| --- | --- |
| SSDP | `buildMSearch`、`parseMSearchResponse`、`validateLocationUrl` |
| 设备描述 | `parseDeviceDescription` |
| SOAP | `buildSoapEnvelope`、`parseSoapResponse`、`xmlEscape` |
| NAT-PMP | `buildExternalIpRequest`、`buildMappingRequest`、`parseNatPmpResponse` |
| PCP | `buildPcpMapRequest`、`parsePcpMapResponse`、`peekPcpNonce` |
| STUN | `buildBindingRequest`、`parseBindingResponse` |
| XML | `tokenizeXml`、`parseXml`、`findChild`、`findDescendants` |
| IP 工具 | IPv4 解析、地址分类和 Buffer 转换函数 |

自定义运行环境和测试代码可以实现 `HttpClient`、`UdpSocket` 与
`UdpSocketFactory`。包内提供 Node.js 适配器：`NodeHttpClient`、
`nodeHttpClient`、`NodeUdpSocket` 和 `nodeUdpSocketFactory`。

## 包入口

### `@motrix/nat`

Node.js 主入口导出生命周期管理器、协议客户端、编解码器、传输接口、领域类型、
错误类型、日志器和并发工具。该入口会加载 Node.js 内置模块，应仅用于 Node.js
进程、Electron 主进程、服务器、工作线程或同类可信运行环境。

### `@motrix/nat/types`

这个与传输无关的入口导出用于传递 NAT 状态的运行时枚举和 TypeScript 类型：

```ts
import { NatState, type NatStatus } from '@motrix/nat/types'
```

这个子路径不导入 Node.js 内置模块，可以安全用于浏览器和 Electron 渲染进程的
打包产物。

## 安全模型

本包始终把路由器和网络响应视为不可信输入。

- **UPnP SSRF 防护：**控制端点必须使用私有或链路本地 IPv4 字面地址；环回地址、
  公网 IP、DNS 主机名、用户信息、重定向、URL 片段和查询字符串都会被拒绝。
- **有界 HTTP：**响应上限为 128 KiB；请求带有超时，且绝不跟随重定向。
- **有界 XML：**分词器拒绝 DTD、`ENTITY`、CDATA、注释、控制字符、过深嵌套、
  过长文本和超大输入。
- **严格来源校验：**NAT-PMP 与 PCP 响应必须来自已配置的网关；PCP `nonce` 和
  STUN 事务 ID 必须匹配。
- **严格二进制解析：**数据包长度、版本、操作码、结果码、地址族、属性数量、
  端口和有效期都会经过校验。
- **外部服务由应用明确配置：**STUN 服务器和端口检查端点均由调用方提供；
  `PortChecker` 只接受 HTTPS 端点。

上述安全约束由单元测试、基于性质的测试、Docker 恶意输入测试夹具和有时间上限的
编解码器模糊测试共同覆盖。

## 当前范围与限制

- 网关发现与传输当前以 IPv4 为主。
- `NetworkMonitor` 默认提供的是网关估算值；需要精确的默认网关时，应注入读取
  系统路由表的实现。
- `StunClient.detectNatType()` 当前只返回映射后的公网端点，不提供完整的 RFC
  3489 风格 NAT 行为分类。
- `0.1.0` 中的 `NatManager.runDiagnostic()` 仍是最小实现。
- 每个 `UpnpClient` 实例同一时间只允许执行一次发现操作。
- NAT-PMP 本身没有认证机制；生命周期管理器选用它时会发出安全提醒。

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

模糊测试运行器的 `--duration` 是所有选中编解码器共享的总实际运行时间，而不是
每个编解码器单独占用的时长。

## License

MIT

# aichat-plugins

HuLa-Server 与 AI 助手（openclaw 等）的通讯桥接服务。

## 架构

```
用户 ←WS→ HuLa-Server ←WS→ aichat-node ←WS RPC→ openclaw gateway
                                                      ↑
                                              aichat-claw (Plugin)
                                              ├── HuLa Channel
                                              └── Agent Tools
```

### 双层设计

- **aichat-node** (`packages/node`)：统一桥接层，连接 HuLa-Server WS 与 openclaw gateway WS RPC
- **aichat-claw** (`packages/claw`)：openclaw 原生 Plugin，注册 HuLa Channel 和 Agent Tools

## Monorepo 结构

```
aichat-plugins/
├── packages/
│   ├── node/                  # @aichat/node — WS 桥接层
│   │   └── src/
│   │       ├── cli.ts         # CLI 入口
│   │       ├── config.ts      # 配置管理
│   │       ├── server/
│   │       │   └── hula-ws.ts # HuLa-Server WS 客户端
│   │       ├── stream/
│   │       │   └── protocol.ts# HuLa 消息协议
│   │       ├── claw/
│   │       │   ├── interface.ts # ClawAdapter 接口
│   │       │   └── openclaw.ts  # openclaw WS RPC 适配器
│   │       ├── handler/
│   │       │   └── message.ts # 消息处理（防抖+流式）
│   │       ├── auth/
│   │       │   └── machine.ts # 机器码管理
│   │       ├── commands/
│   │       │   ├── activate.ts
│   │       │   └── start.ts
│   │       └── utils/
│   │           └── debounce.ts
│   └── claw/                  # @aichat/claw — openclaw Plugin
│       ├── openclaw.plugin.json
│       └── src/
│           ├── index.ts       # Plugin 入口
│           ├── types.ts       # SDK 类型定义
│           └── channel/
│               ├── index.ts   # HuLa Channel 定义
│               ├── config.ts  # Channel 配置
│               └── outbound.ts# 出站适配器
├── pnpm-workspace.yaml
├── .npmrc
└── package.json               # workspace root
```

## 开发

```bash
# 1. 安装依赖（在 aichat-plugins-dev 容器内）
pnpm install

# 2. 构建
pnpm build

# 3. 开发模式（热重载 aichat-node）
pnpm dev

# 4. 激活
pnpm -r --filter @aichat/node exec aichat activate --token <token>

# 5. 运行
pnpm -r --filter @aichat/node exec aichat start
```

## CLI 消息确认（#307）

`aichat send-message --content "hello" --json` 为本次逻辑发送生成一个 requestId；也可显式使用 `--request-id <id>`。`--json` 成功时返回 `requestId` 和合法 `result.msgId`，失败时输出稳定 `code`，`DELIVERY_UNKNOWN` 保留 requestId。默认文本成功输出仍是原 `Message sent: …` 格式。再次确认只能使用**同一 ID、同一内容、同一绑定身份/房间**；修改正文必须发起新逻辑请求，不能把 unknown 当作未落库，也不要在超过 7 天保护窗口后自动重放旧请求（显式 ID 的创建时间由调用者保管）。

node 先请求 server 的 `GET /api/im/chat/msg/receipt-capability`，仅精确确认 `requestId-v1;retention-min=7d` 才在 POST 带 requestId；带可解析近期时间戳的 ID（包括用户显式传入同格式 ID）仅在 7 天窗内最多三次以固定负载自动确认不确定结果；格式并不能证明 ID 来源，因此自定义 ID 的时间戳准确性由调用者负责。无时间戳的自定义 ID 与过期 ID 每次显式调用只发送一次、不自动循环；人工在保护窗外再次发送旧 ID 可能生成新消息，应先人工对账。probe 暂不可用时不发消息（`UPSTREAM_FAILED`、可重试、无写入）。若网关后有多个 IM 实例，必须先证明所有写入目标均已升级且开启同一收据表，再启用此能力；混合版本滚动窗口中 GET 命中新版本不能保证下一次 POST 命中同版本。旧 server 返回 404 或未广告该能力时只有一次旧协议发送：断响应是 unknown，**不能自动重发**。node 进程本地 Promise/结果缓存只减少同进程重复调用；server 的 tenant+actor 收据负责保护窗口内消息持久化去重；通知队列仍可能重复投递，客户端依 msgId 对账、离线以历史查询补偿。WS 写完成不是客户端 ACK，本功能**不承诺网络端到端 exactly-once**。

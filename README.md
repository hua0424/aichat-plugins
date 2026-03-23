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

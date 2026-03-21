# aichat-plugins

HuLa-Server 与 AI 助手（openclaw 等）的通讯桥接服务。

## 架构

```
用户 ←WS→ HuLa-Server ←WS→ aichat-plugins ←SSE→ openclaw
```

plugins 作为 aiclaw 用户的一个 WS "设备"接入 HuLa-Server，复用现有 IM 消息链路。

## 开发

```bash
# 1. 复制配置
cp .env.example .env
# 编辑 .env，填入 AICLAW_TOKEN 等

# 2. 安装依赖（在 aichat-plugins-dev 容器内）
npm install

# 3. 开发模式（热重载）
npm run dev
```

## 目录结构

```
src/
├── index.ts          # 入口
├── config.ts         # 环境变量
├── ws/
│   ├── client.ts     # WS 客户端（自动重连+心跳）
│   └── protocol.ts   # 消息类型定义
├── ai/
│   ├── engine.ts     # AI 引擎接口
│   └── openclaw.ts   # openclaw SSE 集成
├── handler/
│   └── message.ts    # 消息处理（防抖+流式）
├── auth/
│   └── machine.ts    # 机器码管理
└── utils/
    └── debounce.ts   # 防抖合并器
```

# Graph Report - .  (2026-05-11)

## Corpus Check
- Corpus is ~45,824 words - fits in a single context window. You may not need a graph.

## Summary
- 307 nodes · 335 edges · 90 communities detected
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 54 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `REQ-002 aiclaw 后端任务` - 31 edges
2. `后端构建环境设计与登记` - 30 edges
3. `REQ-002 前端任务` - 27 edges
4. `前端构建环境设计与登记` - 26 edges
5. `CI流水线与发布流程` - 25 edges
6. `联调环境说明` - 24 edges
7. `OpenclawAdapter` - 21 edges
8. `Docker` - 11 edges
9. `HulaWSClient` - 9 edges
10. `HulaApiClient` - 9 edges

## Surprising Connections (you probably didn't know these)
- `前端构建环境设计与登记` --semantically_similar_to--> `后端构建环境设计与登记`  [INFERRED] [semantically similar]
  teamdocs/_legacy/02-环境与部署/前端构建环境设计与登记-20260310.md → teamdocs/_legacy/02-环境与部署/后端构建环境设计与登记-20260310.md
- `看板` --references--> `CI流水线与发布流程`  [INFERRED]
  teamdocs/_legacy/05-任务与进度/看板.md → teamdocs/_legacy/02-环境与部署/CI流水线与发布流程.md
- `环境搭建任务分派` --references--> `CI流水线与发布流程`  [INFERRED]
  teamdocs/_legacy/05-任务与进度/环境搭建任务分派.md → teamdocs/_legacy/02-环境与部署/CI流水线与发布流程.md
- `CI流水线与发布流程` --references--> `后端构建环境设计与登记`  [INFERRED]
  teamdocs/_legacy/02-环境与部署/CI流水线与发布流程.md → teamdocs/_legacy/02-环境与部署/后端构建环境设计与登记-20260310.md
- `CI流水线与发布流程` --references--> `前端构建环境设计与登记`  [INFERRED]
  teamdocs/_legacy/02-环境与部署/CI流水线与发布流程.md → teamdocs/_legacy/02-环境与部署/前端构建环境设计与登记-20260310.md

## Communities

### Community 0 - "AIclaw Backend APIs"
Cohesion: 0.07
Nodes (44): ADR-001 aiclaw架构决策, aiAssistantWindow/index.vue, POST /api/im/aiclaw/{uid}/auth-confirm, POST /api/im/aiclaw/create, POST /api/im/aiclaw/{uid}/deactivate, GET /api/im/aiclaw/list, PUT /api/im/aiclaw/{uid}/profile, POST /api/im/aiclaw/{uid}/reset-token (+36 more)

### Community 1 - "Deployment & Infrastructure"
Cohesion: 0.1
Nodes (30): aichat-plugins 通讯插件, aichat-plugins-dev-runtime 容器, aichat-dev-net Docker网络, 后端构建环境设计与登记, build.sh 构建脚本, Docker, docker-compose.dev.yml, .env.common 环境变量 (+22 more)

### Community 2 - "Git Workflow & CI/CD"
Cohesion: 0.1
Nodes (26): CI流水线与发布流程, Conventional Commits 提交规范, dev 分支, DevOps 石哥, Docker Compose, feature/* 分支, Git分支与提测规范, hotfix/* 分支 (+18 more)

### Community 3 - "Git Workflow & CI/CD"
Cohesion: 0.12
Nodes (4): loadDeviceIdentity(), OpenclawAdapter, publicKeyRawBase64Url(), signPayload()

### Community 4 - "Openclaw Adapter"
Cohesion: 0.15
Nodes (23): mingc/android-build-box, AppImage bundling, 前端 .env.example, 环境搭建任务分派, 前端构建环境设计与登记, GitHub Actions Android构建, GitHub Actions Windows构建, HuLa-Admin 管理端 (+15 more)

### Community 5 - "Openclaw Adapter"
Cohesion: 0.12
Nodes (22): POST /api/im/aiclaw/anyTenant/activate, GET /api/im/aiclaw/{uid}/activation-token, aichat activate CLI命令, aichat start 守护进程命令, ~/.aichat/config.jsonc 配置, ~/.aichat/credentials.jsonc 凭证, AiclawCryptoService 加密服务, POST /api/im/aiclaw/{uid}/refresh-activation (+14 more)

### Community 6 - "WebSocket & API Clients"
Cohesion: 0.22
Nodes (1): HulaWSClient

### Community 7 - "WebSocket & API Clients"
Cohesion: 0.36
Nodes (1): HulaApiClient

### Community 8 - "WebSocket & API Clients"
Cohesion: 0.25
Nodes (1): ClawRouter

### Community 9 - "Config & Routing"
Cohesion: 0.29
Nodes (0): 

### Community 10 - "Config & Routing"
Cohesion: 0.33
Nodes (1): MessageHandler

### Community 11 - "Config & Routing"
Cohesion: 0.4
Nodes (1): MessageDebouncer

### Community 12 - "Small Component"
Cohesion: 0.67
Nodes (0): 

### Community 13 - "Small Component"
Cohesion: 0.67
Nodes (0): 

### Community 14 - "Small Component"
Cohesion: 1.0
Nodes (0): 

### Community 15 - "Small Component"
Cohesion: 1.0
Nodes (0): 

### Community 16 - "Small Component"
Cohesion: 1.0
Nodes (0): 

### Community 17 - "Small Component"
Cohesion: 1.0
Nodes (0): 

### Community 18 - "Small Component"
Cohesion: 1.0
Nodes (0): 

### Community 19 - "Small Component"
Cohesion: 1.0
Nodes (0): 

### Community 20 - "Small Component"
Cohesion: 1.0
Nodes (0): 

### Community 21 - "Isolated Node"
Cohesion: 1.0
Nodes (0): 

### Community 22 - "Isolated Node"
Cohesion: 1.0
Nodes (0): 

### Community 23 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-002 后端任务

### Community 24 - "Isolated Node"
Cohesion: 1.0
Nodes (1): CLAUDE

### Community 25 - "Isolated Node"
Cohesion: 1.0
Nodes (1): README

### Community 26 - "Isolated Node"
Cohesion: 1.0
Nodes (1): README

### Community 27 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 看板

### Community 28 - "Isolated Node"
Cohesion: 1.0
Nodes (1): group_doc

### Community 29 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 目录盘点

### Community 30 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 服务端依赖清单与中间件拓扑

### Community 31 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 基础镜像与配置基线-最终版

### Community 32 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 后端CI构建手册-20260312

### Community 33 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-003-后端任务

### Community 34 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-002-前端联调测试案例

### Community 35 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-002-需求调整-激活流程简化

### Community 36 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 发布清单

### Community 37 - "Isolated Node"
Cohesion: 1.0
Nodes (1): README

### Community 38 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-003-非owner通讯后端设计

### Community 39 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-001-联调接口契约

### Community 40 - "Isolated Node"
Cohesion: 1.0
Nodes (1): IM服务前端接口规范

### Community 41 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-003-非owner通讯前端设计

### Community 42 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-002-aichat-claw插件架构设计

### Community 43 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-001-Web端改造-后端协作清单

### Community 44 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-002-aiclaw-AI助理功能需求设计

### Community 45 - "Isolated Node"
Cohesion: 1.0
Nodes (1): REQ-003-非owner与aiclaw通讯

### Community 46 - "Isolated Node"
Cohesion: 1.0
Nodes (1): openclaw-API调查-20260314

### Community 47 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 问题清单

### Community 48 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 风险清单

### Community 49 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 项目总览

### Community 50 - "Isolated Node"
Cohesion: 1.0
Nodes (1): ADR-001-aiclaw架构决策

### Community 51 - "Isolated Node"
Cohesion: 1.0
Nodes (1): ADR-20260310-openclaw纳入核心交付链与适配插件边界

### Community 52 - "Isolated Node"
Cohesion: 1.0
Nodes (1): ADR-20260313-openclaw替换为aichat-plugins

### Community 53 - "Isolated Node"
Cohesion: 1.0
Nodes (1): README

### Community 54 - "Isolated Node"
Cohesion: 1.0
Nodes (1): ADR-20260309-开发测试发布流程与分支策略

### Community 55 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 环境搭建任务分派

### Community 56 - "Isolated Node"
Cohesion: 1.0
Nodes (1): README

### Community 57 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 设计-联调接口契约

### Community 58 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 需求

### Community 59 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 任务-联调测试案例

### Community 60 - "Isolated Node"
Cohesion: 1.0
Nodes (1): README

### Community 61 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 任务-后端

### Community 62 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 需求调整-激活流程简化

### Community 63 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 设计-插件架构

### Community 64 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 外部接口调查-openclaw-API

### Community 65 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 需求

### Community 66 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 任务-前端

### Community 67 - "Isolated Node"
Cohesion: 1.0
Nodes (1): ADR-001-aiclaw架构决策

### Community 68 - "Isolated Node"
Cohesion: 1.0
Nodes (1): ADR-20260313-openclaw替换为aichat-plugins

### Community 69 - "Isolated Node"
Cohesion: 1.0
Nodes (1): ADR-20260310-openclaw纳入核心交付链

### Community 70 - "Isolated Node"
Cohesion: 1.0
Nodes (1): README

### Community 71 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 任务-后端

### Community 72 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 设计-后端

### Community 73 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 设计-前端

### Community 74 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 需求

### Community 75 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 任务-前端

### Community 76 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 项目总览

### Community 77 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 联调环境说明

### Community 78 - "Isolated Node"
Cohesion: 1.0
Nodes (1): IM服务前端接口规范

### Community 79 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 服务端依赖清单与中间件拓扑

### Community 80 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 基础镜像与配置基线

### Community 81 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 前端构建环境设计与登记

### Community 82 - "Isolated Node"
Cohesion: 1.0
Nodes (1): CI流水线与发布流程

### Community 83 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 后端构建环境设计与登记

### Community 84 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 后端CI构建手册

### Community 85 - "Isolated Node"
Cohesion: 1.0
Nodes (1): ADR-20260309-开发测试发布流程与分支策略

### Community 86 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 发布清单

### Community 87 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 问题清单

### Community 88 - "Isolated Node"
Cohesion: 1.0
Nodes (1): 风险清单

### Community 89 - "Isolated Node"
Cohesion: 1.0
Nodes (1): Git分支与提测规范

## Knowledge Gaps
- **132 isolated node(s):** `REQ-002 后端任务`, `Docker Compose`, `测试标签 test-<shortsha>`, `生产标签 vX.Y.Z`, `回滚机制` (+127 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Small Component`** (2 nodes): `activate.ts`, `activate()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Small Component`** (2 nodes): `start.ts`, `start()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Small Component`** (2 nodes): `protocol.ts`, `buildRequest()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Small Component`** (2 nodes): `machine.ts`, `getMachineCode()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Small Component`** (2 nodes): `outbound.ts`, `createHulaOutboundAdapter()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Small Component`** (2 nodes): `send-message.ts`, `createSendMessageTool()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Small Component`** (2 nodes): `find-friend.ts`, `createFindFriendTool()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `interface.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-002 后端任务`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `CLAUDE`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `README`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `README`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `看板`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `group_doc`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `目录盘点`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `服务端依赖清单与中间件拓扑`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `基础镜像与配置基线-最终版`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `后端CI构建手册-20260312`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-003-后端任务`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-002-前端联调测试案例`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-002-需求调整-激活流程简化`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `发布清单`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `README`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-003-非owner通讯后端设计`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-001-联调接口契约`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `IM服务前端接口规范`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-003-非owner通讯前端设计`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-002-aichat-claw插件架构设计`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-001-Web端改造-后端协作清单`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-002-aiclaw-AI助理功能需求设计`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `REQ-003-非owner与aiclaw通讯`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `openclaw-API调查-20260314`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `问题清单`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `风险清单`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `项目总览`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `ADR-001-aiclaw架构决策`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `ADR-20260310-openclaw纳入核心交付链与适配插件边界`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `ADR-20260313-openclaw替换为aichat-plugins`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `README`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `ADR-20260309-开发测试发布流程与分支策略`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `环境搭建任务分派`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `README`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `设计-联调接口契约`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `需求`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `任务-联调测试案例`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `README`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `任务-后端`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `需求调整-激活流程简化`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `设计-插件架构`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `外部接口调查-openclaw-API`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `需求`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `任务-前端`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `ADR-001-aiclaw架构决策`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `ADR-20260313-openclaw替换为aichat-plugins`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `ADR-20260310-openclaw纳入核心交付链`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `README`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `任务-后端`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `设计-后端`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `设计-前端`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `需求`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `任务-前端`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `项目总览`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `联调环境说明`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `IM服务前端接口规范`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `服务端依赖清单与中间件拓扑`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `基础镜像与配置基线`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `前端构建环境设计与登记`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `CI流水线与发布流程`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `后端构建环境设计与登记`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `后端CI构建手册`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `ADR-20260309-开发测试发布流程与分支策略`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `发布清单`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `问题清单`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `风险清单`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Isolated Node`** (1 nodes): `Git分支与提测规范`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `CI流水线与发布流程` connect `Git Workflow & CI/CD` to `AIclaw Backend APIs`, `Deployment & Infrastructure`, `Openclaw Adapter`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `后端构建环境设计与登记` connect `Deployment & Infrastructure` to `AIclaw Backend APIs`, `Git Workflow & CI/CD`, `Openclaw Adapter`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Why does `REQ-002 aiclaw 后端任务` connect `Openclaw Adapter` to `AIclaw Backend APIs`, `Deployment & Infrastructure`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `REQ-002 aiclaw 后端任务` (e.g. with `REQ-002 前端任务` and `REQ-003 前端任务`) actually correct?**
  _`REQ-002 aiclaw 后端任务` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `后端构建环境设计与登记` (e.g. with `环境搭建任务分派` and `前端构建环境设计与登记`) actually correct?**
  _`后端构建环境设计与登记` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `REQ-002 前端任务` (e.g. with `REQ-002 aiclaw 后端任务` and `REQ-003 前端任务`) actually correct?**
  _`REQ-002 前端任务` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `前端构建环境设计与登记` (e.g. with `环境搭建任务分派` and `后端构建环境设计与登记`) actually correct?**
  _`前端构建环境设计与登记` has 4 INFERRED edges - model-reasoned connections that need verification._
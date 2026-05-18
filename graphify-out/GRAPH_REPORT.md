# Graph Report - /home/hua/projects/peer_workspace/aichat/plugin  (2026-05-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 461 nodes · 752 edges · 22 communities (17 shown, 5 thin omitted)
- Extraction: 81% EXTRACTED · 19% INFERRED · 0% AMBIGUOUS · INFERRED: 145 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0dbc7ba2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_HuLa System Architecture|HuLa System Architecture]]
- [[_COMMUNITY_ADR-001 aiclaw Architecture|ADR-001 aiclaw Architecture]]
- [[_COMMUNITY_OpenClaw Agent Adapter|OpenClaw Agent Adapter]]
- [[_COMMUNITY_Claw Plugin Channel & Tools|Claw Plugin Channel & Tools]]
- [[_COMMUNITY_Message Processing Pipeline|Message Processing Pipeline]]
- [[_COMMUNITY_Activation & CLI Flow|Activation & CLI Flow]]
- [[_COMMUNITY_IM API & Friend Features|IM API & Friend Features]]
- [[_COMMUNITY_CLI & Configuration|CLI & Configuration]]
- [[_COMMUNITY_Frontend aiclaw UI|Frontend aiclaw UI]]
- [[_COMMUNITY_Plugin Source Files|Plugin Source Files]]
- [[_COMMUNITY_Backend Infrastructure|Backend Infrastructure]]
- [[_COMMUNITY_Project Structure & Tasks|Project Structure & Tasks]]
- [[_COMMUNITY_OpenClaw Integration|OpenClaw Integration]]
- [[_COMMUNITY_Server Middleware Stack|Server Middleware Stack]]
- [[_COMMUNITY_DevOps & Release|DevOps & Release]]
- [[_COMMUNITY_Claw Adapter Layer|Claw Adapter Layer]]
- [[_COMMUNITY_Branching Strategy|Branching Strategy]]
- [[_COMMUNITY_Risk Tracking|Risk Tracking]]
- [[_COMMUNITY_Issue Tracking|Issue Tracking]]
- [[_COMMUNITY_Release Checklist|Release Checklist]]
- [[_COMMUNITY_Message Debouncer|Message Debouncer]]
- [[_COMMUNITY_Risk Log|Risk Log]]

## God Nodes (most connected - your core abstractions)
1. `ADR-001 aiclaw架构决策` - 35 edges
2. `OpenclawAdapter` - 22 edges
3. `AIclaw 功能需求设计 v1.2` - 21 edges
4. `问题清单` - 21 edges
5. `REQ-003 非owner通讯后端设计` - 17 edges
6. `REQ-002 aiclaw AI助理功能需求设计` - 16 edges
7. `aichat-node部署改造方案` - 15 edges
8. `REQ-003 非owner与aiclaw通讯需求` - 14 edges
9. `ISS-003 写入路径同步last-msg-id方案` - 14 edges
10. `HulaApiClient` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Project CLAUDE.md` --conceptually_related_to--> `Claw Plugin Entry`  [INFERRED]
  CLAUDE.md → packages/claw/src/index.ts
- `Project CLAUDE.md` --conceptually_related_to--> `Config Loader`  [INFERRED]
  CLAUDE.md → packages/node/src/config.ts
- `aichat-node桥接层` --calls--> `WebSocket服务 luohuo-ws-server`  [INFERRED]
  README.md → teamdocs/_legacy/02-环境与部署/服务端依赖清单与中间件拓扑.md
- `目录盘点` --references--> `aichat-plugins README`  [EXTRACTED]
  teamdocs/_legacy/01-项目结构/目录盘点.md → README.md
- `全局任务看板` --semantically_similar_to--> `看板（legacy）`  [INFERRED] [semantically similar]
  teamdocs/看板.md → teamdocs/_legacy/05-任务与进度/看板.md

## Hyperedges (group relationships)
- **Message Processing Pipeline** — node_server_hulaws, node_handler_message, node_utils_debounce, node_claw_openclaw [INFERRED 0.85]
- **Claw Plugin Architecture** — claw_index, claw_channel_index, claw_tools_index, claw_hula_api, claw_types [INFERRED 0.80]
- **Activation Flow** — node_cli, node_commands_activate, node_auth_machine, node_config [INFERRED 0.80]
- **HuLa-Server微服务拓扑** — concept_gateway, concept_oauth_server, concept_ws_server, concept_im_server, concept_nacos, concept_mysql, concept_redis, concept_rocketmq [INFERRED 0.85]
- **REQ-002 AI助理全栈开发** — legacy_05_req002_frontend_tasks, legacy_05_req002_backend_tasks, legacy_05_req002_activation_simplification, legacy_05_req002_frontend_test_cases, readme_aichat_plugins [EXTRACTED 1.00]
- **容器化构建体系** — legacy_02_base_image_baseline, legacy_02_backend_ci_manual, legacy_02_frontend_build_env, legacy_02_backend_build_env, legacy_02_ci_pipeline [INFERRED 0.80]
- **ADR-001 aiclaw核心架构决策集** — adr001_d1_user_model, adr001_d2_token_scheme, adr001_d3_ws_protocol, adr001_d4_msg_routing, adr001_d5_streaming_msg, adr001_d6_msg_type, adr001_d7_machine_code, adr001_d8_auth_request, adr001_d9_friend_deletion, adr001_d10_offline_msg, adr001_d11_client_scope, adr001_d12_msgid_generation, adr001_d13_stream_timeout, adr001_d14_stream_queuing, adr001_d15_activation_flow [EXTRACTED 1.00]
- **aichat-claw双层插件架构栈** — req002_aichat_node, req002_aichat_claw_plugin, req002_claw_adapter, req002_openclaw_adapter, req002_claw_router, req002_agent_tools [EXTRACTED 1.00]
- **REQ-003 非owner与aiclaw通讯完整方案** — req003_nonowner_req, req003_nonowner_backend, req003_nonowner_frontend, req003_im_aiclaw_friend_ext, req003_public_persona, req003_session_key_isolation, req003_friend_apply_forward, req003_safe_prompt_injection, req003_delayed_deletion [EXTRACTED 1.00]
- **REQ-002 aiclaw核心架构** — req002_requirements, adr001_aiclaw_architecture, req002_plugin_architecture, component_stream_processor, concept_streaming_protocol, data_model_im_aiclaw [EXTRACTED 1.00]
- **REQ-003 非owner通讯体系** — req003_requirements, req003_backend_design, req003_frontend_design, data_model_im_aiclaw_friend_ext, concept_security_prompt, component_user_apply_listener [EXTRACTED 1.00]
- **HuLa-Server微服务中间件生态** — server_deps_topology, service_gateway, service_oauth, service_ws, service_im, middleware_mysql, middleware_redis, middleware_rocketmq, middleware_nacos [EXTRACTED 1.00]
- **HuLa Runtime联调拓扑** — component_hula_server, component_aichat_plugins, component_openclaw, component_nacos, component_mysql, component_redis [INFERRED 0.80]
- **ISS-003修复决策与验证闭环** — risk_issue_003_sync_last_msg_id, risk_issue_003_review, risk_issue_003_e2e, issue_003_last_msg_id_sync, person_server_dev, person_reviewer [EXTRACTED 0.90]
- **问题全生命周期追踪** — risk_issue_log, issue_001_no_ai_reply, issue_002_page_db_inconsistent, issue_003_last_msg_id_sync, issue_004_monotonic_sql, issue_005_room_last_msg_id, issue_006_sender_active_time, issue_007_retry_push_consumer, issue_008_close_button, issue_009_contact_list_npe, issue_010_aiclaw_active_status, issue_011_remember_password, issue_012_cascade_soft_delete, issue_013_charset_hardening, issue_015_message_sorting [EXTRACTED 1.00]

## Communities (22 total, 5 thin omitted)

### Community 0 - "HuLa System Architecture"
Cohesion: 0.07
Nodes (56): aichat-plugins插件, HuLa-Admin管理端, HuLa客户端, HuLa-Server服务端, MySQL数据库, Nacos服务注册中心, openclaw AI引擎, Redis缓存 (+48 more)

### Community 1 - "ADR-001 aiclaw Architecture"
Cohesion: 0.05
Nodes (50): 加密激活token机制(AES-256-GCM), ADR-001 aiclaw架构决策, D10 离线消息：现有离线存储+plugins主动拉取+防抖合并, D11 首期客户端范围：移动端+Web端/桌面端同步, D12 msgId生成：server端生成plugins不携带, D13 流式断流兜底：server端超时检测与异常恢复, D14 流式期间消息处理：统一防抖+堆积不做严格串行, D15 激活流程简化：双token模型+CLI一键激活 (+42 more)

### Community 2 - "OpenClaw Agent Adapter"
Cohesion: 0.06
Nodes (15): ClawAdapter, StreamCallbacks, AgentEvent, DeviceIdentity, EventFrame, GatewayFrame, loadDeviceIdentity(), OpenclawAdapter (+7 more)

### Community 3 - "Claw Plugin Channel & Tools"
Cohesion: 0.1
Nodes (23): createHulaConfigAdapter(), hulaChannel, createHulaOutboundAdapter(), ApiResponse, FriendInfo, FriendSearchResult, HulaApiClient, register() (+15 more)

### Community 4 - "Message Processing Pipeline"
Cohesion: 0.09
Nodes (11): LastMessageContext, MessageHandler, HulaWSClient, HulaWSClientOptions, buildRequest(), ReceivedMessage, WSReqType, WSRequest (+3 more)

### Community 5 - "Activation & CLI Flow"
Cohesion: 0.11
Nodes (29): POST /api/aiclaw/activate, POST /api/aiclaw/create, POST /api/aiclaw/refresh-activation, aichat activate CLI命令, aichat start守护进程命令, AiclawCryptoService, TokenContextFilter, aiclaw AI助理概念 (+21 more)

### Community 6 - "IM API & Friend Features"
Cohesion: 0.12
Nodes (28): D1 用户模型：im_aiclaw扩展表+user_type=4, archive 联调接口契约, ContextPathFilter网关路径过滤, CursorPageBaseResp游标翻页, F14 好友申请通知区分AI助理, F15 aiclaw好友详情显示主人, F16 aiclaw管理详情页对外人设编辑, F17 aiclaw对话记录查看 (+20 more)

### Community 7 - "CLI & Configuration"
Cohesion: 0.17
Nodes (18): getMachineCode(), MACHINE_CODE_FILE, activate(), start(), args, handleActivate(), AICHAT_HOME, AichatConfig (+10 more)

### Community 8 - "Frontend aiclaw UI"
Cohesion: 0.17
Nodes (24): GET /api/im/aiclaw/{uid}/conversations, GET /api/im/aiclaw/{uid}/friends, GET /api/im/aiclaw/{uid}/conversations/{friendUid}/messages, DELETE /api/im/aiclaw/{uid}/friends/{friendUid}, PUT /api/im/aiclaw/{uid}/persona, PUT /api/im/aiclaw/{uid}/friends/{friendUid}/relation, per-user session隔离, 安全prompt注入机制 (+16 more)

### Community 9 - "Plugin Source Files"
Cohesion: 0.16
Nodes (22): HuLa Channel Config, HuLa Channel Plugin, HuLa Channel Outbound, HuLa API Client, Claw Plugin Entry, Find Friend Tool, Tools Registry, Send Message Tool (+14 more)

### Community 10 - "Backend Infrastructure"
Cohesion: 0.21
Nodes (20): 容器化构建, API网关 luohuo-gateway-server, IM业务服务 luohuo-im-server, Spring Cloud微服务, MySQL数据库, Nacos服务注册与配置中心, 认证服务 luohuo-oauth-server, Redis缓存 (+12 more)

### Community 11 - "Project Structure & Tasks"
Cohesion: 0.16
Nodes (17): aichat-claw插件层, aichat-node桥接层, 双层桥接架构, Monorepo结构, 目录盘点, 看板（legacy）, REQ-002激活流程简化, REQ-002后端任务 (+9 more)

### Community 12 - "OpenClaw Integration"
Cohesion: 0.14
Nodes (18): ADR-20260310 openclaw纳入核心交付链, ADR-20260313 openclaw替换为aichat-plugins, ADR-20260313 openclaw替换为aichat-plugins, Chat Completions API, hula_find_friend Agent Tool, hula_send_message Agent Tool, aichat-plugins monorepo目录结构, OpenClaw外部接口调查 (+10 more)

### Community 13 - "Server Middleware Stack"
Cohesion: 0.23
Nodes (16): archive REQ-001 Web端改造, StreamProcessor, UserApplyListener好友申请转发, XXL-Job延迟注销定时任务, CORS跨域配置, MySQL 8.0.30, Nacos v2.3.2, Redis (+8 more)

### Community 14 - "DevOps & Release"
Cohesion: 0.14
Nodes (16): Docker容器化构建, .env分层配置, 增量CI构建, JDK21后端基线, 本地私有镜像仓库, 人工审批发布, 三层分支模型, ADR-20260309-开发测试发布流程与分支策略 (+8 more)

### Community 15 - "Claw Adapter Layer"
Cohesion: 0.2
Nodes (14): ADR-20260310 openclaw纳入核心交付链, aichat-claw openclaw Plugin, ClawAdapter统一接口, ClawRouter多claw路由器, OpenclawAdapter WS RPC适配器, OpenClaw Chat Completions API, OpenClaw Gateway WebSocket RPC, Rationale 插件架构四层问题驱动 (+6 more)

### Community 16 - "Branching Strategy"
Cohesion: 0.4
Nodes (5): ADR-20260309 开发测试发布流程与分支策略, main/develop/feature分支策略, Docker Compose开发测试部署, 环境搭建任务分派, R-001 环境不完整导致后端无法本地构建

## Knowledge Gaps
- **131 isolated node(s):** `AichatConfig`, `AichatCredentials`, `ClawConfig`, `args`, `LastMessageContext` (+126 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ADR-001 aiclaw架构决策` connect `ADR-001 aiclaw Architecture` to `Activation & CLI Flow`, `IM API & Friend Features`, `Claw Adapter Layer`?**
  _High betweenness centrality (0.125) - this node is a cross-community bridge._
- **Why does `AIclaw 功能需求设计 v1.2` connect `Activation & CLI Flow` to `ADR-001 aiclaw Architecture`, `Frontend aiclaw UI`, `Backend Infrastructure`, `Server Middleware Stack`, `Claw Adapter Layer`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._
- **Why does `流式消息协议` connect `Backend Infrastructure` to `Activation & CLI Flow`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **What connects `AichatConfig`, `AichatCredentials`, `ClawConfig` to the rest of the system?**
  _131 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `HuLa System Architecture` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `ADR-001 aiclaw Architecture` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `OpenClaw Agent Adapter` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
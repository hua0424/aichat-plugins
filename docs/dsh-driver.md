# DSH driver（第 5 个 AgentDriver）

`DshHeadlessDriver`（`packages/node/src/agent/dsh/`）：DSH（`dsh` CLI）以 node-driven
headless 形态接入 aichat-node，与 cc 同构（`#420` Milestone 31「DSH 作为第 5 AgentDriver 接入 plugins」，
实施票 #421–#424，验收票 #425）。

## 注册与运行时契约

- 注册：`commands/start.ts` 的 `descriptors` 表 `['dsh', …]`，
  `features = { cancel: 'best-effort', reset: 'supported', promptUpdate: 'new-session' }`（与 codex 同格）。
- 身份钥匙：`DSH_SESSION_ID`（`capability/context-descriptors.ts` 的 native-env 表，
  与 `OPENCODE_SESSION_ID` / `CODEX_THREAD_ID` / `OPENCLAW_BIND` / `AICHAT_BIND` 同表）。
- 家目录：`~/.aichat/dsh/home`（`DSH_HOME`，deploy 拥有；driver 只继承、不另建第二个 home）。
  按身份会话工作区：`~/.aichat/dsh/workspace/<aiclawUid>/…`，每轮 cwd = 该 workspace。
- 调度：每轮 `dsh --profile headless --json [--session-id <id>]` 一发一进程；
  续会话靠 node 侧持久化的 nativeState sessionId 显式 `--session-id` 续接（不是 `--resume`）。
  `--json` 行词汇（`session` / `thinking` / `text` / `tool_call` / `tool_result` /
  `final` / `error`）由纯函数 `mapDshLine`（`agent/dsh/events.ts`）映射为统一 `AgentEvent`；
  截断行按 #423 规则 capped + `…[truncated]` 标记，终态 `final` 无损。

## 版本锁定（#425）

- `DSH_EXPECTED_VERSION = '0.2.0-rc.2'`（`agent/dsh/dsh-driver.ts`）。
  `connect()` 版本不符只隔离该身份（错误文本刻意不命中 supervisor transient 重试模式，
  不连累其它身份、不掀重试风暴）。
- .83 live 核实（2026-10-17）：容器内 `dsh --version` = `0.2.0-rc.2`；
  live `agent/dsh/dsh-driver.js` md5 `5d1e88cdee2d7865440da642f238652b`
 （`/workspace/plugins-dist/node/agent/dsh/` 与 `/tmp/aichat-node-stage/agent/dsh/` 两处一致，
  与 #424 部署 live 逐字相同 → #424 暂停态证据对本构件继续有效，见下 M4）。

## 语义（#421–#424 各票锁定，详见各票关闭评论）

- #421 最小闭环：预 spawn 重宣告 + 原子 `registerNative`；失败只隔离该身份。
- #422 续会话/reset：同会话多轮记忆连续；persona 或 workspace 变化时预 spawn 门拒绝旧会话续跑；
  owner 显式 reset 换代（history 保留，driver 无删除路径）。
- #423 诚实取消：子进程关闭≠停止证明；`groupGone` 检查 + `markStopUnconfirmed`，
  未确认则整会话暂停排队，不谎报 done。
- #424 人设-hash 门与 reset 提示链：`DSH_DRIFT_GATE_MESSAGE` 门语 + handler 分类器
  `isDshDriftGateError`；人设变更扇出 `DSH_PERSONA_CHANGED_NOTICE` 到全部 DSH 绑定房；
  撞门当轮即通知；reset 回执 `resetReceipts` 留 digest。

## Owner 安装示例（.83 实测路径）

```bash
# 1. 载体（容器内已有；自建主机同样要求）
dsh --version                                  # 必须 0.2.0-rc.2，否则该身份拒绝运行
# 2. 身份：aiclaw 条目 tool=dsh（如 DshAI 217369059208704），node 启动即注册；
#    DSH_HOME=~/.aichat/dsh/home 由部署提供，workspace 按身份自动派生
# 3. 群批准（owner）：先拉入群（aiclaw 自动入群），再批准
POST /im/room/group/member {"roomId":<群>,"uidList":[<dshUid>]}
PUT  /im/aiclaw/group/config {"aiclawUid":<dshUid>,"roomId":<群>,
      "approved":1,"mentionRequired":1,"respondToAi":0}
#    插件日志出现 [config] update roomId=<群> 即生效（ mención 触发，AI 间互答默认关）
# 4. 验证：私聊 ping → 回复；群内 @ → 回复；member-info 抽查见下 M2
```

## .83 整体验收矩阵（#425，2026-10-17 08:17–08:18 +8，网关 `192.168.8.83:18080`）

| # | 动作 | 结果（逐字） |
|---|---|---|
| M1 双身份共存 | DM ping DSH 房 `217369063403008` msg `217557849027584`；DM ping CC 房 `177189908388354` msg `217557857416192` | DSH 回 `217557899359232` “V425-M1-DSH-OK”（08:17:25.589）；CC 回 `217557903553537` “V425-M1-CC-OK”（08:17:26.470）。thinking 均为 status=1/has_response=1（DSH id `2111250162959179776`/9576ms/run `2bf54f27-4201-42d8-b3e8-0c48731d8a6d`；CC id `2111250172727713792`/7945ms/run `46f68370-0414-46d4-b352-fab2b09927c9`） |
| M2 查询能力 | DM 问 member-info（msg `217557974856704` 08:17:43.474） | 容器日志 `[capability] member-info <v3> → (uid=217369059208704, room=217369063403008, run=bound) ok`；回 `217558058742784` “查询结果：你的昵称是 Dawn（uid 10937855681024）。V425-M2-QUERY-OK”（08:18:03.313）；thinking status=1/17321ms run `b696f014-…` |
| M3 群聊回复 | Dawn 邀 DshAI 入「REQ-018验收群」`192033499994624`（auto-join，inviter=owner 故无待批通知）→ 批准 approved=1/mentionRequired=1/respondToAi=0（workspaceDir=NULL=插件派生默认）→ @ 探测 msg `217558113268736`（08:18:16.254） | 回 `217558171988992` “V425-M3-GROUP-OK”（08:18:30.903）；thinking `2111250439531585536` status=1/has_response=1/8802ms run `af79a760-…`。首条 DSH 群回复 |
| M4 暂停态 | 本轮未重放中断（有界轮内避免 timing-sensitive 的 live 中断）；载体同一性：live md5 见上“版本锁定”，与 #424 部署逐字相同 | 沿用 #424 同构件证据：L2 暂停排队 ack + store `stop_unconfirmed` + 离线 recover-run + reset-session 换代链（`verify-424-report.md`）。矩阵后 store：DM 房 ready/gen7 有 dsh 绑定；群房 ready/gen1；无 pending |

## 未测边界（登记，不隐瞒）

- 多 DSH 绑定房同时扇出（本轮 DM + 群各一房，无并发多房）。
- 同值人设重存不通知路径、persona 缓存重取失败路径（单测覆盖，未现场复现）。
- 并发 reset 竞态 / 重复 requestId 拒绝（单测覆盖，未现场复现）。
- 群批准走的是 workspaceDir=NULL 默认派生；显式工作目录批准路径未现场走。
- DSH 侧其它能力调用（列好友/列群/列成员）未 live 抽查，仅 member-info。
- M4 本轮无 fresh 中断重放（见上）。

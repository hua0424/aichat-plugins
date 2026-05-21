# AntiLoopGuard 多实例部署限制

## 约束说明

`AntiLoopGuard` 的 `roomStates` 和 `aiRoundCount` 维护在**单 aichat-node 进程内存**中。

## 影响

如果同一 aiclaw 运行多个 aichat-node 实例（水平扩展）：

- 各实例的 `aiRoundCount` 互不同步，指数退避效果减弱

## 当前部署假设

每个 aiclaw 仅运行**一个 aichat-node 进程**（单实例）。

## 未来扩展

若需水平扩展，需引入 Redis 或共享存储同步 `aiRoundCount`。

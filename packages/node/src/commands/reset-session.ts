import { runCapabilityCommand } from './capability-command.js';

/** Reset only the core-bound conversation, never an identity/room provided by the caller. */
export async function handleResetSession(args: string[]): Promise<void> {
	return runCapabilityCommand('reset-session', args, (result) => {
		if (result?.reset === true) return result.executionPaused
			? `会话已重置：room ${result.roomId}（driver=${result.driverType}），旧任务停止未确认，执行仍暂停。`
			: `会话已重置：room ${result.roomId}（driver=${result.driverType}），下一条消息将开启全新会话（上下文已清空）。`;
		return `no-op：driver=${result?.driverType} 无按房会话态（binding 即会话，无持久上下文），无需 reset。`;
	}, true);
}

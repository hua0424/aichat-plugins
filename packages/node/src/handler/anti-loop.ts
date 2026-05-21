/**
 * REQ-004 M4: AntiLoopGuard
 * Node 内存层防循环：AI 互触发、指数退避
 *
 * 【S4 限制】roomStates 维护在单 aichat-node 进程内存中。
 * 同一 aiclaw 多实例（水平扩展）时，aiRoundCount 互不同步。
 * 当前部署假设：每个 aiclaw 仅运行单实例。
 */

export interface GuardCheckInput {
	roomId: number;
	fromUid: number;
	selfUid: number;
	content: string;
	isFromAi: boolean;
}

export interface GuardCheckResult {
	action: 'allow' | 'block' | 'delay';
	reason?: string;
	delayMs?: number;
}

interface RoomState {
	/** 连续 AI-to-AI 轮数 */
	aiRoundCount: number;
	/** 最后一条消息是否来自 AI */
	lastMessageFromAi: boolean;
	/** 最后一条消息的 fromUid */
	lastFromUid: number;
	/** 更新时间 */
	lastUpdateTime: number;
}

export class AntiLoopGuard {
	/** 每房间状态：key = `${roomId}` */
	private roomStates = new Map<string, RoomState>();

	/** 状态过期清理（30 分钟无更新自动删除） */
	private readonly STATE_TTL_MS = 30 * 60 * 1000;

	check(input: GuardCheckInput): GuardCheckResult {
		const { roomId, fromUid, selfUid, isFromAi } = input;
		const roomKey = String(roomId);

		// 清理过期状态
		this.cleanupExpiredStates();

		// 获取或创建房间状态
		let state = this.roomStates.get(roomKey);
		if (!state) {
			state = {
				aiRoundCount: 0,
				lastMessageFromAi: false,
				lastFromUid: 0,
				lastUpdateTime: Date.now(),
			};
			this.roomStates.set(roomKey, state);
		}

		// --- 规则 1：AI 互触发检查 + 指数退避 ---
		if (isFromAi) {
			if (state.lastMessageFromAi && state.lastFromUid !== selfUid) {
				state.aiRoundCount++;
			}

			const delayMs = this.calculateBackoffDelay(state.aiRoundCount);
			if (delayMs > 0) {
				state.lastMessageFromAi = true;
				state.lastFromUid = fromUid;
				state.lastUpdateTime = Date.now();
				return { action: 'delay', delayMs };
			}
		} else {
			// 人类消息：重置 AI-to-AI 计数器
			state.aiRoundCount = 0;
		}

		state.lastMessageFromAi = isFromAi;
		state.lastFromUid = fromUid;
		state.lastUpdateTime = Date.now();

		return { action: 'allow' };
	}

	/** 获取指定房间的 AI-to-AI 轮数（仅用于日志/debug） */
	getAiRoundCount(roomId: number): number {
		return this.roomStates.get(String(roomId))?.aiRoundCount ?? 0;
	}

	private calculateBackoffDelay(aiRoundCount: number): number {
		if (aiRoundCount <= 5) return 0;
		if (aiRoundCount <= 10) return 5000;
		if (aiRoundCount <= 20) return 15000;
		return 30000;
	}

	private cleanupExpiredStates(): void {
		const now = Date.now();
		for (const [key, state] of this.roomStates) {
			if (now - state.lastUpdateTime > this.STATE_TTL_MS) {
				this.roomStates.delete(key);
			}
		}
	}
}

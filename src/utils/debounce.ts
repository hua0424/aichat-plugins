/**
 * 消息防抖合并器
 * 规则：2s 缓冲 / 5 条上限 / 10s 最大等待
 */
export class MessageDebouncer {
	private buffer: string[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private startTime = 0;
	private onFlush: (merged: string) => void;

	private readonly waitMs: number;
	private readonly maxCount: number;
	private readonly maxWaitMs: number;

	constructor(
		onFlush: (merged: string) => void,
		options?: { waitMs?: number; maxCount?: number; maxWaitMs?: number },
	) {
		this.onFlush = onFlush;
		this.waitMs = options?.waitMs ?? 2000;
		this.maxCount = options?.maxCount ?? 5;
		this.maxWaitMs = options?.maxWaitMs ?? 10000;
	}

	push(message: string): void {
		if (this.buffer.length === 0) {
			this.startTime = Date.now();
		}

		this.buffer.push(message);

		// 达到条数上限，立即发送
		if (this.buffer.length >= this.maxCount) {
			this.flush();
			return;
		}

		// 超过最大等待时间，立即发送
		if (Date.now() - this.startTime >= this.maxWaitMs) {
			this.flush();
			return;
		}

		// 重置计时器
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => this.flush(), this.waitMs);
	}

	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.buffer.length === 0) return;

		const merged = this.buffer.join('\n');
		this.buffer = [];
		this.startTime = 0;
		this.onFlush(merged);
	}

	get pending(): number {
		return this.buffer.length;
	}
}

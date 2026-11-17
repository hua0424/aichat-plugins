/**
 * 消息防抖合并器
 * 规则：2s 缓冲 / 5 条上限 / 10s 最大等待
 */
export type BufferedMessage = string | (() => string);

export class MessageDebouncer {
	private buffer: BufferedMessage[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private startTime = 0;
	private onFlush: (merged: string, current: () => string) => void;

	private readonly waitMs: number;
	private readonly maxCount: number;
	private readonly maxWaitMs: number;

	constructor(
		onFlush: (merged: string, current: () => string) => void,
		options?: { waitMs?: number; maxCount?: number; maxWaitMs?: number },
	) {
		this.onFlush = onFlush;
		this.waitMs = options?.waitMs ?? 2000;
		this.maxCount = options?.maxCount ?? 5;
		this.maxWaitMs = options?.maxWaitMs ?? 10000;
	}

	push(message: BufferedMessage): void {
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

		const buffer = this.buffer;
		this.buffer = [];
		this.startTime = 0;
		// Deferred retries stay generation-checked if the consumer has to queue them again.
		const current = () => buffer.map(message => typeof message === 'function' ? message() : message).filter(Boolean).join('\n');
		const merged = current();
		if (merged) this.onFlush(merged, current);
	}

	/** 取消并丢弃缓冲（teardown 时用，避免 flush 重新触发回调） */
	cancel(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.buffer = [];
		this.startTime = 0;
	}

	get pending(): number {
		return this.buffer.length;
	}
}

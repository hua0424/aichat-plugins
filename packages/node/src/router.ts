import type { ClawAdapter } from './claw/interface.js';

/**
 * Claw 路由器
 * 管理多个 ClawAdapter，按 type 路由请求
 */
export class ClawRouter {
	private adapters = new Map<string, ClawAdapter>();

	/**
	 * 注册适配器
	 */
	register(adapter: ClawAdapter): void {
		if (this.adapters.has(adapter.type)) {
			throw new Error(`ClawAdapter type "${adapter.type}" already registered`);
		}
		this.adapters.set(adapter.type, adapter);
	}

	/**
	 * 获取适配器
	 */
	getAdapter(type: string): ClawAdapter | undefined {
		return this.adapters.get(type);
	}

	/**
	 * 获取默认适配器（第一个注册的）
	 */
	getDefault(): ClawAdapter | undefined {
		return this.adapters.values().next().value;
	}

	/**
	 * 连接所有适配器
	 */
	async connectAll(): Promise<void> {
		const promises = [];
		for (const [type, adapter] of this.adapters) {
			console.log(`[router] Connecting ${type}...`);
			promises.push(adapter.connect());
		}
		await Promise.all(promises);
	}

	/**
	 * 断开所有适配器
	 */
	async disconnectAll(): Promise<void> {
		const promises = [];
		for (const [type, adapter] of this.adapters) {
			console.log(`[router] Disconnecting ${type}...`);
			promises.push(adapter.disconnect().catch((err) => {
				console.error(`[router] Failed to disconnect ${type}:`, err);
			}));
		}
		await Promise.all(promises);
	}

	/**
	 * 所有已注册的类型
	 */
	get types(): string[] {
		return [...this.adapters.keys()];
	}
}

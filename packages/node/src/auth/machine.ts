import { v4 as uuidv4 } from 'uuid';

/**
 * 生成一个机器码（每次调用都返回全新且唯一的值）。
 *
 * 机器码会成为 WS clientId，因此**必须每个身份唯一**：多个 AI 身份在同一
 * 会话/cwd 下激活时若共用同一机器码，其 WS 设备会话会在服务端撞车，导致
 * 某个身份被静默踢出所有群消息推送（见 aichatoverview#122）。
 *
 * 稳定性（重启/重新激活复用同一机器码）来自每个身份自己的**凭据文件**——
 * `resolveAgentCredential`（registry.ts）在缓存命中时读取已持久化的
 * `machineCode`，因此正常重启不会再调用本函数。本函数只在激活 / 缓存未命中
 * 时被调用（activate.ts 将返回值写入凭据；start.ts 的返回值仅在缓存未命中
 * 时使用），所以这里只需产出一个新的唯一值即可。
 */
export function getMachineCode(): string {
	return uuidv4();
}

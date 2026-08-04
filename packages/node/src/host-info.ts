import os from 'node:os';

/**
 * #193: 上报给 server 的主机信息。`ip` / `workspaceBase` 可省略：
 * 省略 = 字段不出现在 JSON body（server 端按字段合并，blank 保留旧值）。
 */
export interface HostInfo {
	hostname: string;
	ip?: string;
	workspaceBase?: string;
}

/**
 * #193: 收集本机主机信息（首连 + 每次重连时上报）。
 * - hostname = os.hostname()
 * - ip = 主网卡 IPv4：遍历 os.networkInterfaces()，取第一个 `family==='IPv4' && !internal` 的
 *   地址（跳过 loopback / docker 内部网桥 / IPv6）；找不到则 ip 省略。
 * - workspaceBase 仅当实参非空白时带上（openclaw 无 workspace 概念 → 调用方传 undefined）。
 *
 * 为可测性接受可选注入（net / host 缺省走真实 os 实现），测试注入假网卡表。
 */
export function collectHostInfo(
	workspaceBase?: string,
	net: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = () => os.networkInterfaces(),
	host: () => string = () => os.hostname(),
): HostInfo {
	const info: HostInfo = { hostname: host() };
	const ifaces = net();
	outer: for (const list of Object.values(ifaces)) {
		for (const ni of list ?? []) {
			if (ni.family === 'IPv4' && !ni.internal) {
				info.ip = ni.address;
				break outer;
			}
		}
	}
	if (workspaceBase !== undefined && workspaceBase.trim() !== '') {
		info.workspaceBase = workspaceBase;
	}
	return info;
}

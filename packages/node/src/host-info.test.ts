import { describe, it, expect } from 'vitest';
import type os from 'node:os';
import { collectHostInfo } from './host-info.js';

/** 造一条网卡记录（NetworkInterfaceInfo 全字段，未列字段用占位值）。 */
function iface(over: Partial<os.NetworkInterfaceInfo>): os.NetworkInterfaceInfo {
	return {
		address: '0.0.0.0',
		netmask: '255.255.255.0',
		family: 'IPv4',
		mac: '00:00:00:00:00:00',
		internal: false,
		cidr: '0.0.0.0/24',
		...over,
	};
}

describe('collectHostInfo (#193)', () => {
	it('hostname 取自注入的 host()；ip 取第一个非 internal 的外部 IPv4', () => {
		const info = collectHostInfo(
			undefined,
			() => ({
				lo: [iface({ address: '127.0.0.1', internal: true, cidr: '127.0.0.1/8' })],
				eth0: [iface({ address: '192.168.1.10', cidr: '192.168.1.10/24' })],
			}),
			() => 'my-host',
		);
		expect(info.hostname).toBe('my-host');
		expect(info.ip).toBe('192.168.1.10');
	});

	it('跳过 internal 地址与 IPv6；多网卡按遍历序取第一个外部 IPv4', () => {
		const info = collectHostInfo(
			undefined,
			() => ({
				lo: [iface({ address: '127.0.0.1', internal: true, cidr: '127.0.0.1/8' })],
				docker0: [iface({ address: '172.17.0.1', internal: true, cidr: '172.17.0.1/16' })],
				eth0: [
					iface({ address: 'fe80::1', family: 'IPv6', cidr: 'fe80::1/64' }),
					iface({ address: '10.38.10.20', cidr: '10.38.10.20/24' }),
					iface({ address: '10.38.10.21', cidr: '10.38.10.21/24' }),
				],
			}),
			() => 'h',
		);
		expect(info.ip).toBe('10.38.10.20');
	});

	it('全部网卡均 internal（或为空）时 ip 字段省略（undefined）', () => {
		const info = collectHostInfo(
			undefined,
			() => ({ lo: [iface({ address: '127.0.0.1', internal: true, cidr: '127.0.0.1/8' })] }),
			() => 'h',
		);
		expect(info.hostname).toBe('h');
		expect(info.ip).toBeUndefined();
		expect('ip' in info).toBe(false);

		const empty = collectHostInfo(undefined, () => ({}), () => 'h');
		expect('ip' in empty).toBe(false);
	});

	it('workspaceBase 非空白时带上；undefined / 纯空白时字段省略', () => {
		const withBase = collectHostInfo('/data/aichat/cc/workspace', () => ({}), () => 'h');
		expect(withBase.workspaceBase).toBe('/data/aichat/cc/workspace');

		const blank = collectHostInfo('   \n\t ', () => ({}), () => 'h');
		expect(blank.workspaceBase).toBeUndefined();
		expect('workspaceBase' in blank).toBe(false);

		const absent = collectHostInfo(undefined, () => ({}), () => 'h');
		expect('workspaceBase' in absent).toBe(false);
	});

	it('缺省注入走真实 os 实现（仅冒烟：hostname 非空）', () => {
		const info = collectHostInfo();
		expect(info.hostname.length).toBeGreaterThan(0);
	});
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CcDriver, parseCcBinding } from './cc-driver.js';

const tmpDirs: string[] = [];
function freshBase(): string {
	const d = mkdtempSync(join(tmpdir(), 'cc-driver-test-'));
	tmpDirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of tmpDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

describe('parseCcBinding', () => {
	it('valid binding → uids', () => {
		expect(parseCcBinding('aiclaw-12-room-34')).toEqual({ aiclawUid: 12, roomId: 34 });
	});

	it('garbage → undefined', () => {
		expect(parseCcBinding('garbage')).toBeUndefined();
		expect(parseCcBinding('')).toBeUndefined();
		expect(parseCcBinding('aiclaw-1-room-')).toBeUndefined();
		expect(parseCcBinding('aiclaw--room-2')).toBeUndefined();
	});

	it('still-prefixed cc:… → undefined (the endpoint must strip cc: first)', () => {
		expect(parseCcBinding('cc:aiclaw-1-room-2')).toBeUndefined();
	});
});

describe('CcDriver', () => {
	it('type=cc and drivesTurns=false (node does not drive cc turns)', () => {
		const d = new CcDriver({ workspaceBase: freshBase(), brokerPort: 9100 });
		expect(d.type).toBe('cc');
		expect(d.drivesTurns).toBe(false);
	});

	it('resolveSession mirrors parseCcBinding (valid → uids, garbage/prefixed → undefined)', () => {
		const d = new CcDriver({ workspaceBase: freshBase(), brokerPort: 9100 });
		expect(d.resolveSession('aiclaw-7-room-8')).toEqual({ aiclawUid: 7, roomId: 8 });
		expect(d.resolveSession('nope')).toBeUndefined();
		expect(d.resolveSession('cc:aiclaw-7-room-8')).toBeUndefined();
	});

	it('connect/disconnect are no-ops', async () => {
		const d = new CcDriver({ workspaceBase: freshBase(), brokerPort: 9100 });
		await expect(d.connect()).resolves.toBeUndefined();
		await expect(d.disconnect()).resolves.toBeUndefined();
	});

	it('openSession throws a clear owner-driven error (never a fake turn-driving session)', async () => {
		const d = new CcDriver({ workspaceBase: freshBase(), brokerPort: 9100 });
		await expect(d.openSession()).rejects.toThrow(/owner-driven/);
	});

	it('bind composes the binding, writes settings, returns a launchCommand with AICHAT_BIND + --settings', () => {
		const base = freshBase();
		const d = new CcDriver({ workspaceBase: base, brokerPort: 9100 });
		// group context → workspace under <base>/<uid>/group/<account ?? roomId>
		const out = d.bind(5, 42, { roomType: 1, roomId: 42, account: 'g777' });

		expect(out.token).toBe('aiclaw-5-room-42');
		expect(out.workspaceDir).toBe(join(base, '5', 'group', 'g777'));
		expect(out.settingsPath).toBe(join(out.workspaceDir, 'settings.json'));
		expect(existsSync(out.settingsPath)).toBe(true);

		// launch command contains the AICHAT_BIND binding + the --settings path.
		expect(out.launchCommand).toContain("AICHAT_BIND='aiclaw-5-room-42'");
		expect(out.launchCommand).toContain(`--settings '${out.settingsPath}'`);
		expect(out.launchCommand).toContain(`cd '${out.workspaceDir}'`);

		// REQ-011 S2: the launch command also registers the persistent channels MCP and opts into channels.
		expect(out.launchCommand).toContain('claude mcp add aichat-channel');
		expect(out.launchCommand).toContain('--dangerously-load-development-channels server:aichat-channel');

		// the written settings carry the broker port in the hooks + the aichat bash permission.
		const settings = JSON.parse(readFileSync(out.settingsPath, 'utf-8'));
		expect(JSON.stringify(settings)).toContain('127.0.0.1:9100');
		expect(settings.permissions.allow).toContain('Bash(aichat:*)');
	});

	it('bind for a DM with isOwner derives the owner workspace dir', () => {
		const base = freshBase();
		const d = new CcDriver({ workspaceBase: base, brokerPort: 9100 });
		const out = d.bind(5, 9, { roomType: 2, roomId: 9, isOwner: true });
		expect(out.workspaceDir).toBe(join(base, '5', 'owner'));
	});
});

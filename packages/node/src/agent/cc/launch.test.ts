import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { buildCcHooksSettings, buildCcSettings, writeCcSettings, CC_REPLY_CONTRACT } from './launch.js';

/** The events chunk-2 must wire (the broker dispatches by hook_event_name). */
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'MessageDisplay', 'Stop', 'SessionStart'] as const;

/** Narrow the loosely-typed settings shape to the claude-code hooks subset we assert on. */
interface HookCmd {
	type: string;
	command: string;
	async?: boolean;
}
interface HookMatcher {
	matcher?: string;
	hooks: HookCmd[];
}
interface CcHooks {
	[event: string]: HookMatcher[];
}
function hooksOf(settings: object): CcHooks {
	return (settings as { hooks: CcHooks }).hooks;
}
/** The single command string for an event's first matcher entry. */
function commandFor(hooks: CcHooks, event: string): string {
	return hooks[event][0].hooks[0].command;
}

describe('buildCcHooksSettings', () => {
	const PORT = 9573; // non-default port to prove interpolation

	it('wires all five lifecycle events', () => {
		const hooks = hooksOf({ hooks: buildCcHooksSettings(PORT) });
		for (const event of EVENTS) {
			expect(hooks[event], `missing hook for ${event}`).toBeDefined();
			expect(hooks[event][0].hooks[0].type).toBe('command');
		}
	});

	it('each command POSTs to the broker /hook with the Bearer header and --data-binary @-', () => {
		const hooks = hooksOf({ hooks: buildCcHooksSettings(PORT) });
		for (const event of EVENTS) {
			const cmd = commandFor(hooks, event);
			expect(cmd).toContain(`http://127.0.0.1:${PORT}/hook`);
			expect(cmd).toContain('-H "Authorization: Bearer $AICHAT_BIND"');
			expect(cmd).toContain('--data-binary @-');
			expect(cmd).toContain('-X POST');
		}
	});

	it('interpolates the broker port (different port → different URL)', () => {
		const a = commandFor(hooksOf({ hooks: buildCcHooksSettings(1111) }), 'Stop');
		const b = commandFor(hooksOf({ hooks: buildCcHooksSettings(2222) }), 'Stop');
		expect(a).toContain('http://127.0.0.1:1111/hook');
		expect(b).toContain('http://127.0.0.1:2222/hook');
		expect(a).not.toEqual(b);
	});

	it('marks every hook async (non-blocking mirror — must not slow CC turn)', () => {
		const hooks = hooksOf({ hooks: buildCcHooksSettings(PORT) });
		for (const event of EVENTS) {
			expect(hooks[event][0].hooks[0].async, `${event} must be async`).toBe(true);
		}
	});

	it('PostToolUse uses the "*" matcher', () => {
		const hooks = hooksOf({ hooks: buildCcHooksSettings(PORT) });
		expect(hooks.PostToolUse[0].matcher).toBe('*');
	});
});

describe('buildCcSettings', () => {
	const PORT = 9100;

	it('includes the hooks from buildCcHooksSettings', () => {
		const settings = buildCcSettings(PORT);
		const hooks = hooksOf(settings);
		for (const event of EVENTS) {
			expect(hooks[event]).toBeDefined();
		}
		// Identical hook payload to the standalone generator.
		expect(hooks).toEqual(buildCcHooksSettings(PORT));
	});

	it('permits the aichat reply CLI as a Bash rule (unattended replies)', () => {
		const settings = buildCcSettings(PORT) as { permissions: { allow: string[] } };
		expect(settings.permissions.allow).toContain('Bash(aichat:*)');
	});
});

describe('writeCcSettings', () => {
	it('writes valid JSON settings.json into the dir and returns its absolute path', () => {
		const dir = mkdtempSync(join(tmpdir(), 'aichat-cc-'));
		const settings = buildCcSettings(9100);

		const path = writeCcSettings(dir, settings);

		expect(path).toBe(join(dir, 'settings.json'));
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, 'utf-8'));
		expect(parsed).toEqual(settings);
	});

	it('creates the target dir if it does not exist (mkdir -p)', () => {
		const base = mkdtempSync(join(tmpdir(), 'aichat-cc-'));
		const nested = join(base, 'a', 'b', 'c');
		const settings = buildCcSettings(9100);

		const path = writeCcSettings(nested, settings);

		expect(existsSync(path)).toBe(true);
		expect(path).toBe(join(nested, 'settings.json'));
	});
});

describe('CC_REPLY_CONTRACT (REQ-010 #102 — skill≠sent enforcement)', () => {
	it('mandates actually running the send-message bash command', () => {
		expect(CC_REPLY_CONTRACT).toContain('aichat send-message');
	});

	it('warns that invoking the skill / claiming "已发送" does NOT send', () => {
		expect(CC_REPLY_CONTRACT).toContain('aichat-reply');
		expect(CC_REPLY_CONTRACT).toContain('不会发送');
	});

	it('forbids passing room/identity args (AICHAT_BIND auto-binds)', () => {
		expect(CC_REPLY_CONTRACT).toContain('AICHAT_BIND');
		expect(CC_REPLY_CONTRACT).toContain('绝不要传 --room');
	});

	it('forbids claiming sent before actually running the command', () => {
		expect(CC_REPLY_CONTRACT).toContain('在你真正运行过该命令之前，绝不要声称已发送');
	});
});

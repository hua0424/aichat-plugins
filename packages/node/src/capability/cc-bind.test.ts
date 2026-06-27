import { describe, it, expect, vi } from 'vitest';
import { ccBindAdminHandler, type CcBindableAgent } from './cc-bind.js';
import type { CcDriver, CcBindInstructions } from '../agent/cc/cc-driver.js';

/** A fake cc identity: a driver of type 'cc' with a spy bind() returning canned instructions. */
function ccAgent(uid: number): CcBindableAgent & { bind: ReturnType<typeof vi.fn> } {
	const bind = vi.fn(
		(ccUid: number, roomId: number): CcBindInstructions => ({
			token: `aiclaw-${ccUid}-room-${roomId}`,
			launchCommand: `cd '/ws/${ccUid}/group/${roomId}' && AICHAT_BIND='aiclaw-${ccUid}-room-${roomId}' claude --settings '/ws/${ccUid}/group/${roomId}/settings.json'`,
			settingsPath: `/ws/${ccUid}/group/${roomId}/settings.json`,
			workspaceDir: `/ws/${ccUid}/group/${roomId}`,
		}),
	);
	return { uid, driver: { type: 'cc', bind: bind as unknown as CcDriver['bind'] }, bind };
}

/** A non-cc identity (must be ignored by cc-bind). */
function otherAgent(uid: number): CcBindableAgent {
	return { uid, driver: { type: 'opencode' } };
}

describe('ccBindAdminHandler', () => {
	it('one cc identity → returns its launchCommand + workspaceDir for the room', async () => {
		const cc = ccAgent(5);
		const handler = ccBindAdminHandler([otherAgent(7), cc]);
		const res = await handler({ admin: 'cc-bind', roomId: 42 });

		expect(cc.bind).toHaveBeenCalledWith(5, 42, expect.objectContaining({ roomId: 42 }));
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({
			ok: true,
			result: {
				launchCommand: expect.stringContaining("AICHAT_BIND='aiclaw-5-room-42'"),
				workspaceDir: '/ws/5/group/42',
			},
		});
	});

	it('zero cc identities → clear error (400)', async () => {
		const handler = ccBindAdminHandler([otherAgent(7)]);
		const res = await handler({ admin: 'cc-bind', roomId: 42 });
		expect(res.status).toBe(400);
		expect(res.json).toMatchObject({ ok: false, error: expect.stringMatching(/no cc/i) });
	});

	it('multiple cc identities without --uid → error asking to disambiguate', async () => {
		const handler = ccBindAdminHandler([ccAgent(5), ccAgent(6)]);
		const res = await handler({ admin: 'cc-bind', roomId: 42 });
		expect(res.status).toBe(400);
		expect(res.json).toMatchObject({ ok: false, error: expect.stringMatching(/multiple cc/i) });
	});

	it('multiple cc identities with --uid → binds the matching one', async () => {
		const cc5 = ccAgent(5);
		const cc6 = ccAgent(6);
		const handler = ccBindAdminHandler([cc5, cc6]);
		const res = await handler({ admin: 'cc-bind', roomId: 42, uid: 6 });
		expect(res.status).toBe(200);
		expect(cc6.bind).toHaveBeenCalledWith(6, 42, expect.objectContaining({ roomId: 42 }));
		expect(cc5.bind).not.toHaveBeenCalled();
	});

	it('--uid not among cc identities → error', async () => {
		const handler = ccBindAdminHandler([ccAgent(5), ccAgent(6)]);
		const res = await handler({ admin: 'cc-bind', roomId: 42, uid: 99 });
		expect(res.status).toBe(400);
		expect(res.json).toMatchObject({ ok: false, error: expect.stringMatching(/uid 99/) });
	});

	it('missing/invalid roomId → 400', async () => {
		const handler = ccBindAdminHandler([ccAgent(5)]);
		expect((await handler({ admin: 'cc-bind' })).status).toBe(400);
		expect((await handler({ admin: 'cc-bind', roomId: 0 })).status).toBe(400);
		expect((await handler({ admin: 'cc-bind', roomId: -1 })).status).toBe(400);
	});
});

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { deriveWorkspaceDir } from './workspace.js';

const BASE = '/tmp/ws';
const UID = 5; // REQ-008 #77 fix: every path is namespaced by aiclawUid first.

describe('deriveWorkspaceDir', () => {
	it('group (roomType=1) → <base>/<aiclawUid>/group/<roomId>', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42 })).toBe(join(BASE, '5', 'group', '42'));
	});

	it('REQ-009 #85: group WITH account (groupkey) → <base>/<aiclawUid>/group/<account>', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42, account: '888888' })).toBe(
			join(BASE, '5', 'group', '888888'),
		);
	});

	it('REQ-009 #85: group WITHOUT account → falls back to group/<roomId>', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42, account: undefined })).toBe(
			join(BASE, '5', 'group', '42'),
		);
	});

	it('REQ-009 #85: workspaceDir set → returned verbatim (absolute override, NOT namespaced)', () => {
		expect(
			deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42, account: '888888', workspaceDir: '/srv/proj' }),
		).toBe('/srv/proj');
	});

	it('REQ-009 #85: empty/whitespace workspaceDir is ignored → derives the default', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42, account: '888888', workspaceDir: '' })).toBe(
			join(BASE, '5', 'group', '888888'),
		);
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42, account: '888888', workspaceDir: '  ' })).toBe(
			join(BASE, '5', 'group', '888888'),
		);
	});

	it('REQ-009 #85: unknown roomType prefers account over roomId', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 99, roomId: 5, account: '777' })).toBe(
			join(BASE, '5', 'group', '777'),
		);
	});

	it('owner dm (roomType=2, isOwner) → <base>/<aiclawUid>/owner', () => {
		expect(
			deriveWorkspaceDir(BASE, UID, { roomType: 2, roomId: 7, counterpartUid: 10937, isOwner: true }),
		).toBe(join(BASE, '5', 'owner'));
	});

	it('friend dm (roomType=2, isOwner=false) → <base>/<aiclawUid>/dm/<counterpartUid>', () => {
		expect(
			deriveWorkspaceDir(BASE, UID, { roomType: 2, roomId: 7, counterpartUid: 1001, isOwner: false }),
		).toBe(join(BASE, '5', 'dm', '1001'));
	});

	it('dm (roomType=2) → <base>/<aiclawUid>/dm/<counterpartUid>', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 2, roomId: 7, counterpartUid: 1001 })).toBe(
			join(BASE, '5', 'dm', '1001'),
		);
	});

	it('dm without counterpartUid → falls back to roomId (never collide all DMs)', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 2, roomId: 7 })).toBe(join(BASE, '5', 'dm', '7'));
	});

	it('unknown roomType → conservative group-by-roomId fallback', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 99, roomId: 5 })).toBe(join(BASE, '5', 'group', '5'));
	});

	it('REQ-010 S3: workspaceDir override of ~/foo/bar expands the leading ~ to homedir', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42, workspaceDir: '~/foo/bar' })).toBe(
			join(homedir(), 'foo', 'bar'),
		);
	});

	it('REQ-010 S3: a bare ~ override expands to homedir', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42, workspaceDir: '~' })).toBe(homedir());
	});

	it('REQ-010 S3: an absolute workspaceDir (no leading ~) is unchanged', () => {
		expect(deriveWorkspaceDir(BASE, UID, { roomType: 1, roomId: 42, workspaceDir: '/srv/proj' })).toBe('/srv/proj');
	});

	it('REQ-010 S3: a tilde-rooted base expands so no segment leaks an unexpanded ~', () => {
		expect(deriveWorkspaceDir('~/.aichat/ws', UID, { roomType: 1, roomId: 42 })).toBe(
			join(homedir(), '.aichat', 'ws', '5', 'group', '42'),
		);
	});

	it('#77 fix: two aiclaw identities NEVER collide on the same owner/group/dm dir', () => {
		const a = deriveWorkspaceDir(BASE, 1, { roomType: 2, roomId: 7, isOwner: true });
		const b = deriveWorkspaceDir(BASE, 2, { roomType: 2, roomId: 7, isOwner: true });
		expect(a).not.toBe(b);
		expect(a).toBe(join(BASE, '1', 'owner'));
		expect(b).toBe(join(BASE, '2', 'owner'));
	});
});

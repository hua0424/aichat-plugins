import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { deriveWorkspaceDir } from './workspace.js';

const BASE = '/tmp/ws';

describe('deriveWorkspaceDir', () => {
	it('group (roomType=1) → <base>/group/<roomId>', () => {
		expect(deriveWorkspaceDir(BASE, { roomType: 1, roomId: 42 })).toBe(join(BASE, 'group', '42'));
	});

	it('owner dm (roomType=2, isOwner) → <base>/owner', () => {
		expect(
			deriveWorkspaceDir(BASE, { roomType: 2, roomId: 7, counterpartUid: 10937, isOwner: true }),
		).toBe(join(BASE, 'owner'));
	});

	it('friend dm (roomType=2, isOwner=false) → <base>/dm/<counterpartUid>', () => {
		expect(
			deriveWorkspaceDir(BASE, { roomType: 2, roomId: 7, counterpartUid: 1001, isOwner: false }),
		).toBe(join(BASE, 'dm', '1001'));
	});

	it('dm (roomType=2) → <base>/dm/<counterpartUid>', () => {
		expect(deriveWorkspaceDir(BASE, { roomType: 2, roomId: 7, counterpartUid: 1001 })).toBe(
			join(BASE, 'dm', '1001'),
		);
	});

	it('dm without counterpartUid → falls back to roomId (never collide all DMs)', () => {
		expect(deriveWorkspaceDir(BASE, { roomType: 2, roomId: 7 })).toBe(join(BASE, 'dm', '7'));
	});

	it('unknown roomType → conservative group-by-roomId fallback', () => {
		expect(deriveWorkspaceDir(BASE, { roomType: 99, roomId: 5 })).toBe(join(BASE, 'group', '5'));
	});
});

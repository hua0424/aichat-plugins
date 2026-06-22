import { describe, it, expect } from 'vitest';
import { buildAgentInjection } from './media-inject.js';
import type { ReceivedMessage } from '../stream/protocol.js';

/** 构造 ReceivedMessage['message']，type + body 由调用方决定（绕过联合判别做白盒构造）。 */
function msg(type: number, body: Record<string, unknown>): ReceivedMessage['message'] {
	return { id: 1, roomId: 1, type, sendTime: '', body } as unknown as ReceivedMessage['message'];
}

describe('buildAgentInjection', () => {
	it('1. text (type 1) with content → returns content', () => {
		expect(buildAgentInjection(msg(1, { content: 'hello' }))).toBe('hello');
	});

	it('2. text empty/whitespace → null', () => {
		expect(buildAgentInjection(msg(1, { content: '   ' }))).toBeNull();
		expect(buildAgentInjection(msg(1, { content: '' }))).toBeNull();
	});

	it('3. IMG (type 3) → file-attachment block, no caption, no [SYSTEM]', () => {
		const out = buildAgentInjection(
			msg(3, {
				url: 'http://minio/tmp/chat/1_a.png?X-Amz-Signature=abc',
				size: 123,
				mime: 'image/png',
				fileName: 'a.png',
				width: 10,
				height: 20,
			}),
		);
		expect(out).not.toBeNull();
		const text = out!;
		expect(text).toContain('用户发送了一个文件附件：');
		expect(text).toContain('```file-attachment');
		expect(text).toContain('url: http://minio/tmp/chat/1_a.png?X-Amz-Signature=abc');
		expect(text).toContain('name: a.png');
		expect(text).toContain('mime: image/png');
		expect(text).toContain('size: 123');
		expect(text).not.toContain('用户附言');
		expect(text).not.toContain('[SYSTEM]');
	});

	it('4. FILE (type 4) → analogous block', () => {
		const out = buildAgentInjection(
			msg(4, {
				url: 'http://minio/tmp/chat/2_d.pdf?X-Amz-Signature=def',
				size: 456,
				mime: 'application/pdf',
				fileName: 'd.pdf',
			}),
		);
		expect(out).not.toBeNull();
		const text = out!;
		expect(text).toContain('url: http://minio/tmp/chat/2_d.pdf?X-Amz-Signature=def');
		expect(text).toContain('name: d.pdf');
		expect(text).toContain('mime: application/pdf');
		expect(text).toContain('size: 456');
		expect(text).not.toContain('[SYSTEM]');
	});

	it('5. IMG without mime → no mime line, still url/name/size', () => {
		const out = buildAgentInjection(
			msg(3, { url: 'http://minio/tmp/chat/3_b.png?x=1', size: 9, fileName: 'b.png', width: 1, height: 1 }),
		);
		expect(out).not.toBeNull();
		const text = out!;
		expect(text).not.toContain('mime:');
		expect(text).toContain('url: http://minio/tmp/chat/3_b.png?x=1');
		expect(text).toContain('name: b.png');
		expect(text).toContain('size: 9');
	});

	it('6. IMG without fileName → name derived from URL basename (query stripped)', () => {
		const out = buildAgentInjection(msg(3, { url: 'http://minio/tmp/chat/9_photo.webp?x=1', size: 7, width: 1, height: 1 }));
		expect(out).not.toBeNull();
		expect(out!).toContain('name: 9_photo.webp');
	});

	it('7. media without url → null', () => {
		expect(buildAgentInjection(msg(3, { size: 1, fileName: 'a.png' }))).toBeNull();
		expect(buildAgentInjection(msg(4, { url: '   ', size: 1 }))).toBeNull();
	});

	it('8. unsupported type (5) → null', () => {
		expect(buildAgentInjection(msg(5, { url: 'http://x/y.mp3?z=1', size: 1 }))).toBeNull();
	});

	it('9. media WITH caption → output ends with 用户附言：<caption>', () => {
		const out = buildAgentInjection(
			msg(3, { url: 'http://minio/tmp/chat/4_c.png?x=1', size: 5, mime: 'image/png', fileName: 'c.png', content: '看这个' }),
		);
		expect(out).not.toBeNull();
		expect(out!.endsWith('用户附言：看这个')).toBe(true);
	});
});

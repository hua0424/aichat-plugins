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

	// REQ-146 (#146): the caller resolves a SHORT-lived signed URL and passes it in.
	it('10. resolvedFileUrl is used OVER body.url when provided', () => {
		const out = buildAgentInjection(
			msg(4, { url: 'http://minio/OLD-7day.pdf?stale=1', size: 456, mime: 'application/pdf', fileName: 'd.pdf' }),
			'http://minio/tmp/chat/2_d.pdf?X-Amz-Signature=fresh-short',
		);
		expect(out).not.toBeNull();
		const text = out!;
		expect(text).toContain('url: http://minio/tmp/chat/2_d.pdf?X-Amz-Signature=fresh-short');
		expect(text).not.toContain('OLD-7day');
	});

	it('11. short-lived hint line is present in the file-attachment block', () => {
		const out = buildAgentInjection(
			msg(3, { url: 'http://x/y.png?x=1', size: 1, fileName: 'y.png' }),
			'http://x/signed.png?sig=1',
		);
		expect(out).not.toBeNull();
		expect(out!).toContain('链接短效有效，需要时立即获取，过期需重新索取');
	});

	it('12. resolvedFileUrl undefined → falls back to body.url (old pre-deploy messages / no apiClient)', () => {
		const out = buildAgentInjection(msg(3, { url: 'http://x/fallback.png?x=1', size: 1, fileName: 'y.png' }));
		expect(out).not.toBeNull();
		expect(out!).toContain('url: http://x/fallback.png?x=1');
	});

	it('13. neither resolvedFileUrl nor body.url → null (defensive)', () => {
		expect(buildAgentInjection(msg(3, { size: 1, fileName: 'a.png' }), undefined)).toBeNull();
		expect(buildAgentInjection(msg(4, { url: '   ', size: 1 }), '  ')).toBeNull();
	});

	it('14. #146: objectKey-only media body (url key OMITTED) + resolvedFileUrl → injection (NOT null)', () => {
		// server 对 url=null 省略字段：新 objectKey-only 消息 body 无 url 键。旧 `'url' in body` guard
		// 会误判非媒体→静默丢失。判别应只看 message.type(3/4)。
		const outFile = buildAgentInjection(msg(4, { size: 120, fileName: 'a.txt', objectKey: 'chat/a.txt' }), 'http://signed/re-signed?X-Amz=1');
		expect(outFile).not.toBeNull();
		expect(outFile!).toContain('url: http://signed/re-signed?X-Amz=1');
		expect(outFile!).toContain('name: a.txt');

		const outImg = buildAgentInjection(msg(3, { size: 60, width: 1, height: 1, objectKey: 'chat/b.png' }), 'http://signed/img?X-Amz=2');
		expect(outImg).not.toBeNull();
		expect(outImg!).toContain('url: http://signed/img?X-Amz=2');
	});
});

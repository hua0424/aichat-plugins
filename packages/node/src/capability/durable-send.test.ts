import { afterEach, describe, expect, it, vi } from 'vitest';
import { HulaApiClient } from '../api/hula-api.js';
import { CapabilityEndpoint } from './endpoint.js';
import { CapabilityRegistry, sendMessageCapability } from './registry.js';
import { randomUUID } from 'node:crypto';

const ok = (data: unknown): Response => ({ ok: true, json: async () => ({ success: true, data }) }) as Response;
const failure = (code: number): Response => ({ ok: true, json: async () => ({ success: false, code, msg: 'sensitive upstream detail' }) }) as Response;
const generatedId = () => `r${Date.now().toString(36)}.${randomUUID()}`;
const req = (requestId: string, content = 'hello') => ({ version: 2, contexts: [{ key: 'bound' }], command: 'send-message', args: { content }, requestId });
function endpoint(client: HulaApiClient, roomId = '42', uid = '7', generation = 1) {
	const registry = new CapabilityRegistry();
	registry.register('send-message', sendMessageCapability());
	return new CapabilityEndpoint({ registry, resolve: () => undefined,
		resolveCandidate: () => ({ conversationId: `${uid}:${roomId}`, generation, aiclawUid: uid, roomId, apiClient: client }) });
}

afterEach(() => vi.restoreAllMocks());

describe('T16 node → simulated server receipt integration (not live E2E)', () => {
	it('probes exact capability, retries a lost POST response using identical body/ID, and recovers after node restart', async () => {
		const receipts = new Map<string, { body: string; id: string }>();
		let dropped = true;
		let posts = 0;
		const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (String(url).endsWith('/receipt-capability')) return ok('requestId-v1;retention-min=7d');
			posts++;
			const body = init?.body as string;
			const request = JSON.parse(body) as { requestId: string };
			const prior = receipts.get(request.requestId);
			if (prior && prior.body !== body) return failure(43061);
			if (!prior) receipts.set(request.requestId, { body, id: '9007199254740993' });
			if (dropped) { dropped = false; throw new Error('response dropped after commit'); }
			return ok({ message: { id: receipts.get(request.requestId)!.id } });
		});
		const client = new HulaApiClient('http://test', 'token-secret');
		const requestId = generatedId();
		const first = await endpoint(client).handle({ body: req(requestId) });
		expect(first).toMatchObject({ status: 200, json: { result: { msgId: '9007199254740993', receiptMode: 'durable' } } });
		expect(posts).toBe(2);
		expect(receipts.size).toBe(1);
		expect(await endpoint(client).handle({ body: req(requestId) })).toMatchObject(first);
		expect(posts).toBe(3);
		// A new room generation after reset cannot recover the old receipt after node restart.
		expect(await endpoint(client, '42', '7', 2).handle({ body: req(requestId) }))
			.toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
		const requests = fetcher.mock.calls.filter(([url]) => !String(url).endsWith('/receipt-capability'));
		expect(requests.slice(0, 3).map(([, init]) => init?.body)).toEqual(Array(3).fill(requests[0][1]?.body));
		expect(requests[3][1]?.body).not.toEqual(requests[0][1]?.body);
		expect(JSON.stringify(first)).not.toContain('token-secret');
	});

	it('maps server 43061 to definitive conflict; 43062 to same-ID unknown, then confirms without new ID', async () => {
		const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok('requestId-v1;retention-min=7d'))
			.mockResolvedValueOnce(failure(43061))
			.mockResolvedValueOnce(ok('requestId-v1;retention-min=7d'))
			.mockResolvedValueOnce(failure(43062))
			.mockResolvedValueOnce(failure(43062))
			.mockResolvedValueOnce(failure(43062))
			.mockResolvedValueOnce(ok('requestId-v1;retention-min=7d'))
			.mockResolvedValueOnce(ok({ message: { id: '88' } }));
		const ep = endpoint(new HulaApiClient('http://test', 'secret'));
		const pending = generatedId();
		expect(await ep.handle({ body: req('conflict') })).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT', retryable: false } });
		expect(await ep.handle({ body: req(pending) })).toMatchObject({ status: 503, json: { code: 'DELIVERY_UNKNOWN', requestId: pending } });
		expect(await ep.handle({ body: req(pending) })).toMatchObject({ status: 200, json: { result: { msgId: '88' } } });
		expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/msg')).map(([, init]) => JSON.parse(init!.body as string).requestId))
			.toEqual(['conflict', pending, pending, pending, pending]);
	});

	it('failed capability probe is a retryable pre-write failure, not an unknown committed write', async () => {
		let postCount = 0;
		const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).endsWith('/receipt-capability')) throw new Error('probe offline');
			postCount++;
			return ok({ message: { id: '1' } });
		});
		const ep = endpoint(new HulaApiClient('http://test', 'secret'));
		const request = req(generatedId());
		expect(await ep.handle({ body: request })).toMatchObject({ status: 503, json: { code: 'UPSTREAM_FAILED', retryable: true } });
		expect(postCount).toBe(0);
		fetcher.mockImplementation(async (url) => String(url).endsWith('/receipt-capability')
			? ok('requestId-v1;retention-min=7d') : ok({ message: { id: '1' } }));
		expect(await ep.handle({ body: request })).toMatchObject({ status: 200, json: { result: { msgId: '1' } } });
	});

	it('definitive probe rejection retains authorization classification without a POST', async () => {
		let posts = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).endsWith('/receipt-capability')) return { ok: false, status: 403, text: async () => '' } as Response;
			posts++;
			return ok({ message: { id: '1' } });
		});
		expect(await endpoint(new HulaApiClient('http://test', 'secret')).handle({ body: req(generatedId()) }))
			.toMatchObject({ status: 403, json: { code: 'FORBIDDEN', retryable: false } });
		expect(posts).toBe(0);
	});

	it('stops retries if the seven-day window elapses between attempts', async () => {
		const now = Date.now();
		const id = `r${(now - 7 * 24 * 60 * 60 * 1000 + 100).toString(36)}.${randomUUID()}`;
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		let posts = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).endsWith('/receipt-capability')) return ok('requestId-v1;retention-min=7d');
			posts++;
			clock.mockReturnValue(now + 200);
			throw new Error('response lost');
		});
		expect(await endpoint(new HulaApiClient('http://test', 'secret')).handle({ body: req(id) }))
			.toMatchObject({ status: 503, json: { code: 'DELIVERY_UNKNOWN', requestId: id } });
		expect(posts).toBe(1);
	});

	it('legacy 404 never sends requestId or retries an unknown write; stale ID cannot auto replay', async () => {
		let posts = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (String(url).endsWith('/receipt-capability')) return { ok: false, status: 404, text: async () => '' } as Response;
			posts++;
			expect(JSON.parse(init!.body as string)).not.toHaveProperty('requestId');
			throw new Error('lost');
		});
		const ep = endpoint(new HulaApiClient('http://old', 'secret'));
		const first = await ep.handle({ body: req('legacy') });
		expect(first).toMatchObject({ status: 503, json: { code: 'DELIVERY_UNKNOWN' } });
		expect(JSON.stringify(first)).toContain('requestId');
		expect(await ep.handle({ body: req('legacy') })).toEqual(first);
		expect(posts).toBe(1);
		const clock = vi.spyOn(Date, 'now');
		clock.mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
		expect(await ep.handle({ body: req('legacy') })).toEqual(first);
		expect(posts).toBe(1);
	});

	it('after restart an eight-day-old ID is manual-only: no automatic HTTP resend', async () => {
		const age = 8 * 24 * 60 * 60 * 1000;
		const old = `r${(Date.now() - age).toString(36)}.${randomUUID()}`;
		let attempts = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).endsWith('/receipt-capability')) return ok('requestId-v1;retention-min=7d');
			attempts++;
			throw new Error('response lost');
		});
		const first = await endpoint(new HulaApiClient('http://test', 'secret')).handle({ body: req(old) });
		expect(first).toMatchObject({ status: 503, json: { code: 'DELIVERY_UNKNOWN', requestId: old } });
		expect(attempts).toBe(1); // explicit invocation only; never an automatic follow-up
	});

	it('expired durable unknown is never replayed, and a changed payload/room/actor cannot reuse local ID', async () => {
		const client = new HulaApiClient('http://test', 'secret');
		const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).endsWith('/receipt-capability')) return ok('requestId-v1;retention-min=7d');
			throw new Error('transport down');
		});
		const ep = endpoint(client);
		const pending = generatedId();
		const first = await ep.handle({ body: req(pending) });
		expect(first.status).toBe(503);
		expect(await ep.handle({ body: req(pending, 'different') })).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
		const calls = fetcher.mock.calls.length;
		const started = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(started + 7 * 24 * 60 * 60 * 1000);
		expect(await ep.handle({ body: req(pending) })).toEqual(first);
		expect(fetcher).toHaveBeenCalledTimes(calls);
	});
});

import type { AIEngine, StreamCallbacks } from './engine.js';

/**
 * openclaw Chat Completions API 集成（SSE 流式）
 * 需要在 openclaw 配置中开启：gateway.http.endpoints.chatCompletions.enabled = true
 * 认证：Bearer gateway.auth.token
 */
export class OpenclawEngine implements AIEngine {
	private _url: string;
	private _token: string;
	private _sessionId: string;

	constructor(url = 'http://localhost:18789/v1/chat/completions', token = '', sessionId = 'aichat-default') {
		this._url = url;
		this._token = token;
		this._sessionId = sessionId;
	}

	async chat(message: string, callbacks: StreamCallbacks): Promise<void> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this._token) {
			headers['Authorization'] = `Bearer ${this._token}`;
		}

		const body = JSON.stringify({
			model: 'openclaw',
			messages: [{ role: 'user', content: message }],
			stream: true,
		});

		let fullContent = '';

		try {
			const response = await fetch(this._url, {
				method: 'POST',
				headers,
				body,
			});

			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`openclaw API error: ${response.status} ${errText.substring(0, 100)}`);
			}

			if (!response.body) {
				throw new Error('openclaw API returned no body');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6).trim();
					if (data === '[DONE]') continue;

					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta?.content;
						if (delta) {
							fullContent += delta;
							callbacks.onChunk(delta);
						}
					} catch {
						// skip malformed SSE lines
					}
				}
			}

			callbacks.onDone(fullContent);
		} catch (err) {
			callbacks.onError(err instanceof Error ? err : new Error(String(err)));
		}
	}
}
